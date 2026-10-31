# Discover a company's own website from its legal/trading names, verify it (ABN or name on page),
# and pull the business phone/email the site publishes. Reads candidates TSV, writes results JSONL.
import sys, re, json, socket, threading, queue, time, html as htmlmod
import requests, urllib.robotparser
from urllib.parse import urljoin, urlparse
requests.packages.urllib3.disable_warnings = None
INP, OUT = sys.argv[1], sys.argv[2]
NTHREADS = int(sys.argv[3]) if len(sys.argv) > 3 else 40
UA = 'AurixaLeadVerifier/1.0 (business contact verification; one homepage + contact page per site)'
SUFFIX = re.compile(r'\b(PTY|PTY\.|PROPRIETARY|LTD|LTD\.|LIMITED|P/L|CO|THE TRUSTEE FOR|TRUSTEE FOR|ATF|TRUST|FAMILY|UNIT|DISCRETIONARY|THE)\b', re.I)
STATE = re.compile(r'\b(QLD|VIC|NSW|AUST|AUSTRALIA|AUS)\b', re.I)
PARKED = re.compile(r'domain (?:name )?(?:is |may be )?for sale|buy this domain|parked (?:free|domain)|this domain (?:has been|is) (?:registered|parked)|domain parking|sedoparking|afternic|dan\.com|hugedomains|future home of|coming soon|under construction|website is expired|account suspended', re.I)
EMAIL = re.compile(r'[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}')
PHONE = re.compile(r'(?<!\d)(?:\+?61[\s\-\.]?\(?0?\)?[2378][\s\-\.]?\d{4}[\s\-\.]?\d{4}|\(?0[2378]\)?[\s\-\.]?\d{4}[\s\-\.]?\d{4}|\+?61[\s\-\.]?4\d{2}[\s\-\.]?\d{3}[\s\-\.]?\d{3}|04\d{2}[\s\-\.]?\d{3}[\s\-\.]?\d{3}|1[38]00[\s\-\.]?\d{3}[\s\-\.]?\d{3}|13[\s\-\.]?\d{2}[\s\-\.]?\d{2})(?!\d)')
BAD_EMAIL = re.compile(r'(@www\.|\+|email-address|noreply|no-reply|privacy@|example\.|sentry|wixpress|\.png|\.jpg|\.gif|\.svg|\.webp|domain\.com|email\.com|yourname|@2x|godaddy|squarespace|wordpress|cloudflare|jquery)', re.I)
def stems(names):
    out = []
    for n in names:
        if not n: continue
        n = htmlmod.unescape(n)
        base = SUFFIX.sub(' ', n.upper()); base = re.sub(r'\(.*?\)', ' ', base)
        words = re.findall(r'[A-Z0-9]+', base.replace('&', ' AND '))
        if not words: continue
        w2 = [w for w in words if not STATE.fullmatch(w)]
        for ws in (words, w2):
            if ws:
                out.append(''.join(ws).lower())
                out.append('-'.join(ws).lower())
                if 'AND' in ws: out.append(''.join(x for x in ws if x != 'AND').lower())
    seen = []; [seen.append(s) for s in out if s and len(s) >= 5 and s not in seen]
    return seen[:5]
D = threading.local()
def resolves(host):
    if not hasattr(D, 's'): D.s = requests.Session()
    for _ in range(3):
        try:
            j = D.s.get('https://dns.google/resolve', params={'name': host, 'type': 'A'}, timeout=8).json()
            return j.get('Status') == 0 and any(a.get('type') in (1, 5) for a in j.get('Answer', []))
        except Exception: time.sleep(1)
    return False
S = threading.local()
def sess():
    if not hasattr(S, 's'):
        s = requests.Session(); s.headers['User-Agent'] = UA; s.max_redirects = 5; S.s = s
    return S.s
def get(url, timeout=8):
    try:
        r = sess().get(url, timeout=timeout, stream=True, allow_redirects=True)
        ct = r.headers.get('content-type', '')
        if r.status_code != 200 or 'html' not in ct: r.close(); return None, None
        body = r.raw.read(1_500_000, decode_content=True).decode(r.encoding or 'utf-8', 'replace'); r.close()
        return r.url, body
    except Exception: return None, None
def robots_ok(base, path):
    try:
        r = sess().get(urljoin(base, '/robots.txt'), timeout=8)
        if r.status_code != 200: return True
        rp = urllib.robotparser.RobotFileParser(); rp.parse(r.text.splitlines())
        return rp.can_fetch(UA, urljoin(base, path))
    except Exception: return True
def text_of(h):
    h = re.sub(r'(?is)<(script|style|noscript).*?</\1>', ' ', h)
    return re.sub(r'\s+', ' ', htmlmod.unescape(re.sub(r'<[^>]+>', ' ', h)))
def contacts(h, domain):
    emails = set(m.lower().strip('.') for m in EMAIL.findall(htmlmod.unescape(re.sub(r'%40', '@', h))))
    emails |= {m.lower() for m in re.findall(r'mailto:([^"\'?>\s]+)', h)}
    emails = {e for e in emails if not BAD_EMAIL.search(e) and len(e) < 60}
    tels = [re.sub(r'[^\d+]', '', t) for t in re.findall(r'href=["\']tel:([^"\']+)', h)]
    t = text_of(h)
    tels += [re.sub(r'[^\d+]', '', p) for p in PHONE.findall(t)]
    phones = []
    for p in tels:
        p = p.replace('+61', '0').lstrip('+')
        if p.startswith('610'): p = p[2:]
        elif p.startswith('61') and len(p) == 11: p = '0' + p[2:]
        if (len(p) == 10 and p[0] == '0' and p[1] in '23478') or (len(p) == 10 and p[:4] in ('1300', '1800')) or (len(p) == 6 and p[:2] == '13'):
            if p not in phones: phones.append(p)
    dom = domain.replace('www.', '').split(':')[0]
    ROLE = re.compile(r'^(info|enquir|admin|sales|office|reception|contact|hello|mail|accounts|estimat|tender|project|build|homes|construct|general|team|service|quotes|support|newhomes|design)', re.I)
    em = sorted(emails, key=lambda e: (not (e.split('@')[1] == dom or e.split('@')[1].endswith('.' + dom)), not ROLE.match(e), len(e)))
    em = [e for e in em if e.split('@')[1] == dom or e.split('@')[1].endswith('.' + dom) or dom.endswith('.' + e.split('@')[1]) or dom.split('.')[0] == e.split('@')[1].split('.')[0]]
    return em[:3], phones[:3]
def fmt_phone(p):
    if p[:2] == '04': return f'{p[:4]} {p[4:7]} {p[7:]}'
    if p[:4] in ('1300', '1800'): return f'{p[:4]} {p[4:7]} {p[7:]}'
    if len(p) == 6: return f'{p[:2]} {p[2:4]} {p[4:]}'
    return f'{p[:2]} {p[2:6]} {p[6:]}'
def work(rec):
    abn = rec['abn']; abn_sp = f'{abn[:2]} {abn[2:5]} {abn[5:8]} {abn[8:]}'
    names = [n for n in rec['names'] if n]
    keyw = [w.lower() for w in re.findall(r'[A-Za-z]{3,}', SUFFIX.sub(' ', STATE.sub(' ', names[0]))) if w.lower() not in ('and', 'the', 'group', 'building', 'builders', 'construction', 'constructions', 'homes', 'projects', 'services', 'developments')]
    tried = []
    for st in stems(names):
        for tld in ('.com.au', '.au', '.com'):
            d = st + tld
            for host in ('www.' + d, d):
                if host in tried: continue
                tried.append(host)
                if not resolves(host): continue
                url, body = get('https://' + host + '/')
                if not body: continue
                low = body.lower(); t = text_of(body).lower()
                if PARKED.search(t[:5000]) and abn not in re.sub(r'\D', '', t): break
                abn_on = (abn in re.sub(r'[\s\-\.]', '', t)) or (abn_sp in t)
                fullname = re.sub(r'\s+', ' ', SUFFIX.sub(' ', names[0]).lower()).strip()
                name_on = any(re.sub(r'\s+', ' ', SUFFIX.sub(' ', n).lower()).strip() in t for n in names if len(n) > 4)
                kw_on = bool(keyw) and all(k in t for k in keyw[:2])
                if tld == '.com' and not (abn_on or name_on): break
                if not (abn_on or name_on or kw_on): break
                st_on = any(re.search(r'\b' + re.escape(x) + r'\b', t) for x in rec['statewords'])
                if not abn_on and not st_on: break
                conf = 'Verified: ABN shown on website' if abn_on else ('Name + state match on website' if name_on else 'Keyword + state match on website')
                em, ph = contacts(body, urlparse(url).netloc)
                if (not em or not ph):
                    links = [urljoin(url, m) for m in re.findall(r'href=["\']([^"\'#]*contact[^"\'#]*)["\']', body, re.I)][:2]
                    for cu in links or [urljoin(url, '/contact-us/')]:
                        if urlparse(cu).netloc.replace('www.', '') != urlparse(url).netloc.replace('www.', ''): continue
                        if not robots_ok(url, urlparse(cu).path): continue
                        u2, b2 = get(cu)
                        if b2:
                            e2, p2 = contacts(b2, urlparse(url).netloc)
                            em = em or e2; ph = ph or p2
                            if not abn_on and (abn in re.sub(r'[\s\-\.]', '', text_of(b2).lower())): conf = 'Verified: ABN shown on website'
                            break
                return dict(abn=abn, website='https://' + urlparse(url).netloc.split(':')[0], web_conf=conf, emails=em, phones=[fmt_phone(p) for p in ph])
    return dict(abn=abn, website=None)
q = queue.Queue(); lock = threading.Lock()
done = set()
try:
    for l in open(OUT): done.add(json.loads(l)['abn'])
except FileNotFoundError: pass
for line in open(INP):
    abn, *names = line.rstrip('\n').split('\t')
    st = names.pop(0) if names and names[0].startswith('ST=') else 'ST='
    sw = {'QLD': ['qld', 'queensland', 'brisbane', 'gold coast', 'sunshine coast'], 'VIC': ['vic', 'victoria', 'melbourne', 'geelong'],
          'NSW': ['nsw', 'new south wales', 'sydney', 'newcastle', 'wollongong', 'central coast'], 'WA': ['wa', 'western australia', 'perth', 'mandurah', 'bunbury'],
          'ACT': ['act', 'canberra', 'australian capital territory'], 'NT': ['nt', 'northern territory', 'darwin', 'alice springs'],
          'SA': ['sa', 'south australia', 'adelaide'], 'TAS': ['tas', 'tasmania', 'hobart', 'launceston']}
    words = []
    for x in st[3:].split(','):
        words += sw.get(x.strip(), [x.strip().lower()]) if x.strip() else []
    if abn not in done: q.put(dict(abn=abn, names=names, statewords=words or ['australia']))
total = q.qsize(); cnt = [0, 0]; t0 = time.time()
fo = open(OUT, 'a')
def runner():
    while True:
        try: rec = q.get_nowait()
        except queue.Empty: return
        try: res = work(rec)
        except Exception as e: res = dict(abn=rec['abn'], website=None, err=str(e)[:100])
        with lock:
            fo.write(json.dumps(res) + '\n'); fo.flush(); cnt[0] += 1; cnt[1] += bool(res.get('website'))
            if cnt[0] % 250 == 0: print(f'{cnt[0]}/{total} found {cnt[1]} {time.time()-t0:.0f}s', flush=True)
ths = [threading.Thread(target=runner, daemon=True) for _ in range(NTHREADS)]
[t.start() for t in ths]; [t.join() for t in ths]
print('DONE', cnt, flush=True)
