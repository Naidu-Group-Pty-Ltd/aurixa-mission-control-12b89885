# Assemble /tmp/leads/agents/regs/state_registers.csv from downloaded official sources.
# Run: python3 -I build_csv.py /tmp/leads/agents/regs
import csv, json, os, re, sys, glob, html, collections

BASE = sys.argv[1]
RAW = os.path.join(BASE, 'raw')
OUT = os.path.join(BASE, 'state_registers.csv')
TODAY = '2026-10-31'
COLS = ['state', 'register', 'source_url', 'as_at_date', 'entity_name', 'entity_type', 'licence_number',
        'licence_class', 'licence_status', 'licence_expiry', 'abn', 'acn', 'address', 'suburb', 'postcode',
        'phone', 'email', 'website']
STATES = r'(NSW|VIC|QLD|SA|WA|TAS|NT|ACT)'
rows = []
stats = collections.Counter()


def clean(s):
    if s is None:
        return ''
    s = str(s).replace('(cid:13)', ' ')
    return re.sub(r'\s+', ' ', s).strip()


def digits(s):
    d = re.sub(r'\D', '', clean(s))
    if not d or set(d) == {'9'} or set(d) == {'0'}:
        return ''
    return d


def dmy_to_iso(s):
    m = re.match(r'(\d{1,2})/(\d{1,2})/(\d{4})$', clean(s))
    return f'{m.group(3)}-{int(m.group(2)):02d}-{int(m.group(1)):02d}' if m else clean(s)


def split_suburb_pc(addr):
    """Return (suburb, postcode) from an Australian address ending '... SUBURB STATE 1234'."""
    a = clean(addr)
    m = re.search(r'(?:^|[,\s])([A-Za-z][A-Za-z \'\.\-]*?)[,\s]+' + STATES + r'\s*,?\s*(\d{4})\s*$', a)
    if not m:
        return '', ''
    pc = m.group(3)
    head = a[:m.start(2)].rstrip(' ,')
    # suburb = text after last comma if present, else trailing ALL-CAPS words
    if ',' in head:
        sub = head.rsplit(',', 1)[1].strip()
    else:
        words = head.split()
        tail = []
        for w in reversed(words):
            if re.fullmatch(r"[A-Z][A-Z'\.\-]*", w) and w not in ('PO', 'BOX', 'GPO', 'U', 'L', 'RD', 'ST', 'AVE', 'DR'):
                tail.insert(0, w)
            else:
                break
        sub = ' '.join(tail)
    return sub.upper(), pc


def add(**kw):
    r = {c: clean(kw.get(c, '')) for c in COLS}
    rows.append(r)
    stats[r['state']] += 1


# ---------------- NSW ----------------
NSW_API = 'https://verify.licence.nsw.gov.au/publicregisterapi/api/v1/licence/search/advQuery'
live = {}
for f in ['advQuery_test.json', 'advQuery_2200.json', 'advQuery_2200_p1.json', 'test_search.json']:
    p = os.path.join(RAW, 'nsw', f)
    if not os.path.exists(p):
        continue
    for r in json.load(open(p)).get('results', []):
        if r.get('status') == 'Current' and r.get('licenceType') == 'Contractor Licence':
            live[r['licenceNumber']] = r
for num, r in sorted(live.items()):
    et = {'Organisation': 'company', 'Individual': 'individual', 'Partnership': 'partnership'}.get(r.get('licenseeType'), clean(r.get('licenseeType')).lower())
    add(state='NSW', register='NSW Fair Trading contractor licence (Verify NSW public register, live query)',
        source_url=NSW_API + ' [POST licenceGroup=Trades, licenceTypes=Contractor, status=Current, class=HBS_CON_Builder]',
        as_at_date=TODAY, entity_name=r.get('licensee'), entity_type=et, licence_number=num,
        licence_class='Contractor Licence - Builder (general building work)', licence_status=r.get('status'),
        licence_expiry=r.get('expires'), abn=digits(r.get('ABN')), acn=digits(r.get('ACN')),
        address=r.get('address'), suburb=r.get('suburb'), postcode=r.get('postcode'))
stats['NSW_live'] = len(live)

NSW_X = 'https://www.onegov.nsw.gov.au/agencies/oft/Contractor%20Licence.xlsx'
kind_map = {'Individual licensees': 'individual', 'Organisation licensees': 'company',
            'Partnership licensees': 'partnership', 'Unqualified Individual licensees': 'individual'}
seen = set(live)
for line in open(os.path.join(RAW, 'nsw', 'extract2023_builders.jsonl')):
    d = json.loads(line)
    num = clean(d.get('Licence Number'))
    exp = clean(d.get('Expiry Date'))
    if num in seen or not exp or exp < TODAY:
        stats['NSW_2023_skipped'] += 1
        continue
    seen.add(num)
    addr = clean(d.get('Address'))
    parts = [p.strip() for p in addr.split(',')]
    sub, pc = '', ''
    m = re.match(STATES + r'\s+(\d{4})$', parts[-1]) if parts else None
    if m and len(parts) >= 2:
        sub, pc = parts[-2].upper(), m.group(2)
    else:
        sub, pc = split_suburb_pc(addr)
    if not pc and len(parts) >= 2:
        m2 = re.match(r'(?:([A-Za-z][A-Za-z \'\.\-]*?)\s+)?(\d{4})$', parts[-1])
        if m2:
            sub, pc = (m2.group(1) or parts[-2]).upper(), m2.group(2)
        else:
            m3 = re.match(r'([A-Za-z][A-Za-z \'\.\-]*?)\s+' + STATES + r'$', parts[-1])
            if m3:
                sub = m3.group(1).upper()
    others = [c for c in d.get('class_list', []) if c and c != 'Builder']
    cls = 'Contractor Licence - Builder (general building work)' + (f'; other classes: {"; ".join(others)}' if others else '')
    add(state='NSW', register='NSW Fair Trading contractor licence (Current Licence Extract, 4 Dec 2023)',
        source_url=NSW_X, as_at_date='2023-12-04', entity_name=d.get('Licensee'),
        entity_type=kind_map.get(d.get('kind'), ''), licence_number=num, licence_class=cls,
        licence_status='Current at 2023-12-04 (expiry after 2026-10-31; not re-verified live)',
        licence_expiry=exp, abn=digits(d.get('ABN')), acn=digits(d.get('ACN')), address=addr, suburb=sub, postcode=pc)
    stats['NSW_2023_included'] += 1

# ---------------- WA ----------------
WA_URL = 'https://contenthub.demirs.wa.gov.au/downloads/cals/BuilderRegister.pdf'
for line in open(os.path.join(RAW, 'wa', 'section1_current_contractors.jsonl')):
    r = json.loads(line)
    sup = clean(' '.join(r.get('supervisor', [])))
    status = r['status']
    et = ''
    if sup.startswith('Company without Nominated Supervisor'):
        status += ' (register note: company without nominated supervisor - registration has no effect)'
        et = 'company'
    elif sup.startswith('Partnership without Nominated Supervisor'):
        status += ' (register note: partnership without nominated supervisor - registration has no effect)'
        et = 'partnership'
    cls = 'Registered building contractor (BC)'
    if r.get('conditions'):
        cls += ' | ' + clean(r['conditions'])
    if r.get('former_reg_no'):
        cls += f' | former reg no {clean(r["former_reg_no"])}'
    sub, pc = split_suburb_pc(r['address'])
    add(state='WA', register='WA Building Services Board register of building contractors (Section 1 current)',
        source_url=WA_URL, as_at_date=dmy_to_iso(r['as_at']), entity_name=r['name'], entity_type=et,
        licence_number=r['reg_no'], licence_class=cls, licence_status=status, licence_expiry='',
        address=r['address'], suburb=sub, postcode=pc)

# ---------------- ACT ----------------
ACT_URL = 'https://www.data.act.gov.au/resource/de4w-gbt3.json?occupation=Builder'
for r in json.load(open(os.path.join(RAW, 'act', 'de4w-gbt3_builder_all.json'))):
    if r.get('licence_status') != 'Active':
        continue
    if clean(r.get('description')) == 'Owner Builder':
        stats['ACT_owner_builder_excluded'] += 1
        continue
    name = clean(f"{r.get('given_names', '')} {r.get('surname', '')}")
    cls = 'Builder - ' + clean(r.get('description'))
    if clean(r.get('class_condition')):
        cls += ' | condition: ' + clean(r.get('class_condition'))
    if clean(r.get('endorsement')):
        cls += ' | endorsement: ' + clean(r.get('endorsement'))
    add(state='ACT', register='ACT construction occupations licence - Builder (Access Canberra, List of Professionals)',
        source_url=ACT_URL, as_at_date='2026-10-30', entity_name=name, entity_type='',
        licence_number=r.get('cola_licence_number'), licence_class=cls, licence_status=r.get('licence_status'),
        licence_expiry=dmy_to_iso(r.get('expiry_date')), acn=digits(r.get('licensee_acn')))

# ---------------- NT ----------------
NT_LIST = 'https://ntlis.nt.gov.au/building-practitioners/results.jsp?category={c}&status=ACTIVE'
NT_DET = 'https://ntlis.nt.gov.au/building-practitioners/result.jsp?id={i}'
cat_names = {}
for f in sorted(glob.glob(os.path.join(RAW, 'nt', 'results_*_ACTIVE.html'))):
    c = re.search(r'results_(\w+)_ACTIVE', f).group(1)
    t = open(f, errors='replace').read()
    for m in re.finditer(r'<tr><td><a href="result\.jsp\?id=(\d+)">(.*?)</a></td><td>(.*?)</td><td>(.*?)</td><td>(.*?)</td><td>(.*?)</td></tr>', t, flags=re.S):
        i, name, phone, addr, cat, status = m.groups()
        if status.strip() != 'ACTIVE':
            continue
        lines = [clean(html.unescape(x)) for x in re.split(r'<br\s*/?>', addr)]
        rec = dict(id=i, name=clean(html.unescape(name)), phone=clean(phone), addr_lines=lines, cat=clean(html.unescape(cat)), status='ACTIVE', code=c)
        dp = os.path.join(RAW, 'nt', 'details', f'{i}.html')
        reg, exp, mobile = '', '', ''
        if os.path.exists(dp) and os.path.getsize(dp) > 1000:
            dt = open(dp, errors='replace').read()
            g = lambda h: (re.search(r'<th[^>]*>' + h + r'</th>\s*<td>(.*?)</td>', dt, flags=re.S) or [None, ''])[1]
            reg = clean(html.unescape(re.sub(r'<[^>]+>', ' ', g('Registration Number'))))
            per = re.findall(r'(\d{2}/\d{2}/\d{4})\s*-\s*(\d{2}/\d{2}/\d{4})', g('Active Registration Periods'))
            if per:
                exp = dmy_to_iso(max(per, key=lambda p: dmy_to_iso(p[1]))[1])
            mobile = clean(html.unescape(re.sub(r'<[^>]+>', ' ', g('Mobile Number'))))
            cond = clean(html.unescape(re.sub(r'<[^>]+>', ' ', g('Conditions or Endorsements'))))
            dstat = clean(re.sub(r'<[^>]+>', ' ', g('Status')))
            if dstat and dstat != 'ACTIVE':
                stats['NT_detail_status_mismatch'] += 1
                continue
            stats['NT_with_detail'] += 1
        else:
            cond = ''
            stats['NT_without_detail'] += 1
        phones = '; '.join(p for p in dict.fromkeys([rec['phone'], mobile]) if p and p.upper() != 'N/A')
        addr_s = ', '.join(x for x in lines if x)
        sub, pc = split_suburb_pc(lines[-1] if lines else '')
        cls = rec['cat'] + (f' | {cond}' if cond and cond.upper() not in ('N/A', 'NIL') else '')
        add(state='NT', register='NT Building Practitioners Board register - building contractor',
            source_url=NT_DET.format(i=i) if reg else NT_LIST.format(c=c), as_at_date=TODAY,
            entity_name=rec['name'], entity_type='', licence_number=reg, licence_class=cls,
            licence_status='ACTIVE', licence_expiry=exp, address=addr_s, suburb=sub, postcode=pc, phone=phones)

with open(OUT, 'w', newline='', encoding='utf-8') as f:
    w = csv.DictWriter(f, fieldnames=COLS)
    w.writeheader()
    w.writerows(rows)
print('wrote', OUT, len(rows))
for k, v in sorted(stats.items()):
    print(f'  {k}: {v}')
