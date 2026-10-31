import pandas as pd, xlsxwriter, csv, os, duckdb, collections
W = '/tmp/leads/work'
OUT = os.environ.get('OUT', '/tmp/leads/out/Builders_Developers_Validated_Leads_AU_2026-10-31.xlsx')
df = pd.read_pickle(f'{W}/final_df.pkl'); exc = pd.read_pickle(f'{W}/excluded_ext.pkl')
TIERS = ['Enterprise (>$240M)', 'Large ($30M–$240M)', 'Medium ($3M–$30M)', 'Small ($0.8M–$3M)', 'Micro (<$0.8M)']
cols = [c for c in df.columns if not c.startswith('_') and (df[c].astype(str) != '').any()]
org = df[~df._ind]; ind = df[df._ind]
wb = xlsxwriter.Workbook(OUT, {'strings_to_urls': False})
H = wb.add_format({'bold': True, 'bg_color': '#1F3864', 'font_color': 'white', 'text_wrap': True, 'valign': 'top', 'border': 1})
B = wb.add_format({'bold': True}); T = wb.add_format({'bold': True, 'font_size': 14}); WR = wb.add_format({'text_wrap': True, 'valign': 'top'})
N = wb.add_format({'num_format': '#,##0'})
WID = {'Priority': 8, 'State': 6, 'Company': 38, 'Trading / Business Names': 34, 'Org Type': 16, 'Development Type': 28, 'Org Size Category': 20, 'Size Basis': 45,
       'Size Confidence': 10, 'Description': 50, 'Phone': 15, 'Email': 30, 'Email Status': 9, 'Email Type': 30, 'Email Source': 30, 'Email Found On': 30, 'Email Check': 40, 'Alt Emails': 30, 'Email Shared By (leads)': 9, 'Website': 32, 'Contact Source': 26, 'Website Match': 24, 'Business Address': 40, 'Postcode (ABR)': 9,
       'ABN': 15, 'ABN Status (ABR)': 10, 'ABN Active Since': 11, 'Entity Type (ABR)': 26, 'GST Registered': 8, 'ACN': 12, 'ASIC Status': 12, 'ASIC Company Type': 18,
       'ASIC Registered': 11, 'ABN Resolved Via': 30, 'Validation': 40, 'Licence State(s)': 10, 'Licence Number(s)': 26, 'Licence Class(es)': 40, 'QBCC Financial Category': 10,
       'Master Builders Member': 10, 'MBA Directory Categories': 30, 'Staff Band (MBA)': 12, 'In Original List': 9, 'Sources': 40, 'ABN Lookup': 22, 'Notes': 40}
def sheet(name, d, cs):
    ws = wb.add_worksheet(name)
    for j, c in enumerate(cs): ws.write(0, j, c, H); ws.set_column(j, j, WID.get(c, 18))
    vals = d[cs].fillna('').astype(str).values.tolist()
    for i, row in enumerate(vals, 1):
        for j, v in enumerate(row):
            if v: ws.write_string(i, j, v)
    ws.freeze_panes(1, 3); ws.autofilter(0, 0, len(vals), len(cs) - 1); ws.set_row(0, 32)
    return ws
# ---- Summary ----
ws = wb.add_worksheet('Summary')
ws.set_column(0, 0, 34); ws.set_column(1, 12, 14)
ws.write(0, 0, 'Australian Builders & Developers – Validated Lead List', T)
ws.write(1, 0, 'Compiled 31 Oct 2026 from official licence registers, ASIC and ABR datasets, Master Builders and industry directories.')
ws.write(3, 0, 'Total validated leads (organisations)', B); ws.write_number(3, 1, len(org), N)
ws.write(4, 0, 'Total validated leads (sole-trader builders)', B); ws.write_number(4, 1, len(ind), N)
ws.write(5, 0, 'Grand total', B); ws.write_number(5, 1, len(df), N)
ws.write(6, 0, 'Leads with phone or email', B); ws.write_number(6, 1, int(df._contact.sum()), N)
ws.write(3, 3, 'EMAIL COVERAGE', B)
ws.write(4, 3, 'Leads with a VALID email'); ws.write_number(4, 4, int((df['Email Status'] == 'Valid').sum()), N)
ws.write(5, 3, 'Leads with a RISKY email'); ws.write_number(5, 4, int((df['Email Status'] == 'Risky').sum()), N)
ws.write(7, 3, 'Removed: opt-out statement on page'); ws.write_number(7, 4, int((df['Email Status'] == 'Do not email').sum()), N)
ws.write(6, 3, 'Unique valid addresses (campaign rows)'); ws.write_number(6, 4, int(df.loc[df['Email Status'] == 'Valid', 'Email'].nunique()), N)
ws.write(7, 0, 'Leads with verified website', B); ws.write_number(7, 1, int((df.Website != '').sum()), N)
ws.write(8, 0, 'Master Builders members (matched)', B); ws.write_number(8, 1, int((df['Master Builders Member'] == 'Yes').sum()), N)
r = 10
ws.write(r, 0, 'Organisation size by state (all leads)', B); r += 1
states = sorted(df.State.replace('', 'Unknown').unique())
ws.write(r, 0, 'Org Size Category', H)
for j, s in enumerate(states + ['Total']): ws.write(r, j + 1, s, H)
for t in TIERS:
    r += 1; ws.write(r, 0, t)
    for j, s in enumerate(states): ws.write_number(r, j + 1, int(((df['Org Size Category'] == t) & (df.State.replace('', 'Unknown') == s)).sum()), N)
    ws.write_number(r, len(states) + 1, int((df['Org Size Category'] == t).sum()), N)
r += 1; ws.write(r, 0, 'Total', B)
for j, s in enumerate(states): ws.write_number(r, j + 1, int((df.State.replace('', 'Unknown') == s).sum()), N)
ws.write_number(r, len(states) + 1, len(df), N)
r += 2; ws.write(r, 0, 'Leads with a valid email, by size and state', B); r += 1
ws.write(r, 0, 'Org Size Category', H)
for j, s_ in enumerate(states + ['Total']): ws.write(r, j + 1, s_, H)
for t in TIERS:
    r += 1; ws.write(r, 0, t); m = (df['Org Size Category'] == t) & (df['Email Status'] == 'Valid')
    for j, s_ in enumerate(states): ws.write_number(r, j + 1, int((m & (df.State.replace('', 'Unknown') == s_)).sum()), N)
    ws.write_number(r, len(states) + 1, int(m.sum()), N)
r += 2; ws.write(r, 0, 'Size confidence', B); r += 1
for k, v in df['Size Confidence'].value_counts().items(): ws.write(r, 0, k); ws.write_number(r, 1, int(v), N); r += 1
r += 1; ws.write(r, 0, 'Org type', B); r += 1
for k, v in df['Org Type'].value_counts().items(): ws.write(r, 0, k); ws.write_number(r, 1, int(v), N); r += 1
r += 1; ws.write(r, 0, 'Priority (A = Medium+ with contact; B = Medium+ or Small with contact or MBA member; C = rest)', B); r += 1
for k, v in df['Priority'].value_counts().sort_index().items(): ws.write(r, 0, k); ws.write_number(r, 1, int(v), N); r += 1
r += 1; ws.write(r, 0, 'Records excluded at validation (see Excluded sheet)', B); r += 1
ex_reg = pd.read_pickle(f'{W}/excluded_reg.pkl') if os.path.exists(f'{W}/excluded_reg.pkl') else pd.DataFrame()
for k, v in (pd.concat([ex_reg, exc]) if len(ex_reg) else exc)['reason'].str.split(':').str[0:2].str.join(':').value_counts().items():
    ws.write(r, 0, k); ws.write_number(r, 1, int(v), N); r += 1
# ---- Leads ----
sheet('Leads - Organisations', org, cols)
sheet('Leads - Sole Traders', ind, [c for c in cols if c not in ('Business Address', 'ACN', 'ASIC Status', 'ASIC Company Type', 'ASIC Registered')])
# ---- Original list ----
if os.path.exists(f'{W}/orig_sheet.pkl'): sheet('Original List - Validated', pd.read_pickle(f'{W}/orig_sheet.pkl'), list(pd.read_pickle(f'{W}/orig_sheet.pkl').columns))
# ---- Needs review / excluded ----
allx = pd.concat([ex_reg, exc]) if len(ex_reg) else exc
sheet('Excluded - Needs Review', allx.fillna(''), list(allx.columns))
# ---- Methodology ----
ws = wb.add_worksheet('Methodology & Sources'); ws.set_column(0, 0, 150)
for i, line in enumerate(open('/tmp/leads/scripts/methodology.txt', encoding='utf-8').read().split('\n')):
    ws.write_string(i, 0, line, B if line.isupper() and line.strip() else WR)
wb.close(); print('wrote', OUT, len(df))
