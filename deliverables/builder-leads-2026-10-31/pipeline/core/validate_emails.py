# Gather every email candidate per lead, validate it, pick one primary address per lead.
# Checks: Mission Control's own address grammar; junk/placeholder and non-sales mailboxes; the domain's live MX
# (or A-record fallback) via DNS-over-HTTPS; provenance (where the address was published).
import json, re, sys, threading, queue, time, itertools, os
import pandas as pd, requests
sys.argv = ['x']
import importlib.util
spec = importlib.util.spec_from_file_location('e2', '/tmp/leads/scripts/enrich_v2.py'); e2 = importlib.util.module_from_spec(spec); spec.loader.exec_module(e2)
W = '/tmp/leads/work'
df = pd.read_pickle(f'{W}/final_df.pkl'); df['abn_raw'] = df.ABN.str.replace(' ', '')
cand = {}   # abn -> list of dict(email, source, kind, page)
ws2conf = json.load(open(f'{W}/v3/ws2_conf.json')) if os.path.exists(f'{W}/v3/ws2_conf.json') else {}
BUILDKW = re.compile(r'(build|construct|home|renovat|reno|carpent|project|develop|roof|kitchen|bathroom|joiner|concret|deck|patio|extension|maint|propert|design|struct|frame|brick|plaster|til(e|ing)|inspect|cabinet|pool|landscap|fenc|shed|steel|glaz|window|door|floor|paint|plumb|electric|civil|excavat|earthwork|demoli|carport|granny|house|dwelling|living|residen|estate|architect|draft)', re.I)
dropped_ind = []
site_of = {}
def add(abn, email, source, kind='', page=''):
    e = (email or '').strip().lower()
    if not e: return
    lst = cand.setdefault(abn, [])
    if e not in [c['email'] for c in lst]: lst.append(dict(email=e, source=source, kind=kind, page=page))
for _, r in df.iterrows():
    if r.Website: site_of[r.abn_raw] = r.Website
    if r.Email:
        src = r['Contact Source'] or 'existing'
        add(r.abn_raw, r.Email, 'Company website' if 'website' in src.lower() else src)
for f, label in [(f'{W}/v2/out_site.jsonl', 'Company website (contact/about pages)'), (f'{W}/v2/out_disc.jsonl', 'Company website (newly found)'), (f'{W}/v2/out_ind.jsonl', 'Business website (newly found)'),
                 (f'{W}/v3/out_site.jsonl', 'Company website (deeper crawl: sitemap, structured data)'), (f'{W}/v3/out_disc.jsonl', 'Company website (newly found)'), (f'{W}/v3/out_ind.jsonl', 'Business website (newly found)'), (f'{W}/v3/out_ws2.jsonl', 'WS2'), (f'{W}/v3/out_pdf.jsonl', 'Company capability statement / brochure (PDF on own website)')]:
    if not os.path.exists(f): continue
    for l in open(f):
        j = json.loads(l)
        # sole traders often hold business names for unrelated ventures: keep only building-related sites (or ABN-verified)
        if 'out_ind' in f and j.get('website') and not (j.get('web_conf', '').startswith('Verified') or BUILDKW.search(j['website'])):
            dropped_ind.append(j['website']); continue
        if j.get('website') and j['abn'] not in site_of: site_of[j['abn']] = j['website']
        lab_ = label
        if label == 'WS2': lab_ = 'Company website (official site found by web search)' if ws2conf.get(j['abn']) == 'high' else 'Parent/brand website (web search, medium confidence)'
        for em in j.get('emails') or []: add(j['abn'], em['email'], lab_, em['kind'], em.get('page', ''))
# browser-rendered pages: addresses the page displays once rendered
if os.path.exists(f'{W}/v3/render_out.jsonl'):
    rq_site = {}
    for l in open(f'{W}/v3/render_queue.jsonl'):
        j = json.loads(l); rq_site[j['url']] = j.get('website') or ''
    for l in open(f'{W}/v3/render_out.jsonl'):
        j = json.loads(l)
        if j.get('status') != 'ok': continue
        sd = e2.site_dom(rq_site.get(j['url']) or j['url'])
        for raw in [x for m_ in (j.get('mailtos') or []) + (j.get('text_emails') or []) for x in re.split(r'[,;\s]+', m_) if x]:
            e = raw.strip().strip('.').lower()
            if not e2.mc_valid(e) or e2.JUNK.search(e) or e2.NOTSALES.match(e): continue
            dom = e.split('@')[1]
            kind = 'own-domain' if e2.same_org(dom, sd) else 'mailbox provider' if dom in e2.FREEMAIL else None
            # a different domain shown on the company's own contact page is kept, but only as Risky (reviewed by a person)
            if kind is None and re.search(r'contact|enquir|touch|connect|talk|reach', j['url'], re.I): kind = 'other-domain'
            if kind:
                if j['abn'] not in site_of and rq_site.get(j['url']): site_of[j['abn']] = rq_site[j['url']]
                add(j['abn'], e, 'Company website (rendered page)', kind, j['url'])
wsconf = json.load(open(f'{W}/v2/ws_conf.json')) if os.path.exists(f'{W}/v2/ws_conf.json') else {}
if os.path.exists(f'{W}/v2/out_ws.jsonl'):
    for l in open(f'{W}/v2/out_ws.jsonl'):
        j = json.loads(l)
        lab = 'Company website (official site found by web search)' if wsconf.get(j['abn']) == 'high' else 'Parent/brand website (web search, medium confidence)'
        if j.get('website') and j['abn'] not in site_of: site_of[j['abn']] = j['website']
        for em in j.get('emails') or []: add(j['abn'], em['email'], lab, em['kind'], em.get('page', ''))
# ---- MX checks (cached per domain) ----
doms = sorted({c['email'].split('@')[1] for l in cand.values() for c in l if '@' in c['email']})
MX = {}
DOH = itertools.cycle(['https://dns.google/resolve', 'https://cloudflare-dns.com/dns-query'])
def q(name, typ, s):
    for _ in range(3):
        try: return s.get(next(DOH), params={'name': name, 'type': typ}, headers={'accept': 'application/dns-json'}, timeout=8).json()
        except Exception: time.sleep(0.5)
    return {}
qq = queue.Queue(); [qq.put(d) for d in doms]; lock = threading.Lock()
def run():
    s = requests.Session()
    while True:
        try: d = qq.get_nowait()
        except queue.Empty: return
        j = q(d, 'MX', s); st = j.get('Status')
        if st == 3: v = 'NXDOMAIN'
        elif st == 0 and any(a.get('type') == 15 for a in j.get('Answer', [])):
            mx = [a['data'] for a in j['Answer'] if a.get('type') == 15]
            v = 'NULL-MX' if all(m.strip().endswith(' .') or m.strip() == '0 .' for m in mx) else 'MX'
        elif st == 0:
            a = q(d, 'A', s); v = 'A-ONLY' if any(x.get('type') in (1, 5) for x in a.get('Answer', [])) else 'NO-MAIL'
        else: v = 'DNS-ERROR'
        with lock: MX[d] = v
ths = [threading.Thread(target=run) for _ in range(100)]; [t.start() for t in ths]; [t.join() for t in ths]
print('sole-trader sites dropped as not building-related', len(dropped_ind))
print('domains checked', len(MX), pd.Series(MX).value_counts().to_dict())
# ---- per-email verdicts ----
def site_dom(u): return e2.site_dom(u) if u else ''
rows = []
for abn, lst in cand.items():
    sd = site_dom(site_of.get(abn, ''))
    for c in lst:
        e = c['email']; dom = e.split('@')[1] if '@' in e else ''
        reasons = []
        if not e2.mc_valid(e): reasons.append('fails address grammar')
        if e2.JUNK.search(e): reasons.append('placeholder / system address')
        if e2.NOTSALES.match(e): reasons.append('non-sales mailbox (careers/HR/accounts/media)')
        mx = MX.get(dom, 'DNS-ERROR')
        if mx in ('NXDOMAIN', 'NULL-MX', 'NO-MAIL'): reasons.append('domain cannot receive mail (' + mx + ')')
        kind = c['kind'] or ('own-domain' if sd and e2.same_org(dom, sd) else 'mailbox provider' if dom in e2.FREEMAIL else 'other-domain')
        status = 'Invalid' if reasons else ('Valid' if mx == 'MX' else 'Risky')
        if status == 'Valid' and kind == 'other-domain' and 'website' in c['source'].lower(): status = 'Risky'; reasons.append('domain differs from company website')
        if status == 'Risky' and mx == 'A-ONLY': reasons.append('no MX record (A-record fallback only)')
        if mx == 'DNS-ERROR' and not reasons: status = 'Risky'; reasons.append('DNS check inconclusive')
        if status == 'Valid' and 'medium confidence' in c['source']: status = 'Risky'; reasons.append('website is a probable parent/brand site, not confirmed for this entity')
        role = bool(e2.ROLE.match(e))
        rows.append(dict(abn=abn, email=e, source=c['source'], kind=kind, mx=mx, status=status, reasons='; '.join(reasons), role=role, page=c['page']))
ev = pd.DataFrame(rows)
rank_src = lambda s: 0 if 'website' in s.lower() else 1 if 'Master Builders' in s or 'register' in s.lower() else 2
ev['_r'] = ev.apply(lambda r: ({'Valid': 0, 'Risky': 1, 'Invalid': 2}[r.status], {'own-domain': 0, 'mailbox provider': 1, 'other-domain': 2}.get(r.kind, 2), not r.role, rank_src(r.source), len(r.email)), axis=1)
ev = ev.sort_values(['abn', '_r'])
ev.to_pickle(f'{W}/v2/email_evidence.pkl')
best = ev[ev.status != 'Invalid'].groupby('abn').head(1).set_index('abn')
alts = ev[ev.status != 'Invalid'].groupby('abn').email.apply(lambda s: ' | '.join(list(s)[1:3]))
# an address shared by several leads (group companies, one office) is flagged; the campaign sends it once
shared = best.email.value_counts(); best['shared_by'] = best.email.map(shared)
best['alts'] = alts
best.to_pickle(f'{W}/v2/email_best.pkl')
print('leads with candidate', ev.abn.nunique(), 'with usable email', len(best), best.status.value_counts().to_dict(), best.kind.value_counts().to_dict())
print('invalid reasons', ev[ev.status == 'Invalid'].reasons.value_counts().head(10).to_dict())
print('unique usable addresses', best.email.nunique())
