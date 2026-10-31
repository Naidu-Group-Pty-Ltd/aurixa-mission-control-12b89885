# Email discovery v2: find a lead's own website (or take the known one), crawl its contact/about/privacy/team pages,
# and collect the business email addresses the site publishes.
#   usage: enrich_v2.py in.jsonl out.jsonl [threads]
#   in.jsonl rows: {"abn", "mode": "site"|"discover", "site"?, "names": [...], "states": [...], "ind": bool}
# Rules: plain requests with an honest User-Agent, robots.txt respected for every page, no de-obfuscation of
# hidden/obfuscated addresses, one site at a time per worker. Emails kept only if on the site's own domain
# or a mainstream mailbox provider (gmail/bigpond/...) published on the business's own verified site.
import sys, re, json, threading, queue, time, html as H, itertools
import requests, urllib.robotparser
from urllib.parse import urljoin, urlparse, unquote
INP, OUT = (sys.argv[1], sys.argv[2]) if len(sys.argv) > 2 else ('', '')
NT = int(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3].isdigit() else 120
UA = 'AurixaLeadVerifier/1.0 (business contact verification; reads public contact pages only)'
SUF = re.compile(r'\b(PTY|PTY\.|PROPRIETARY|LTD|LTD\.|LIMITED|P/L|THE TRUSTEE FOR|TRUSTEE FOR|ATF|TRUST|FAMILY|UNIT|DISCRETIONARY|THE|CO|COMPANY)\b', re.I)
STW = {'QLD', 'VIC', 'NSW', 'WA', 'SA', 'TAS', 'ACT', 'NT', 'AUST', 'AUSTRALIA', 'AUS', 'AUSTRALASIA'}
GEN = {'CONSTRUCTIONS', 'CONSTRUCTION', 'BUILDING', 'BUILDERS', 'BUILDER', 'HOMES', 'HOME', 'GROUP', 'PROJECTS', 'PROJECT', 'SERVICES',
       'DEVELOPMENTS', 'DEVELOPMENT', 'PROPERTY', 'PROPERTIES', 'CONTRACTING', 'CONTRACTORS', 'ENTERPRISES', 'HOLDINGS', 'INVESTMENTS',
       'CONSTRUCT', 'BUILD', 'BUILT', 'SOLUTIONS', 'INDUSTRIES', 'AND', 'MANAGEMENT', 'COMMERCIAL', 'RESIDENTIAL', 'CUSTOM', 'QUALITY'}
SUFFIXES = ['builders', 'building', 'construction', 'constructions', 'homes', 'group', 'projects', 'build']
SW = {'QLD': ['qld', 'queensland', 'brisbane', 'gold coast', 'sunshine coast', 'townsville', 'cairns', 'toowoomba'],
      'VIC': ['vic', 'victoria', 'melbourne', 'geelong', 'ballarat', 'bendigo'],
      'NSW': ['nsw', 'new south wales', 'sydney', 'newcastle', 'wollongong', 'central coast'],
      'WA': ['wa', 'western australia', 'perth', 'mandurah', 'bunbury'], 'ACT': ['act', 'canberra', 'australian capital territory'],
      'NT': ['nt', 'northern territory', 'darwin', 'alice springs'], 'SA': ['sa', 'south australia', 'adelaide'],
      'TAS': ['tas', 'tasmania', 'hobart', 'launceston']}
PARKED = re.compile(r'domain (?:name )?(?:is |may be )?for sale|buy this domain|parked (?:free|domain)|this domain (?:has been|is) (?:registered|parked)|domain parking|sedoparking|afternic|hugedomains|future home of|website is expired|account suspended|default web site page|index of /', re.I)
FREEMAIL = {'gmail.com', 'googlemail.com', 'bigpond.com', 'bigpond.net.au', 'bigpond.com.au', 'outlook.com', 'outlook.com.au', 'hotmail.com', 'hotmail.com.au',
            'live.com', 'live.com.au', 'yahoo.com', 'yahoo.com.au', 'icloud.com', 'me.com', 'optusnet.com.au', 'iinet.net.au', 'westnet.com.au',
            'tpg.com.au', 'internode.on.net', 'aapt.net.au', 'dodo.com.au', 'ozemail.com.au', 'msn.com', 'protonmail.com', 'proton.me', 'adam.com.au', 'skymesh.com.au'}
JUNK = re.compile(r'(example\.|sentry|wixpress|wix\.com|\.png$|\.jpg$|\.jpeg$|\.gif$|\.svg$|\.webp$|domain\.com|email\.com$|yourname|youremail|your-?email|name@|user@|@2x|godaddy|squarespace|wordpress|cloudflare|jquery|noreply|no-reply|donotreply|do-not-reply|postmaster|abuse@|webmaster|hostmaster|privacy@|test@|@test\.|email-address|firstname|lastname|mysite|website\.com|@sample|placeholder|filler@)', re.I)
NOTSALES = re.compile(r'^(careers?|jobs?|recruit\w*|hr|humanresources|talent|employment|ap|ar|accountspayable|accounts\.payable|payables?|invoices?|billing|media|press|privacy|unsubscribe|complaints?|whistle\w*|graphic\w*)@', re.I)
ROLE = re.compile(r'^(info|enquir|inquir|admin|sales|office|reception|contact|hello|mail|accounts|estimat|tender|project|build|homes|construct|general|team|service|quotes|support|newhomes|design|bookings|hi|management|operations)', re.I)
EMAIL_RE = re.compile(r'[A-Za-z0-9._%+\-]+@[A-Za-z0-9](?:[A-Za-z0-9.\-]{0,251}[A-Za-z0-9])?\.[A-Za-z]{2,24}')
PHONE = re.compile(r'(?<!\d)(?:\+?61[\s\-\.]?\(?0?\)?[2378][\s\-\.]?\d{4}[\s\-\.]?\d{4}|\(?0[2378]\)?[\s\-\.]?\d{4}[\s\-\.]?\d{4}|\+?61[\s\-\.]?4\d{2}[\s\-\.]?\d{3}[\s\-\.]?\d{3}|04\d{2}[\s\-\.]?\d{3}[\s\-\.]?\d{3}|1[38]00[\s\-\.]?\d{3}[\s\-\.]?\d{3})(?!\d)')
PAGE_HINT = re.compile(r'(contact|enquir|get-in-touch|getintouch|reach-us|about|team|our-people|people|privacy|terms|location|office)', re.I)
LOCAL_ATOM = re.compile(r"^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+$")
DNS_LABEL = re.compile(r'^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$')
def mc_valid(a):  # Python port of Mission Control's isValidAddress (src/lib/email/emailAddress.pure.ts)
    if not a or len(a) > 254 or re.search(r'[\s,;<>()\[\]\\"]', a): return False
    at = a.rfind('@')
    if at <= 0 or at == len(a) - 1: return False
    loc, dom = a[:at], a[at + 1:]
    if len(loc) > 64 or loc.startswith('.') or loc.endswith('.') or '..' in loc: return False
    if not all(LOCAL_ATOM.match(x) for x in loc.split('.')): return False
    labels = dom.split('.')
    if len(dom) > 253 or len(labels) < 2 or not all(DNS_LABEL.match(l) for l in labels): return False
    return bool(re.match(r'^[A-Za-z]{2,63}$', labels[-1]))
TL = threading.local(); DNSC = {}; DNSL = threading.Lock(); ROBC = {}
import os
if os.environ.get('DNS_CACHE') and os.path.exists(os.environ['DNS_CACHE']):
    for _l in open(os.environ['DNS_CACHE']):
        _d, _v = _l.rstrip('\n').split('\t'); DNSC[_d] = _v
DOH = itertools.cycle(['https://dns.google/resolve', 'https://cloudflare-dns.com/dns-query'])
def sess():
    if not hasattr(TL, 's'):
        s = requests.Session(); s.headers['User-Agent'] = UA; s.max_redirects = 5; TL.s = s
        d = requests.Session(); d.headers['accept'] = 'application/dns-json'; TL.d = d
    return TL.s
def dns_state(host):
    # 'A' = has address, 'Z' = zone exists but no address, 'N' = NXDOMAIN / unresolvable
    sess()
    for _ in range(3):
        try:
            j = TL.d.get(next(DOH), params={'name': host, 'type': 'A'}, timeout=8).json()
            if j.get('Status') == 3: return 'N'
            if j.get('Status') == 0: return 'A' if any(a.get('type') in (1, 5) for a in j.get('Answer', [])) else 'Z'
        except Exception: time.sleep(0.5)
    return 'N'
def resolves(host):
    with DNSL: v = DNSC.get(host)
    if v is None:
        v = dns_state(host)
        with DNSL: DNSC[host] = v
    return v == 'A'
def domain_live(d):
    with DNSL: v = DNSC.get(d)
    if v is None: v = dns_state(d); DNSC[d] = v
    if v == 'A': return True
    if v == 'Z': return resolves('www.' + d)
    return False
def get(url, timeout=9):
    try:
        r = sess().get(url, timeout=timeout, stream=True, allow_redirects=True)
        if r.status_code != 200 or 'html' not in r.headers.get('content-type', ''): r.close(); return None, None
        b = r.raw.read(1_500_000, decode_content=True).decode(r.encoding or 'utf-8', 'replace'); r.close()
        return r.url, b
    except Exception: return None, None
def robots_ok(url):
    p = urlparse(url); base = f'{p.scheme}://{p.netloc}'
    rp = ROBC.get(base)
    if rp is None:
        rp = urllib.robotparser.RobotFileParser()
        try:
            r = sess().get(base + '/robots.txt', timeout=7)
            rp.parse(r.text.splitlines() if r.status_code == 200 and 'html' not in r.headers.get('content-type', '') else [])
        except Exception: rp.parse([])
        ROBC[base] = rp
    try: return rp.can_fetch(UA, url)
    except Exception: return True
def text_of(h):
    h = re.sub(r'(?is)<(script|style|noscript|svg).*?</\1>', ' ', h)
    return re.sub(r'\s+', ' ', H.unescape(re.sub(r'<[^>]+>', ' ', h)))
def site_dom(url): return urlparse(url).netloc.lower().split(':')[0].removeprefix('www.')
def same_org(edom, sdom):
    return edom == sdom or edom.endswith('.' + sdom) or sdom.endswith('.' + edom) or edom.split('.')[0] == sdom.split('.')[0]
def emails_in(h, sdom, page):
    found = []
    raw = [unquote(m) for m in re.findall(r'mailto:([^"\'?>\s]+)', h, re.I)]
    raw += EMAIL_RE.findall(text_of(h))
    for e in raw:
        e = e.strip().strip('.').lower()
        if not mc_valid(e) or JUNK.search(e) or NOTSALES.match(e): continue
        dom = e.split('@')[1]
        if same_org(dom, sdom): kind = 'own-domain'
        elif dom in FREEMAIL: kind = 'mailbox provider'
        else: continue
        if e not in [f['email'] for f in found]: found.append(dict(email=e, kind=kind, page=page))
    return found
def phones_in(h):
    out = []
    for p in [re.sub(r'[^\d+]', '', t) for t in re.findall(r'href=["\']tel:([^"\']+)', h)] + [re.sub(r'[^\d+]', '', p) for p in PHONE.findall(text_of(h))]:
        p = p.replace('+61', '0').lstrip('+')
        if p.startswith('610'): p = p[2:]
        if len(p) == 10 and (p[0] == '0' or p[:4] in ('1300', '1800')) and p not in out: out.append(p)
    return out[:3]
def stems(names, legal):
    out = []
    for i, n in enumerate(names):
        base = SUF.sub(' ', H.unescape(n).upper()); base = re.sub(r'\(.*?\)', ' ', base).replace('&', ' AND ').replace('+', ' AND ')
        words = [w for w in re.findall(r'[A-Z0-9]+', base)]
        w2 = [w for w in words if w not in STW]
        core = [w for w in w2 if w not in GEN]
        cands = []
        for ws in (words, w2):
            if ws: cands += [(''.join(ws).lower(), 'name'), ('-'.join(ws).lower(), 'name')]
            if 'AND' in ws: cands.append((''.join(x for x in ws if x != 'AND').lower(), 'name'))
        if core and core != w2: cands.append((''.join(core).lower(), 'core'))
        if i == 0 and legal and core and len(''.join(core)) >= 4:
            cands += [(''.join(core).lower() + s, 'suffix') for s in SUFFIXES]
        for c, k in cands:
            if len(c) >= 5 and c not in [o[0] for o in out]: out.append((c, k))
    return out[:22]
def verify(body, rec, abn, kind):
    t = text_of(body).lower()
    if PARKED.search(t[:6000]) and abn not in re.sub(r'\D', '', t): return None
    abn_sp = f'{abn[:2]} {abn[2:5]} {abn[5:8]} {abn[8:]}'
    abn_on = abn in re.sub(r'[\s\-\. ]', '', t) or abn_sp in t
    if abn_on: return 'Verified: ABN shown on website'
    st_on = any(re.search(r'\b' + re.escape(w) + r'\b', t) for s in rec['states'] for w in SW.get(s, [s.lower()]))
    if not st_on: return None
    names = [re.sub(r'\s+', ' ', SUF.sub(' ', re.sub(r'\(.*?\)', ' ', n)).lower()).strip() for n in rec['names'] if n]
    name_on = any(len(n) > 4 and n in t for n in names)
    if name_on: return 'Name + state match on website'
    if kind in ('suffix', 'core') or rec.get('ind'): return None
    kw = [w for w in re.findall(r'[a-z]{3,}', names[0]) if w.upper() not in GEN and w.upper() not in STW]
    if kw and all(k in t for k in kw[:2]) and len(kw) >= 1: return 'Keyword + state match on website'
    return None
def crawl(url, body, abn, rec):
    sdom = site_dom(url); emails = emails_in(body, sdom, url); phones = phones_in(body); pages = 1; abn_seen = False
    links = []
    for m in re.findall(r'href=["\']([^"\'#]+)["\']', body, re.I):
        u = urljoin(url, m)
        if site_dom(u) == sdom and PAGE_HINT.search(urlparse(u).path) and u not in links and not re.search(r'\.(pdf|jpg|png|docx?)$', u, re.I): links.append(u)
    links.sort(key=lambda u: (0 if re.search('contact|enquir|get-in-touch', u, re.I) else 1 if re.search('about|team|people', u, re.I) else 2))
    if not links: links = [urljoin(url, '/contact-us/'), urljoin(url, '/contact/')]
    for u in links[:5]:
        if len([e for e in emails if e['kind'] == 'own-domain']) >= 2: break
        if not robots_ok(u): continue
        u2, b2 = get(u); pages += 1
        if not b2: continue
        for e in emails_in(b2, sdom, u2):
            if e['email'] not in [x['email'] for x in emails]: emails.append(e)
        if not phones: phones = phones_in(b2)
        if abn in re.sub(r'[\s\-\. ]', '', text_of(b2)): abn_seen = True
    emails.sort(key=lambda e: (e['kind'] != 'own-domain', not ROLE.match(e['email']), len(e['email'])))
    # a mailbox-provider address is only taken when the site shows no own-domain address
    if any(e['kind'] == 'own-domain' for e in emails): emails = [e for e in emails if e['kind'] == 'own-domain']
    return emails[:3], phones, pages, abn_seen
def work(rec):
    abn = rec['abn']
    if rec['mode'] == 'site':
        site = rec['site'] if rec['site'].startswith('http') else 'https://' + rec['site']
        if not robots_ok(site): return dict(abn=abn, website=rec['site'], status='robots disallow')
        url, body = get(site)
        if not body: return dict(abn=abn, website=rec['site'], status='site unreachable')
        em, ph, pg, abn_seen = crawl(url, body, abn, rec)
        return dict(abn=abn, website='https://' + urlparse(url).netloc.split(':')[0], web_conf=rec.get('web_conf') or '', emails=em, phones=ph, pages=pg, abn_on_contact=abn_seen, status='ok')
    tried = 0
    for st, kind in stems(rec['names'], not rec.get('ind')):
        tlds = ('.com.au', '.au', '.com') if kind == 'name' else ('.com.au',)
        for tld in tlds:
            d = st + tld; tried += 1
            if not domain_live(d): continue
            for host in ('www.' + d, d):
                if not robots_ok('https://' + host + '/'): continue
                url, body = get('https://' + host + '/')
                if body: break
            if not body: continue
            conf = verify(body, rec, abn, kind)
            if not conf: continue
            if tld == '.com' and not conf.startswith('Verified') and not conf.startswith('Name'): continue
            em, ph, pg, abn_seen = crawl(url, body, abn, rec)
            if abn_seen and not conf.startswith('Verified'): conf = 'Verified: ABN shown on website'
            return dict(abn=abn, website='https://' + urlparse(url).netloc.split(':')[0], web_conf=conf, emails=em, phones=ph, pages=pg, status='ok', tried=tried)
    return dict(abn=abn, website=None, status='no site found', tried=tried)
def main():
    done = set()
    try:
        for l in open(OUT): done.add(json.loads(l)['abn'])
    except FileNotFoundError: pass
    q = queue.Queue()
    for l in open(INP):
        r = json.loads(l)
        if r['abn'] not in done: q.put(r)
    total = q.qsize(); cnt = [0, 0, 0]; t0 = time.time(); lock = threading.Lock(); fo = open(OUT, 'a')
    def runner():
        while True:
            try: rec = q.get_nowait()
            except queue.Empty: return
            try: res = work(rec)
            except Exception as e: res = dict(abn=rec['abn'], website=None, status='error ' + str(e)[:80])
            with lock:
                fo.write(json.dumps(res) + '\n'); fo.flush(); cnt[0] += 1; cnt[1] += bool(res.get('website')); cnt[2] += bool(res.get('emails'))
                if cnt[0] % 500 == 0: print(f'{cnt[0]}/{total} sites {cnt[1]} with-email {cnt[2]} {time.time()-t0:.0f}s', flush=True)
    ths = [threading.Thread(target=runner, daemon=True) for _ in range(NT)]
    [t.start() for t in ths]; [t.join() for t in ths]
    print('DONE', cnt, flush=True)
if __name__ == '__main__':
    main()
