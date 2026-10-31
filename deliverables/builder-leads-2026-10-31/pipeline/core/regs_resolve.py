import csv, re, subprocess, duckdb, collections
W = '/tmp/leads/work'
rows = list(csv.DictReader(open('/tmp/leads/agents/regs/state_registers.csv', encoding='utf-8')))
keep, drop = [], collections.Counter()
for r in rows:
    if 'Not able to contract' in r['licence_class']: drop['ACT nominee/employee-only licence'] += 1; continue
    if 'registration has no effect' in r['licence_status']: drop['WA registration has no effect (no nominated supervisor)'] += 1; continue
    if r['licence_expiry'] and r['licence_expiry'] < '2026-10-31': drop['registration period expired'] += 1; continue
    keep.append(r)
print('kept', len(keep), dict(drop))
CO = re.compile(r'\b(PTY|PTY\.|LTD|LIMITED|P/L|TRUST|INC|INCORPORATED|CORPORATION|CO-OPERATIVE)\b', re.I)
comp = [r for r in keep if r['entity_type'] in ('company',) or (r['entity_type'] == '' and CO.search(r['entity_name']))]
indv = [r for r in keep if r not in comp and r['entity_type'] in ('individual', '') and '&' not in r['entity_name'] and ' AND ' not in r['entity_name'].upper()]
part = [r for r in keep if r not in comp and r not in indv]
print('companies', len(comp), 'individuals', len(indv), 'partnerships/other', len(part))
fields = list(rows[0].keys())
with open(f'{W}/regs_comp.csv', 'w') as f:
    w = csv.DictWriter(f, fieldnames=fields); w.writeheader(); w.writerows(comp + part)
subprocess.run(['python3', '-I', '/tmp/leads/scripts/ext_resolve.py', 'regs', f'{W}/regs_comp.csv', f'{W}/regs_comp_resolved.csv'], check=True)
# individuals: ABR individual name + postcode (or + state for ACT, which publishes no address), unique active match
con = duckdb.connect(f'{W}/leads.duckdb', read_only=True)
con.execute("SET threads=4; SET memory_limit='8GB'")
with open(f'{W}/regs_ind_in.csv', 'w') as f:
    w = csv.writer(f); w.writerow(['rid', 'n', 'n2', 'state', 'postcode'])
    for i, r in enumerate(indv):
        n = re.sub(r'\(.*?\)', ' ', r['entity_name']); n = re.sub(r'[^A-Za-z ]', ' ', n).upper(); n = re.sub(r' +', ' ', n).strip()
        parts = n.split(' ')
        w.writerow([i, n, parts[0] + ' ' + parts[-1] if len(parts) > 1 else n, r['state'], r['postcode']])
con.execute(f"CREATE TEMP TABLE ii AS SELECT * FROM read_csv('{W}/regs_ind_in.csv', header=true, all_varchar=true)")
con.execute("""CREATE TEMP TABLE ai AS SELECT abn, nm(entity_name) n, split_part(nm(entity_name),' ',1)||' '||split_part(nm(entity_name),' ',-1) n2, postcode, state
   FROM abr WHERE entity_type_code='IND' AND abn_status='ACT' AND state IN ('NSW','WA','ACT','NT')""")
res = {}
for label, q in [('ABR exact name + postcode (unique)', "SELECT i.rid, list(DISTINCT a.abn) FROM ii i JOIN ai a ON a.n=i.n AND a.state=i.state AND a.postcode=i.postcode WHERE i.postcode IS NOT NULL GROUP BY 1"),
                 ('ABR first+last name + postcode (unique)', "SELECT i.rid, list(DISTINCT a.abn) FROM ii i JOIN ai a ON a.n2=i.n2 AND a.state=i.state AND a.postcode=i.postcode WHERE i.postcode IS NOT NULL GROUP BY 1"),
                 ('ABR exact name + state (unique, ACT)', "SELECT i.rid, list(DISTINCT a.abn) FROM ii i JOIN ai a ON a.n=i.n AND a.state=i.state WHERE i.state='ACT' GROUP BY 1")]:
    for rid, abns in con.execute(q).fetchall():
        if rid not in res and len(abns) == 1: res[rid] = (abns[0], label)
print('individuals matched', len(res), collections.Counter(v[1] for v in res.values()))
# combined file + resolution, aligned rids
comp_res = list(csv.DictReader(open(f'{W}/regs_comp_resolved.csv')))
allrows = comp + part + indv
with open(f'{W}/regs_filtered.csv', 'w') as f:
    w = csv.DictWriter(f, fieldnames=fields); w.writeheader(); w.writerows(allrows)
with open(f'{W}/regs_resolved.csv', 'w') as f:
    w = csv.writer(f); w.writerow(['rid', 'abn', 'abn_method'])
    for r in comp_res: w.writerow([r['rid'], r['abn'], r['abn_method']])
    off = len(comp) + len(part)
    for i in range(len(indv)):
        a = res.get(str(i))
        w.writerow([off + i, a[0] if a else '', a[1] if a else 'no unique ABR individual match'])
