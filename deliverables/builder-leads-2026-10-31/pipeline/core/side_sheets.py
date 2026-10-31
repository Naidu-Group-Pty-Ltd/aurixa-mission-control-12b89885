import duckdb, pandas as pd, csv, openpyxl, re
W = '/tmp/leads/work'
con = duckdb.connect(f'{W}/leads.duckdb', read_only=True)
ex = con.execute("""select 'QLD QBCC register' || CASE WHEN entity_kind='Individual' THEN ' (individual licence)' ELSE '' END source, reg_name name, state, validation reason,
   licence_no, classes, coalesce(abn,'') abn, coalesce(reg_acn,'') acn, coalesce(abr_name,'') abr_name, coalesce(asic_name,'') asic_name, coalesce(asic_status,'') asic_status
   from v5 where validation<>'PASS' and state='QLD'
 union all select 'VIC BPC register', reg_name, state, validation, licence_no, classes, coalesce(abn,''), coalesce(reg_acn,''), coalesce(abr_name,''), coalesce(asic_name,''), coalesce(asic_status,'')
   from v5 where validation<>'PASS' and state='VIC'""").df()
ex['reason'] = ex['reason'].str.replace('EXCLUDE: ', '', regex=False)
# individual-licence rows are mostly nominees/employees; keep them out of the review sheet to avoid listing private individuals
ex = ex[~ex.source.str.contains('individual')]
ex.to_pickle(f'{W}/excluded_reg.pkl')
print(ex.reason.value_counts())
# original list sheet
wb = openpyxl.load_workbook('/tmp/input_xlsx/input.xlsx'); ws = wb.worksheets[0]
orig = [r for r in ws.iter_rows(min_row=2, values_only=True) if r[1]]
mm = {r['rid']: r for r in csv.DictReader(open(f'{W}/orig_match.csv'))}
wa = {r['rid']: r for r in csv.DictReader(open(f'{W}/orig_web_abn.csv'))}
fin = pd.read_pickle(f'{W}/final_df.pkl'); fin['abn_raw'] = fin.ABN.str.replace(' ', '')
rows = []
for i, r in enumerate(ws.iter_rows(min_row=2, values_only=True)):
    if not r[1]: continue
    m = mm.get(str(i), {}); site = (wa.get(str(i), {}).get('active_abns') or '').split()
    abn = m.get('abn') or ''
    how = m.get('abn_match_method', '')
    if not abn and site:
        abn = site[0]; how = 'ABN printed on company website'
    f = con.execute("select b.entity_name, b.abn_status, b.entity_type, b.state, a.asic_status from abr b left join asic_cur a on a.acn=lpad(nullif(b.acn,''),9,'0') where b.abn=?", [abn]).fetchone() if abn else None
    inl = fin[fin.abn_raw == abn]
    rows.append({'State': r[0], 'Company': r[1], 'Development Type': r[3], 'Phone': r[4] or '', 'Email': r[5] or '', 'Website': r[6] or '', 'Your Notes': (r[7] or '').strip(),
        'Matched ABN': f"{abn[:2]} {abn[2:5]} {abn[5:8]} {abn[8:]}" if abn else '', 'ABN Match Method': how,
        'ABR Entity Name': f[0] if f else '', 'ABN Status': ('Active' if f and f[1] == 'ACT' else (f[1] if f else '')), 'Entity Type': f[2] if f else '',
        'ASIC Status': {'REGD': 'Registered'}.get(f[4], f[4] or '') if f else '',
        'ABNs printed on website': ' '.join(f"{a[:2]} {a[2:5]} {a[5:8]} {a[8:]}" for a in site),
        'Org Size Category': inl['Org Size Category'].iloc[0] if len(inl) else '', 'Size Basis': inl['Size Basis'].iloc[0] if len(inl) else '',
        'Also in main lead list': 'Yes' if len(inl) else '',
        'Check': ('' if abn and f and f[1] == 'ACT' and 'ambiguous' not in how else 'Manual check: ' + (how or 'no ABN match'))
                 + (f'Confirm: matched entity is registered in {f[3]}, list says {r[0]}' if f and f[3] and r[0] and f[3] != r[0] else '')})
pd.DataFrame(rows).to_pickle(f'{W}/orig_sheet.pkl')
print(pd.DataFrame(rows)[['Company', 'Matched ABN', 'ABN Match Method', 'Check']].to_string()[:3000])
