import json, csv, re, duckdb, collections, datetime
con = duckdb.connect('/tmp/leads/work/leads.duckdb')
digits = lambda s: re.sub(r'\D', '', s or '')
# ---------- QLD QBCC ----------
rows = json.load(open('/tmp/leads/raw/qbcc/active.json'))
susp = json.load(open('/tmp/leads/raw/qbcc/susp.json'))
canc = json.load(open('/tmp/leads/raw/qbcc/canc.json'))
susp_lic = {str(r['Licence Number']) for r in susp}
canc_lic = {str(r['Licence Number']) for r in canc}
KEEP = {'Builder - Low Rise', 'Builder - Medium Rise', 'Builder - Open', 'Builder - Project Management Services'}
lic = collections.OrderedDict()
for r in rows:
    if r['Licence Grade'] not in ('Builder Licence', 'Builder Licence - EAT'): continue
    if r['Licence Class Type'] not in KEEP: continue
    k = str(r['Licence Number'])
    d = lic.setdefault(k, dict(state='QLD', register='QBCC Licensed Contractors Register (data.qld.gov.au, as at 2026-10-30)',
        licence_no=k, reg_name=(r['Licensee Name'] or '').strip(), entity_kind=r['Licence Type DESC'],
        reg_abn=digits(r['ABN']), reg_acn=digits(r['ACN']), address=(r['Licensee Business Address'] or '').strip(),
        fin_cat_code=r['Financial Category CODE'], fin_cat_desc=r['Financial Category DESC'], classes=set(), expiry=''))
    d['classes'].add(r['Licence Class Type'])
out = []
n_susp = n_canc = 0
for k, d in lic.items():
    if k in susp_lic: n_susp += 1; continue
    if k in canc_lic: n_canc += 1; continue
    m = re.search(r'\b(QLD|NSW|VIC|SA|WA|TAS|ACT|NT)\s+(\d{4})\s*$', d['address'])
    d['addr_state'], d['postcode'] = (m.group(1), m.group(2)) if m else ('', '')
    d['classes'] = '; '.join(sorted(d['classes']))
    out.append(d)
print('QLD builder licences kept', len(out), 'excluded suspended', n_susp, 'cancelled', n_canc)
# ---------- VIC BPC ----------
vic = collections.OrderedDict()
KEEPV = {'Domestic Builder - Unlimited', 'Commercial Builder - Unlimited', 'Commercial Builder - Limited', 'Project Manager - Domestic', 'Domestic Builder - Limited'}
for r in csv.DictReader(open('/tmp/leads/raw/vic/BPR.csv', encoding='utf-8-sig')):
    if r['Type'] != 'Company' or r['Accreditation Status'] != 'Current' or r['Limitation'] not in KEEPV: continue
    try:
        if datetime.datetime.strptime(r['Expires'], '%d/%m/%Y').date() < datetime.date(2026, 10, 31): continue
    except Exception: pass
    key = digits(r['ACN']) or r['Account Name'].upper().strip()
    d = vic.setdefault(key, dict(state='VIC', register='BPC (formerly VBA) Building Practitioner Register (data.vic.gov.au, downloaded 2026-10-31)',
        licence_no=set(), reg_name=r['Account Name'].strip(), entity_kind='Company', reg_abn=digits(r['ABN']), reg_acn=digits(r['ACN']),
        address='', addr_state='', postcode='', fin_cat_code='', fin_cat_desc='', classes=set(), expiry=''))
    d['licence_no'].add(r['Accreditation ID']); d['classes'].add(r['Limitation'])
    if not d['reg_abn'] and r['ABN']: d['reg_abn'] = digits(r['ABN'])
    d['expiry'] = max(d['expiry'], r['Expires'][6:] + r['Expires'][3:5] + r['Expires'][:2])
vout = []
for d in vic.values():
    # drop companies whose only registration is a restricted "Domestic Builder - Limited" class
    if d['classes'] == {'Domestic Builder - Limited'}: continue
    d['licence_no'] = '; '.join(sorted(d['licence_no'])); d['classes'] = '; '.join(sorted(d['classes']))
    vout.append(d)
print('VIC builder companies kept', len(vout))
cols = ['state','register','licence_no','reg_name','entity_kind','reg_abn','reg_acn','address','addr_state','postcode','fin_cat_code','fin_cat_desc','classes','expiry']
with open('/tmp/leads/work/reg_qld_vic.tsv', 'w') as f:
    w = csv.writer(f, delimiter='\t'); w.writerow(cols)
    for d in out + vout: w.writerow([d[c] for c in cols])
con.execute("CREATE OR REPLACE TABLE reg AS SELECT * FROM read_csv('/tmp/leads/work/reg_qld_vic.tsv', delim='\t', header=true, all_varchar=true, quote='\"')")
print(con.execute("select state, entity_kind, count(*), sum(reg_abn is not null), sum(reg_acn is not null) from reg group by all").fetchall())
