# usage: match_names.py in.csv out.csv  (in.csv columns: rid, name, state, abn)
import duckdb, sys, csv, re
con = duckdb.connect('/tmp/leads/work/leads.duckdb', read_only=True)
con.execute("SET threads=4; SET memory_limit='8GB'")
con.execute(f"CREATE TEMP TABLE inp AS SELECT * FROM read_csv('{sys.argv[1]}', header=true, all_varchar=true)")
con.execute("""CREATE TEMP TABLE keys AS
  SELECT rid, nkey(name) k, 1 pri FROM inp UNION ALL
  SELECT rid, nkey(name) || ' GROUP', 2 FROM inp WHERE nkey(name) NOT LIKE '% GROUP' UNION ALL
  SELECT rid, regexp_replace(nkey(name), ' GROUP$', ''), 2 FROM inp WHERE nkey(name) LIKE '% GROUP' UNION ALL
  SELECT rid, regexp_replace(nkey(name), ' (QLD|VIC|NSW|WA|SA|TAS|ACT|NT|AUST|AUSTRALIA)$', ''), 3 FROM inp""")
con.execute("""CREATE TEMP TABLE cand AS
  SELECT DISTINCT k.rid, k.pri, n.abn, a.state abr_state, (l.abn IS NOT NULL) licensed, a.entity_type_code, n.src
  FROM keys k JOIN name_idx n ON n.k = k.k JOIN abr a ON a.abn = n.abn LEFT JOIN lead_core2 l ON l.abn = n.abn
  WHERE length(k.k) >= 4 AND a.entity_type_code <> 'IND'""")
inp = {r[0]: r for r in con.execute("select rid, name, state, abn from inp").fetchall()}
cands = {}
for rid, pri, abn, st, lic, et, src in con.execute("select * from cand").fetchall():
    cands.setdefault(rid, []).append(dict(pri=pri, abn=abn, st=st, lic=lic, src=src))
def act(a):
    r = con.execute("select abn_status from abr where abn=?", [a]).fetchone(); return r and r[0] == 'ACT'
def pick(cs, state, label):
    abns = {c['abn'] for c in cs}
    if len(abns) == 1: return cs[0]['abn'], label
    st = [c for c in cs if state and c['st'] == state]
    if len({c['abn'] for c in st}) == 1: return st[0]['abn'], label + ' + state'
    lic = [c for c in (st or cs) if c['lic']]
    if len({c['abn'] for c in lic}) == 1: return lic[0]['abn'], label + ' + licensed builder'
    return None, 'ambiguous (%d active ABNs share this name)' % len(abns)
out = csv.writer(open(sys.argv[2], 'w')); out.writerow(['rid', 'abn', 'abn_match_method', 'n_candidates'])
for rid, (_, name, state, abn0) in inp.items():
    a0 = re.sub(r'\D', '', abn0 or '')
    if len(a0) == 11 and act(a0): out.writerow([rid, a0, 'ABN listed by source; active in ABR', 1]); continue
    cs = cands.get(rid, [])
    if not cs: out.writerow([rid, '', 'no name match', 0]); continue
    best = min(c['pri'] for c in cs); cs = [c for c in cs if c['pri'] == best]
    legal = [c for c in cs if c['src'] != 'ASIC business name']
    res = (None, '')
    if legal: res = pick(legal, state, 'exact legal-name match')
    if not res[0]:
        bnm = [c for c in cs if c['src'] == 'ASIC business name' and state and c['st'] == state]
        if bnm: res = pick(bnm, state, 'registered business-name match' + (' (same state)' if state else ''))
        elif not res[1]: res = (None, 'business-name match only in another state')
    out.writerow([rid, res[0] or '', res[1], len({c['abn'] for c in cands[rid]})])
