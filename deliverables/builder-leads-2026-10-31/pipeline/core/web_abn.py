# usage: web_abn.py in.csv out.csv   in.csv columns: rid, website.  Finds ABNs printed on a company's own site.
import sys, csv, re, requests, threading, queue, html as H, duckdb
from urllib.parse import urljoin, urlparse
UA = 'AurixaLeadVerifier/1.0 (business contact verification; one homepage + contact page per site)'
con = duckdb.connect('/tmp/leads/work/leads.duckdb', read_only=True)
ABNRE = re.compile(r'A\.?\s?B\.?\s?N\.?[:\s#]*((?:\d[\s ]?){11})', re.I)
def chk(a):
    w = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19]; d = [int(x) for x in a]; d[0] -= 1
    return sum(x * y for x, y in zip(d, w)) % 89 == 0
def get(s, u):
    try:
        r = s.get(u, timeout=10, stream=True)
        if r.status_code != 200 or 'html' not in r.headers.get('content-type', ''): return None, None
        b = r.raw.read(1_500_000, decode_content=True).decode(r.encoding or 'utf-8', 'replace'); return r.url, b
    except Exception: return None, None
rows = list(csv.DictReader(open(sys.argv[1])))
q = queue.Queue(); [q.put(r) for r in rows if r['website']]; res = {}; lock = threading.Lock()
def run():
    s = requests.Session(); s.headers['User-Agent'] = UA
    while True:
        try: r = q.get_nowait()
        except queue.Empty: return
        site = r['website'].strip()
        if not site.startswith('http'): site = 'https://' + site
        found = []
        url, b = get(s, site)
        pages = [b] if b else []
        if b:
            for l in [urljoin(url, m) for m in re.findall(r'href=["\']([^"\'#]*(?:contact|about|privacy|terms)[^"\'#]*)["\']', b, re.I)][:3]:
                if urlparse(l).netloc.replace('www.', '') == urlparse(url).netloc.replace('www.', ''):
                    _, b2 = get(s, l); pages.append(b2 or '')
        for p in pages:
            t = H.unescape(re.sub(r'<[^>]+>', ' ', p or ''))
            for m in ABNRE.findall(t):
                a = re.sub(r'\D', '', m)
                if len(a) == 11 and chk(a) and a not in found: found.append(a)
        with lock: res[r['rid']] = (url or '', found)
ths = [threading.Thread(target=run) for _ in range(16)]; [t.start() for t in ths]; [t.join() for t in ths]
w = csv.writer(open(sys.argv[2], 'w')); w.writerow(['rid', 'final_url', 'abns_on_site', 'active_abns'])
for rid, (u, f) in res.items():
    act = [a for a in f if (con.execute("select abn_status from abr where abn=?", [a]).fetchone() or [''])[0] == 'ACT']
    w.writerow([rid, u, ' '.join(f), ' '.join(act)])
