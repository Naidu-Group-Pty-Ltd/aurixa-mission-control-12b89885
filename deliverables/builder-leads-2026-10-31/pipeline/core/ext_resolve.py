# Resolve ABNs for an external source CSV (MBA members / developers / other-state registers).
# usage: ext_resolve.py <kind> <in.csv> <out.csv>
import sys, csv, re, subprocess, os, duckdb
from rapidfuzz import fuzz
kind, src, dst = sys.argv[1:4]
W = '/tmp/leads/work'
rows = list(csv.DictReader(open(src, encoding='utf-8')))
def g(r, *ks):
    for k in ks:
        if r.get(k): return r[k].strip()
    return ''
name1 = lambda r: g(r, 'business_name', 'company_name', 'entity_name')
name2 = lambda r: g(r, 'trading_name')
st = lambda r: (g(r, 'state') or '').upper()[:3].strip()
# 1) name matching (legal/business name, then trading name)
for tag, fn in (('n1', name1), ('n2', name2)):
    with open(f'{W}/{kind}_{tag}_in.csv', 'w') as f:
        w = csv.writer(f); w.writerow(['rid', 'name', 'state', 'abn'])
        for i, r in enumerate(rows):
            if fn(r): w.writerow([i, re.sub(r'\s*\((?:t/a|trading as)[^)]*\)', '', fn(r), flags=re.I), st(r), g(r, 'abn')])
    subprocess.run(['python3', '-I', '/tmp/leads/scripts/match_names.py', f'{W}/{kind}_{tag}_in.csv', f'{W}/{kind}_{tag}_match.csv'], check=True)
m1 = {r['rid']: r for r in csv.DictReader(open(f'{W}/{kind}_n1_match.csv'))}
m2 = {r['rid']: r for r in csv.DictReader(open(f'{W}/{kind}_n2_match.csv'))}
# 2) ABNs printed on the organisation's own website
with open(f'{W}/{kind}_web_in.csv', 'w') as f:
    w = csv.writer(f); w.writerow(['rid', 'website'])
    for i, r in enumerate(rows):
        if g(r, 'website'): w.writerow([i, g(r, 'website')])
if not os.path.exists(f'{W}/{kind}_web_abn.csv') or os.path.getmtime(f'{W}/{kind}_web_abn.csv') < os.path.getmtime(src):
    subprocess.run(['python3', '-I', '/tmp/leads/scripts/web_abn.py', f'{W}/{kind}_web_in.csv', f'{W}/{kind}_web_abn.csv'], check=True)
wa = {r['rid']: r for r in csv.DictReader(open(f'{W}/{kind}_web_abn.csv'))}
con = duckdb.connect('/tmp/leads/work/leads.duckdb', read_only=True)
def info(a):
    return con.execute("""select b.entity_name, b.state, b.abn_status, b.entity_type_code, b.acn, coalesce(x.bns,'') from abr b
       left join (select BN_ABN, string_agg(BN_NAME,' | ') bns from bn where BN_ABN=? and BN_STATUS='Registered' group by 1) x on x.BN_ABN=b.abn where b.abn=?""", [a, a]).fetchone()
def norm(s): return re.sub(r'\b(PTY|LTD|LIMITED|THE|TRUSTEE|FOR|TRUST|GROUP|AUSTRALIA)\b', ' ', re.sub(r'[^A-Z0-9 ]', ' ', (s or '').upper()))
out = []
for i, r in enumerate(rows):
    rid = str(i); abn = ''; how = ''
    a1 = m1.get(rid, {}); a2 = m2.get(rid, {})
    if a1.get('abn_match_method', '').startswith('ABN listed'): abn, how = a1['abn'], a1['abn_match_method']
    if not abn and g(r, 'acn'):
        acn = re.sub(r'\D', '', g(r, 'acn')).zfill(9)
        x = con.execute("select abn from abr_by_acn where lpad(acn,9,'0')=? and abn_status='ACT'", [acn]).fetchone()
        if x: abn, how = x[0], 'ACN listed by source -> ABN (ABR)'
    if not abn and rid in wa and wa[rid]['active_abns']:
        for a in wa[rid]['active_abns'].split():
            inf = info(a)
            score = max(fuzz.token_set_ratio(norm(name1(r)), norm(inf[0])), max([fuzz.token_set_ratio(norm(name1(r)), norm(b)) for b in inf[5].split(' | ')] or [0]),
                        fuzz.token_set_ratio(norm(name2(r)), norm(inf[0])) if name2(r) else 0)
            if score >= 75: abn, how = a, 'ABN printed on own website; name confirmed in ABR'; break
    if not abn and a1.get('abn'): abn, how = a1['abn'], a1['abn_match_method']
    if not abn and a2.get('abn'): abn, how = a2['abn'], a2['abn_match_method'] + ' (trading name)'
    if not abn: how = a1.get('abn_match_method') or 'no name match'
    out.append(dict(rid=rid, abn=abn, abn_method=how))
w = csv.DictWriter(open(dst, 'w'), fieldnames=['rid', 'abn', 'abn_method']); w.writeheader(); w.writerows(out)
import collections
print(kind, len(rows), collections.Counter((o['abn_method'] or '').split(' (')[0].split(';')[0] for o in out).most_common())
