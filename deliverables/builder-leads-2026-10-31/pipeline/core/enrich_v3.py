# Email discovery v3 (static stage). Builds on enrich_v2:
#  * more contact-page discovery: wider link hints + sitemap.xml
#  * schema.org JSON-LD "email" fields (structured data the site publishes for search engines)
#  * pages protected by Cloudflare email obfuscation are skipped entirely (the owner has opted out of harvesting)
#  * pages that look JavaScript-rendered are queued for the browser stage (render_v3.py)
#  * discovery mode adds .net.au, state-suffixed names, all business names and (sole traders) ABN-verified personal-name domains
# usage: enrich_v3.py in.jsonl out.jsonl render_queue.jsonl [threads]
import sys, re, json, threading, queue, time, os, html as H
import importlib.util
_argv = sys.argv; sys.argv = ['x']
spec = importlib.util.spec_from_file_location('e2', '/tmp/leads/scripts/enrich_v2.py'); e2 = importlib.util.module_from_spec(spec); spec.loader.exec_module(e2)
sys.argv = _argv
from urllib.parse import urljoin, urlparse
INP, OUT, RQ = sys.argv[1], sys.argv[2], sys.argv[3]
NT = int(sys.argv[4]) if len(sys.argv) > 4 else 120
CF = re.compile(r'cdn-cgi/l/email-protection|data-cfemail|__cf_email__', re.I)
JSLD = re.compile(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', re.I | re.S)
JSAPP = re.compile(r'wixstatic|static\.wixstatic|squarespace|__NEXT_DATA__|id="root"></div>|id="app"></div>|ng-version|data-reactroot|webflow|framerusercontent|elementor-widget-form|duda', re.I)
HINT3 = re.compile(r'(contact|enquir|get-?in-?touch|reach|connect|talk|quote|book|visit|find-?us|locat|display|showroom|studio|office|about|team|people|our-story|who-we-are|privacy|terms|legal|support|help)', re.I)
STATE_SUFFIX = {'QLD': ['qld'], 'VIC': ['vic', 'melbourne'], 'NSW': ['nsw', 'sydney'], 'WA': ['wa', 'perth'], 'SA': ['sa', 'adelaide'], 'ACT': ['act', 'canberra'], 'NT': ['nt', 'darwin'], 'TAS': ['tas', 'hobart']}
PERSONAL_SUFFIX = ['building', 'builders', 'builder', 'construction', 'constructions', 'homes', 'carpentry', 'renovations', 'build', 'projects']
def jsonld_emails(h):
    out = []
    for blk in JSLD.findall(h):
        for m in re.findall(r'"email"\s*:\s*"([^"]+)"', blk, re.I):
            out.append(m.replace('mailto:', '').strip())
    return out
def page_emails(h, sdom, url):
    if CF.search(h): return None  # protected page: take nothing from it
    found = e2.emails_in(h, sdom, url)
    for e in jsonld_emails(h):
        e = e.lower()
        if not e2.mc_valid(e) or e2.JUNK.search(e) or e2.NOTSALES.match(e): continue
        dom = e.split('@')[1]
        kind = 'own-domain' if e2.same_org(dom, sdom) else 'mailbox provider' if dom in e2.FREEMAIL else None
        if kind and e not in [f['email'] for f in found]: found.append(dict(email=e, kind=kind, page=url, how='schema.org structured data'))
    return found
def thin(h):
    return len(e2.text_of(h)) < 900 or bool(JSAPP.search(h))
def sitemap_links(base, sdom):
    links = []
    for path in ('/sitemap.xml', '/sitemap_index.xml', '/page-sitemap.xml'):
        u = urljoin(base, path)
        if not e2.robots_ok(u): continue
        try:
            r = e2.sess().get(u, timeout=8)
            if r.status_code != 200 or '<loc>' not in r.text: continue
            locs = re.findall(r'<loc>\s*([^<\s]+)\s*</loc>', r.text)
            subs = [l for l in locs if l.endswith('.xml')]
            pages = [l for l in locs if not l.endswith('.xml')]
            if subs and not pages:
                for s_ in [x for x in subs if 'page' in x][:1] or subs[:1]:
                    r2 = e2.sess().get(s_, timeout=8)
                    if r2.status_code == 200: pages += re.findall(r'<loc>\s*([^<\s]+)\s*</loc>', r2.text)
            links += [p for p in pages if e2.site_dom(p) == sdom and HINT3.search(urlparse(p).path)]
            if links: break
        except Exception: pass
    return links
def crawl3(url, body, abn):
    sdom = e2.site_dom(url); emails = []; render = []; pages = 1; cf_pages = 0; abn_seen = False
    r0 = page_emails(body, sdom, url)
    if r0 is None: cf_pages += 1
    else:
        emails += r0
        if not r0 and thin(body): render.append(url)
    links = []
    for m in re.findall(r'href=["\']([^"\'#]+)["\']', body, re.I):
        u = urljoin(url, m)
        if e2.site_dom(u) == sdom and HINT3.search(urlparse(u).path) and u not in links and not re.search(r'\.(pdf|jpe?g|png|docx?|zip)$', u, re.I): links.append(u)
    for u in sitemap_links(url, sdom):
        if u not in links: links.append(u)
    links.sort(key=lambda u: (0 if re.search('contact|enquir|get-?in-?touch|connect|talk|reach', u, re.I) else 1 if re.search('about|team|people|story|who', u, re.I) else 2))
    if not links: links = [urljoin(url, p) for p in ('/contact-us/', '/contact/', '/about-us/', '/about/')]
    for u in links[:8]:
        if len([e for e in emails if e['kind'] == 'own-domain']) >= 2: break
        if not e2.robots_ok(u): continue
        u2, b2 = e2.get(u); pages += 1
        if not b2: continue
        if abn in re.sub(r'[\s\-\. ]', '', e2.text_of(b2)): abn_seen = True
        r_ = page_emails(b2, sdom, u2)
        if r_ is None: cf_pages += 1; continue
        for e in r_:
            if e['email'] not in [x['email'] for x in emails]: emails.append(e)
        if not r_ and thin(b2) and re.search('contact|enquir|touch|connect|talk|reach|about', u2, re.I): render.append(u2)
    emails.sort(key=lambda e: (e['kind'] != 'own-domain', not e2.ROLE.match(e['email']), len(e['email'])))
    if any(e['kind'] == 'own-domain' for e in emails): emails = [e for e in emails if e['kind'] == 'own-domain']
    return emails[:3], pages, cf_pages, abn_seen, ([] if emails or cf_pages else render[:3])
def stems3(rec):
    names = rec['names']; out = []
    have = {s for s, _ in e2.stems(names, not rec.get('ind'))}  # v2 already tried these
    for i, n in enumerate(names):
        base = e2.SUF.sub(' ', H.unescape(n).upper()); base = re.sub(r'\(.*?\)', ' ', base).replace('&', ' AND ').replace('+', ' AND ')
        words = re.findall(r'[A-Z0-9]+', base); w2 = [w for w in words if w not in e2.STW]; core = [w for w in w2 if w not in e2.GEN]
        c = []
        if w2: c += [(''.join(w2).lower(), 'name')]
        if 'AND' in w2: c += [(''.join('n' if x == 'AND' else x for x in w2).lower(), 'name')]
        if core:
            c += [('-'.join(core).lower(), 'core')]
            for st in rec['states']:
                for sfx in STATE_SUFFIX.get(st, []):
                    c += [(''.join(w2).lower() + sfx, 'name')]
        for x, k in c:
            if len(x) >= 5 and x not in [o[0] for o in out]: out.append((x, k))
    if rec.get('ind') and rec.get('person'):
        p = [w.lower() for w in re.findall(r'[A-Za-z]+', rec['person'])]
        if len(p) >= 2:
            first, last = p[0], p[-1]
            for sfx in PERSONAL_SUFFIX:
                for x in (first + last + sfx, last + sfx, first + last):
                    if len(x) >= 6 and x not in [o[0] for o in out]: out.append((x, 'personal'))
    return out[:40], have
def candidate_domains(rec):
    st, have = stems3(rec); doms = []
    for s, kind in st:
        tlds = ('.net.au', '.com.au', '.au') if s not in have else ('.net.au',)
        if kind in ('core', 'personal'): tlds = ('.com.au',) + (('.net.au',) if kind == 'core' else ())
        for t in tlds: doms.append((s + t, kind))
    return doms
def work(rec):
    abn = rec['abn']
    if rec['mode'] == 'site':
        site = rec['site'] if rec['site'].startswith('http') else 'https://' + rec['site']
        if not e2.robots_ok(site): return dict(abn=abn, website=rec['site'], status='robots disallow')
        url, body = e2.get(site)
        if not body: return dict(abn=abn, website=rec['site'], status='site unreachable')
        em, pg, cfp, abn_seen, rq = crawl3(url, body, abn)
        return dict(abn=abn, website='https://' + urlparse(url).netloc.split(':')[0], web_conf=rec.get('web_conf') or '', emails=em, pages=pg, cf_pages=cfp, render=rq, status='ok')
    for d, kind in candidate_domains(rec):
        if not e2.domain_live(d): continue
        body = None
        for host in ('www.' + d, d):
            if not e2.robots_ok('https://' + host + '/'): continue
            url, body = e2.get('https://' + host + '/')
            if body: break
        if not body: continue
        conf = e2.verify(body, rec, abn, 'suffix' if kind in ('core', 'personal') else kind)
        if kind == 'personal' and (not conf or not conf.startswith('Verified')): continue
        if not conf: continue
        em, pg, cfp, abn_seen, rq = crawl3(url, body, abn)
        if abn_seen and not conf.startswith('Verified'): conf = 'Verified: ABN shown on website'
        return dict(abn=abn, website='https://' + urlparse(url).netloc.split(':')[0], web_conf=conf, emails=em, pages=pg, cf_pages=cfp, render=rq, status='ok')
    return dict(abn=abn, website=None, status='no site found')
if __name__ == '__main__':
    done = set()
    try:
        for l in open(OUT): done.add(json.loads(l)['abn'])
    except FileNotFoundError: pass
    q = queue.Queue()
    for l in open(INP):
        r = json.loads(l)
        if r['abn'] not in done: q.put(r)
    total = q.qsize(); cnt = [0, 0, 0, 0]; t0 = time.time(); lock = threading.Lock(); fo = open(OUT, 'a'); fr = open(RQ, 'a')
    def runner():
        while True:
            try: rec = q.get_nowait()
            except queue.Empty: return
            try: res = work(rec)
            except Exception as ex: res = dict(abn=rec['abn'], website=None, status='error ' + str(ex)[:80])
            with lock:
                fo.write(json.dumps(res) + '\n'); fo.flush()
                for u in res.get('render') or []: fr.write(json.dumps(dict(abn=res['abn'], url=u, website=res.get('website'), web_conf=res.get('web_conf', ''))) + '\n')
                fr.flush(); cnt[0] += 1; cnt[1] += bool(res.get('website')); cnt[2] += bool(res.get('emails')); cnt[3] += bool(res.get('cf_pages'))
                if cnt[0] % 500 == 0: print(f'{cnt[0]}/{total} sites {cnt[1]} emails {cnt[2]} cf-protected {cnt[3]} {time.time()-t0:.0f}s', flush=True)
    ths = [threading.Thread(target=runner, daemon=True) for _ in range(NT)]
    [t.start() for t in ths]; [t.join() for t in ths]
    print('DONE', cnt, flush=True)
