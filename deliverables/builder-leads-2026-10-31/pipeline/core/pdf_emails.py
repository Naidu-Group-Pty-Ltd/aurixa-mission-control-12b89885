# Read the company's own published PDFs (capability statement, company profile, brochure, prequalification pack)
# linked from its homepage or contact/about pages, and take the business email printed in them.
# usage: pdf_emails.py in.jsonl out.jsonl
import sys, re, json, io, threading, queue, time, importlib.util
_argv = sys.argv; sys.argv = ['x']
spec = importlib.util.spec_from_file_location('e2', '/tmp/leads/scripts/enrich_v2.py'); e2 = importlib.util.module_from_spec(spec); spec.loader.exec_module(e2)
sys.argv = _argv
import pypdf
from urllib.parse import urljoin, urlparse
INP, OUT = sys.argv[1], sys.argv[2]
PDFKW = re.compile(r'(capabilit|profile|brochure|prequal|company[-_ ]?info|statement|overview|credentials|portfolio|about)', re.I)
CF = re.compile(r'cdn-cgi/l/email-protection|data-cfemail|__cf_email__', re.I)
def pdf_text(url):
    try:
        r = e2.sess().get(url, timeout=15, stream=True)
        if r.status_code != 200 or 'pdf' not in r.headers.get('content-type', '').lower(): r.close(); return ''
        b = r.raw.read(10_000_000, decode_content=True); r.close()
        rd = pypdf.PdfReader(io.BytesIO(b))
        return ' '.join((p.extract_text() or '') for p in rd.pages[:12])
    except Exception: return ''
def work(rec):
    site = rec['site']
    if not e2.robots_ok(site): return dict(abn=rec['abn'], status='robots')
    url, body = e2.get(site)
    if not body: return dict(abn=rec['abn'], status='unreachable')
    if CF.search(body): return dict(abn=rec['abn'], status='cf-protected')
    sdom = e2.site_dom(url); pages = [(url, body)]
    for m in re.findall(r'href=["\']([^"\'#]+)["\']', body, re.I):
        u = urljoin(url, m)
        if e2.site_dom(u) == sdom and re.search('contact|about|capabilit|profile|prequal', urlparse(u).path, re.I) and not u.lower().endswith('.pdf') and len(pages) < 4:
            if e2.robots_ok(u):
                u2, b2 = e2.get(u)
                if b2 and not CF.search(b2): pages.append((u2, b2))
    pdfs = []
    for pu, pb in pages:
        for m in re.findall(r'href=["\']([^"\'#]+\.pdf)(?:\?[^"\']*)?["\']', pb, re.I):
            u = urljoin(pu, m)
            if PDFKW.search(u) and u not in pdfs and e2.site_dom(u) == sdom: pdfs.append(u)
    found = []
    for u in pdfs[:2]:
        if not e2.robots_ok(u): continue
        t = pdf_text(u)
        for e in e2.EMAIL_RE.findall(t):
            e = e.strip('.').lower()
            if not e2.mc_valid(e) or e2.JUNK.search(e) or e2.NOTSALES.match(e): continue
            dom = e.split('@')[1]
            kind = 'own-domain' if e2.same_org(dom, sdom) else 'mailbox provider' if dom in e2.FREEMAIL else None
            if kind and e not in [f['email'] for f in found]: found.append(dict(email=e, kind=kind, page=u))
    found.sort(key=lambda e: (e['kind'] != 'own-domain', not e2.ROLE.match(e['email']), len(e['email'])))
    return dict(abn=rec['abn'], website='https://' + sdom, pdfs=pdfs[:2], emails=found[:3], status='ok')
q = queue.Queue(); [q.put(json.loads(l)) for l in open(INP)]; total = q.qsize()
lock = threading.Lock(); fo = open(OUT, 'w'); cnt = [0, 0, 0]; t0 = time.time()
def run():
    while True:
        try: rec = q.get_nowait()
        except queue.Empty: return
        try: res = work(rec)
        except Exception as ex: res = dict(abn=rec['abn'], status='error ' + str(ex)[:60])
        with lock:
            fo.write(json.dumps(res) + '\n'); fo.flush(); cnt[0] += 1; cnt[1] += bool(res.get('pdfs')); cnt[2] += bool(res.get('emails'))
            if cnt[0] % 250 == 0: print(f'{cnt[0]}/{total} with-pdf {cnt[1]} emails {cnt[2]} {time.time()-t0:.0f}s', flush=True)
ths = [threading.Thread(target=run) for _ in range(60)]; [t.start() for t in ths]; [t.join() for t in ths]
print('DONE', cnt, flush=True)
