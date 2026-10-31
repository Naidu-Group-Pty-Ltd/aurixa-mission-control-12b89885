"""Assemble developers_and_rankings.csv from downloaded/parsed raw files.
Run: python3 -I build_csv.py /tmp/leads/agents/dev/raw /tmp/leads/agents/dev/developers_and_rankings.csv
Every row is derived from a fetched file; nothing is invented.
"""
import csv, glob, json, os, re, sys, zipfile
from collections import OrderedDict

RAW, OUT = sys.argv[1], sys.argv[2]
COLS = ['source', 'source_url', 'as_at', 'company_name', 'state', 'org_type', 'size_indicator',
        'size_indicator_value', 'abn', 'phone', 'email', 'website', 'suburb', 'postcode', 'notes']
rows = []


def add(**kw):
    r = {c: '' for c in COLS}
    for k, v in kw.items():
        assert k in COLS, k
        r[k] = (v or '').strip() if isinstance(v, str) else v
    rows.append(r)


# ---------------------------------------------------------------- UDIA QLD (WP REST API)
def tax(name):
    return {x['id']: x for x in json.load(open(os.path.join(RAW, 'udiaqld_wp_%s.json' % name)))}

ind, act, reg = tax('industry'), tax('activity'), tax('region')
members = []
for f in sorted(glob.glob(os.path.join(RAW, 'udiaqld_wp_members_p*.json'))):
    members += json.load(open(f))
KEEP_IND = {'developer', 'builders-and-construction'}
KEEP_ACT = {'developers', 'building-construction', 'contractors-general', 'contractors-civil',
            'commercial-development', 'retail-development'}
import html as _h
for m in members:
    inds = [ind[i]['slug'] for i in m.get('industry', []) if i in ind]
    acts = [act[i]['slug'] for i in m.get('activity', []) if i in act]
    if not (set(inds) & KEEP_IND or set(acts) & KEEP_ACT):
        continue
    name = _h.unescape(m['title']['rendered'])
    ind_n = [ind[i]['name'] for i in m.get('industry', []) if i in ind]
    act_n = [_h.unescape(act[i]['name']) for i in m.get('activity', []) if i in act]
    reg_n = [reg[i]['name'] for i in m.get('region', []) if i in reg]
    if 'developer' in inds or 'developers' in acts:
        ot = 'developer'
    elif 'contractors-civil' in acts and 'building-construction' not in acts:
        ot = 'civil contractor'
    else:
        ot = 'builder / construction'
    add(source='UDIA Queensland member directory', source_url=m['link'],
        as_at='2026-10-31 (retrieved; listing modified %s)' % m['modified'][:10],
        company_name=name, state='QLD', org_type=ot,
        size_indicator='UDIA QLD member (industry; activity)',
        size_indicator_value='; '.join(['industry=' + ', '.join(ind_n), 'activity=' + ', '.join(act_n)]),
        notes='UDIA QLD regions: ' + ', '.join(reg_n) + '. Directory shows no phone/email/website.')

# ---------------------------------------------------------------- UDIA VIC (HTML directory pages)
STATE_TOK = {'VIC': 'VIC', 'VICTORIA': 'VIC', 'NSW': 'NSW', 'QLD': 'QLD', 'WA': 'WA', 'SA': 'SA',
             'ACT': 'ACT', 'TAS': 'TAS', 'NT': 'NT'}
for r in json.load(open(os.path.join(RAW, 'udiavic_parsed.json'))):
    items = [a.strip() for a in r['activity'].split(',') if a.strip()]
    dev = r['category'] == 'Developer' or any(a.startswith('Developer -') for a in items)
    bld = any(a == 'Builder' or a.startswith('Building Contractor') or a == 'Contractor' or
              a in ('Roads and Drainage', 'Land Subdivision') for a in items)
    if not (dev or bld):
        continue
    if dev:
        ot = 'developer'
        if any('Community Housing' in a for a in items):
            ot = 'developer (community housing)'
    elif any(a == 'Builder' or a == 'Building Contractor - General' for a in items):
        ot = 'builder / construction'
    else:
        ot = 'civil contractor'
    loc = r['location']
    toks = loc.split()
    st, sub = '', loc
    if toks and toks[-1].upper() in STATE_TOK:
        st, sub = STATE_TOK[toks[-1].upper()], ' '.join(toks[:-1])
    pg = r['page']
    url = 'https://udiavic.com.au/members-directory/' + ('' if pg == 1 else 'page/%d/' % pg)
    add(source='UDIA Victoria members directory', source_url=url, as_at='2026-10-31 (retrieved)',
        company_name=r['name'], state=st, org_type=ot,
        size_indicator='UDIA VIC member (category; activity)',
        size_indicator_value='category=%s; activity=%s' % (r['category'], r['activity']),
        phone=r['phone'], website=r['website'], suburb=sub,
        notes=('Email shown on directory but Cloudflare-obfuscated; not decoded.' if r['email_obfuscated'] else ''))

# ---------------------------------------------------------------- UDIA NSW corporate partners
U = 'https://www.udiansw.com.au/our-corporate-partners/'
for name, web, ot, note in [
        ('Billbergia', 'https://www.billbergia.com.au/', 'developer', 'logo file Billbergia-logo'),
        ('Lendlease', 'https://www.lendlease.com/au/', 'developer / builder', 'logo file Lendlease'),
        ('Landcom', 'https://www.landcom.com.au/', 'developer (NSW government land developer)', 'logo file Landcom_Logo'),
        ('Urban Property Group', 'https://urbanpropertygroup.com.au/', 'developer', 'logo file Urban-Property-Logo'),
        ('Walker Corporation', 'https://www.walkercorp.com.au/', 'developer', 'logo file Walker...; name per link domain walkercorp.com.au'),
        ('Pacific Building Management Group (Pacific BMG)', 'https://www.pacificbmg.com.au/', 'builder / construction', 'logo file Pacific-Building-Management')]:
    add(source='UDIA NSW corporate partners page', source_url=U, as_at='2026-10-31 (retrieved)',
        company_name=name, state='NSW', org_type=ot, size_indicator='UDIA NSW membership tier',
        size_indicator_value='Corporate Partner', website=web,
        notes='Partner shown as logo+link only (no alt text); name taken from %s. UDIA NSW has no public member directory.' % note)

# ---------------------------------------------------------------- Tasmania Treasury prequalification register
TASURL = 'https://www.purchasing.tas.gov.au/winning-government-business/prequalification/building-and-construction-prequalification-register'
for name, btype, cats, exp in json.load(open(os.path.join(RAW, 'tas_rows.json'))):
    if btype != 'Contractor' or 'Building Works' not in cats:
        continue
    cl = [c.strip() for c in cats.split(',')]
    bw = [c for c in cl if c.startswith('Building Works')]
    ot = 'builder (residential)' if bw == ['Building Works – Residential'] else (
        'builder (institutional/commercial)' if 'Building Works – Residential' not in bw else 'builder (institutional/commercial + residential)')
    add(source='Tasmanian Dept of Treasury and Finance Prequalification Register (building & construction)',
        source_url=TASURL, as_at='2026-10-30 (register "current as at")', company_name=name, state='TAS',
        org_type=ot, size_indicator='TAS Treasury prequalification categories; expiry',
        size_indicator_value='%s; expires %s' % (cats, exp),
        notes='Contractor prequalified for TAS Govt building works (required for contracts >= $500,000). Register lists category only; the financial level per category is not published on the register.')

# ---------------------------------------------------------------- WA Housing Authority Builders Panel fact sheets
wa = json.load(open(os.path.join(RAW, 'wa_factsheets_parsed.json')))
REGION = {'gascoyne': 'Gascoyne', 'goldfields-esperance': 'Goldfields-Esperance', 'greatsouthern': 'Great Southern',
          'kimberley': 'Kimberley', 'metropolitan': 'Metropolitan', 'mid-west': 'Mid West', 'peel': 'Peel',
          'pilbara': 'Pilbara', 'south-west': 'South West', 'wheatbelt': 'Wheatbelt'}
agg = OrderedDict()
for fn in sorted(wa):
    regkey = re.match(r'builder-fact-sheet-(.+)-2026\.docx', fn).group(1)
    region = REGION[regkey]
    url = 'https://www.wa.gov.au/system/files/2026-07/' + fn
    mod = re.search(r'<dcterms:modified[^>]*>([^<]*)',
                    zipfile.ZipFile(os.path.join(RAW, 'wa_factsheets', fn)).read('docProps/core.xml').decode()).group(1)[:10]
    trs = [r for tb in wa[fn]['tables'] for r in tb]
    for idx, kind in ((2, 'office'), (4, 'available')):
        names, types = trs[idx][0], trs[idx][1]
        assert len(names) == len(types), fn
        for n, t in zip(names, types):
            n = re.sub(r'\s+', ' ', n).strip()
            key = re.sub(r'[^a-z0-9]', '', re.sub(r'\bpty\.?\s*ltd\.?', '', n.lower()))
            a = agg.setdefault(key, {'name': n, 'variants': set(), 'office': [], 'available': [], 'types': set(), 'urls': [], 'mod': mod})
            a['variants'].add(n)
            if len(n) > len(a['name']):
                a['name'] = n
            a[kind].append(region)
            a['types'].add(t.strip().replace('Construction Projects', 'Construction projects'))
            if url not in a['urls']:
                a['urls'].append(url)
for a in agg.values():
    primary = a['urls'][0]
    add(source='WA Housing Authority - Housing Construction and Refurbishment Builders Panel (regional builder fact sheets 2026)',
        source_url=primary, as_at='2026 fact sheets (docx modified %s)' % a['mod'], company_name=a['name'], state='WA',
        org_type='builder (residential / social housing panel)',
        size_indicator='WA Govt Builders Panel member (181-builder panel); project types',
        size_indicator_value='; '.join(sorted(a['types'])),
        notes='Office region(s): %s. Also listed as available in: %s. Sheets: %s%s' % (
            ', '.join(a['office']) or 'none listed', ', '.join(a['available']) or 'none',
            ' '.join(u.rsplit('/', 1)[1] for u in a['urls']),
            ('. Name variants across sheets: ' + ' / '.join(sorted(a['variants']))) if len(a['variants']) > 1 else ''))

# ---------------------------------------------------------------- HIA Housing 100 press releases (values quoted from articles)
H = 'https://hia.com.au/our-industry/newsroom/economic-research-and-forecasting/'
N26 = H + '2026/09/a-new-decade-a-new-name-tops-the-list-of-australias-largest-home-builders'
NSW26 = H + '2026/09/nsw-builders-remain-resilient-despite-the-challenges'
QLD26 = H + '2026/09/top-queensland-home-builders-ranked-for-202526'
TAS26 = H + '2026/09/tasmanias-largest-builders-lift-output-44-per-cent'
HUN26 = H + '2026/10/hunter-builders-strengthen-position-among-nations-largest'
N25 = H + '2025/09/hia-reveals-australias-largest-home-builders-for-202425'
WA25 = H + '2025/09/wa-deliver-as-hia-announces-top-100-australian-builders'
HUN25 = H + '2025/09/hunter-builders-cement-position-among-nations-largest'
TAS25 = H + '2025/09/home-building-heats-up-in-tassie'
BTR = 'https://www.btrnews.au/coronation-named-in-the-hia-housing-100-report/'
A26 = 'HIA Housing 100 2025/26 (released 2026-09-23)'
A25 = 'HIA Housing 100 2024/25 (released 2025-09-23)'
hia = [
    # 2025/26 national
    (N26, A26, 'Sumitomo Forestry Australia', '', 'volume builder (group)', 'national rank 1; 8,038 starts (group: Henley, Wisdom, Scott Park Group, Metricon)', 'Largest home building group 2025/26; follows acquisition of Metricon.'),
    (N26, A26, 'ABN Group', 'WA', 'volume builder', 'national rank 2; 3,764 starts', ''),
    (N26, A26, 'NEX Building Group', 'NSW', 'volume builder (group)', 'national rank 3 (up from 4th); 3,585 starts', 'State per Hunter release (trades in NSW as McDonald Jones Homes and MOJO Homes; Wilson Homes in TAS).'),
    (N26, A26, 'Summit Homes', '', 'volume builder', 'entered national top 10 for first time (exact rank not published)', 'Rose from 15th in 2023/24.'),
    (N26, A26, 'Hutchies', 'QLD', 'builder (detached + multi-unit)', 'national rank 8 (up from 14th); 3rd largest multi-unit builder with 1,907 multi-unit starts', ''),
    (N26, A26, 'Homecorp Constructions', 'QLD', 'volume builder', 'national rank 13 (up from 31st)', 'QLD rank 5 per QLD release.'),
    (N26, A26, 'Parkview Constructions', 'NSW', 'multi-unit builder', 'largest multi-unit builder nationally; 2,735 starts', 'NSW rank 1 per NSW release.'),
    (N26, A26, 'Meriton Apartments', '', 'multi-unit builder/developer', '2nd largest multi-unit builder nationally; 2,324 starts', 'Operates NSW and QLD per releases.'),
    (N26, A26, 'Metricon', '', 'volume builder', 'part of Sumitomo Forestry Australia group (group 8,038 starts, national rank 1)', 'Brand within group; brand-level figure not published.'),
    (N26, A26, 'Henley', '', 'volume builder', 'part of Sumitomo Forestry Australia group (group 8,038 starts, national rank 1)', 'Brand within group; QLD release names "Henley T/A Plantation".'),
    (N26, A26, 'Wisdom', '', 'volume builder', 'part of Sumitomo Forestry Australia group (group 8,038 starts, national rank 1)', 'Brand within group (Wisdom Homes).'),
    (N26, A26, 'Scott Park Group', 'WA', 'volume builder', 'part of Sumitomo Forestry Australia group (group 8,038 starts, national rank 1)', 'WA per 2024/25 WA release.'),
    # 2025/26 NSW
    (NSW26, A26, 'Parkview Constructions', 'NSW', 'multi-unit builder', 'NSW rank 1; 2,375 NSW starts (all multi-units)', ''),
    (NSW26, A26, 'NEX Building Group', 'NSW', 'volume builder (group)', 'NSW rank 2; 1,742 NSW starts (1,726 detached, 16 semi-detached)', ''),
    (NSW26, A26, 'Campbell Property Group', 'NSW', 'volume builder', 'NSW rank 3; 1,211 NSW starts (all detached)', ''),
    # 2025/26 QLD
    (QLD26, A26, 'Hutchies', 'QLD', 'builder (detached + multi-unit)', 'QLD rank 1; 2,205 QLD dwelling starts', ''),
    (QLD26, A26, 'Sumitomo Forestry Australia (Henley T/A Plantation, Metricon)', 'QLD', 'volume builder (group)', 'on QLD list (QLD rank not stated in release)', 'New name on QLD list after acquiring two of 2024/25 top-five QLD builders.'),
    (QLD26, A26, 'Meriton Apartments', 'QLD', 'multi-unit builder/developer', 'QLD rank 3', ''),
    (QLD26, A26, 'McNab Group', 'QLD', 'builder / developer', 'QLD rank 4', ''),
    (QLD26, A26, 'Homecorp Constructions', 'QLD', 'volume builder', 'QLD rank 5', ''),
    (QLD26, A26, 'Coral Homes', 'QLD', 'volume builder', 'QLD rank 6', ''),
    # 2025/26 TAS + Hunter
    (TAS26, A26, 'Wilson Homes', 'TAS', 'volume builder', 'largest builder in TAS; 435 TAS starts', 'Part of NEX Building Group.'),
    (HUN26, A26, 'NEX Building Group', 'NSW', 'volume builder (group)', 'national rank 3; 3,585 starts; 3,491 detached (2nd largest detached builder)', 'Trades in NSW as McDonald Jones Homes and MOJO Homes.'),
    (HUN26, A26, 'McDonald Jones Homes', 'NSW', 'volume builder', 'brand of NEX Building Group (NSW 1,742 starts)', ''),
    (HUN26, A26, 'MOJO Homes', 'NSW', 'volume builder', 'brand of NEX Building Group (NSW 1,742 starts)', ''),
    (HUN26, A26, 'Hunter Homes', 'NSW', 'volume builder', 'national rank equal 53; 245 starts; NSW rank 15', 'Heatherbrae-based.'),
    (HUN26, A26, 'Montgomery Homes', 'NSW', 'volume builder', 'national rank 80; 151 starts', 'Belmont-based.'),
    # 2024/25 edition
    (N25, A25, 'Metricon Homes', '', 'volume builder', 'national rank 1; 4,015 starts (2024/25)', 'Four states.'),
    (N25, A25, 'ABN Group', 'WA', 'volume builder', 'national rank 2; 3,530 starts (2024/25)', 'WA and VIC.'),
    (N25, A25, 'Meriton Apartments', '', 'multi-unit builder/developer', 'national rank 3; 3,029 starts (2024/25)', 'Sydney and Queensland.'),
    (WA25, A25, 'Home Group WA', 'WA', 'volume builder', 'WA rank 1; 2,243 WA starts (2024/25)', ''),
    (WA25, A25, 'ABN Group', 'WA', 'volume builder', 'WA rank 2; 1,685 WA starts (2024/25)', ''),
    (WA25, A25, 'Summit Homes Group', 'WA', 'volume builder', 'WA rank 3; 1,636 WA starts (2024/25)', ''),
    (WA25, A25, 'Scott Park Group', 'WA', 'volume builder', 'WA rank 4; 1,312 WA starts (2024/25)', ''),
    (WA25, A25, 'JWH Group', 'WA', 'volume builder', 'WA rank 5; 1,048 WA starts (2024/25)', 'Top five WA builders all in national top 15.'),
    (HUN25, A25, 'NEX Building Group', 'NSW', 'volume builder (group)', 'national rank 4; 2,898 starts (2024/25)', '#1 detached builder in NSW with 1505 starts.'),
    (HUN25, A25, 'Montgomery Homes', 'NSW', 'volume builder', 'national rank 74; 165 starts; NSW rank 18 (2024/25)', ''),
    (HUN25, A25, 'Hunter Homes', 'NSW', 'volume builder', 'national rank 83; 138 starts (2024/25)', ''),
    (TAS25, A25, 'SJM Property Developments', 'TAS', 'builder / developer', 'Housing 100 builder contributing to TAS (2024/25); rank not stated', ''),
    (TAS25, A25, 'Construct Creative Pty Ltd', 'TAS', 'builder', 'Housing 100 builder contributing to TAS (2024/25); rank not stated', ''),
    (TAS25, A25, 'Hotondo Building Pty Ltd', 'TAS', 'volume builder (franchise)', 'Housing 100 builder contributing to TAS (2024/25); rank not stated', ''),
    (TAS25, A25, 'Cavalier Homes', 'TAS', 'volume builder (franchise)', 'Housing 100 builder contributing to TAS (2024/25); rank not stated', ''),
    (BTR, A25 + '; article 2025-10-10', 'Coronation Property', 'NSW', 'developer / multi-unit builder', 'national rank 9; NSW rank 2; 3rd apartment builder; 161% y/y growth (2024/25)', 'Source is BTR News article reporting the HIA ranking.'),
]
for url, asat, name, st, ot, val, note in hia:
    add(source='HIA-COLORBOND steel Housing 100 (HIA press release)' if 'hia.com.au' in url else 'BTR News (reporting HIA Housing 100)',
        source_url=url, as_at=asat, company_name=name, state=st, org_type=ot,
        size_indicator='HIA Housing 100 rank / dwelling starts', size_indicator_value=val,
        notes=(note + ' Full Housing 100 list with contacts is a paid HIA report; only names in public releases captured.').strip())

# ---------------------------------------------------------------- Renewal SA Builders Panel
RS = 'https://renewalsa.sa.gov.au/news/momentum-building-for-renewal-sas-builders-panel'
for name, note in [('Burbank', 'First on site at Playford Alive (9 homes).'),
                   ('Brazzale Constructions', '11 homes at Playford Alive from June 2025.'),
                   ('Metricon', '5 homes at Playford Alive (pending DA at publication).')]:
    add(source='Renewal SA news - Builders Panel', source_url=RS, as_at='2025-08-01 (article; updated 2025-08-25)',
        company_name=name, state='SA', org_type='volume builder', size_indicator='Renewal SA Builders Panel member',
        size_indicator_value='member of 15-company panel (est. July 2024, 3-year agreements)',
        notes=note + ' Only 3 of 15 panel members are named publicly.')

# ---------------------------------------------------------------- The Urban Developer (developer outlook speakers)
TUD = 'https://www.theurbandeveloper.com/articles/meet-the-developers-shaping-the-outlook-for-2026'
for name, st, ot, ind, val in [
        ('McNab Group', 'QLD', 'builder / developer', 'annual turnover; staff', '>$1 billion annual turnover; >700 employees'),
        ('Sherpa Group', 'QLD', 'developer', 'development pipeline', '$1 billion development pipeline (Brisbane and Gold Coast)'),
        ('Haben', '', 'developer (retail)', 'portfolio size', '$3 billion retail portfolio across Australia'),
        ('Goldfields', '', 'developer', 'qualitative', 'described as one of Australia\'s leading private development groups'),
        ('P&N Sleiman Group', 'NSW', 'developer', 'track record', 'more than 20 landmark developments (Sydney)'),
        ('TOGA', '', 'developer / builder', 'qualitative', 'described as one of Australia\'s leading privately owned developers, builders and hoteliers'),
        ('Henny', 'VIC', 'commercial builder', 'qualitative', 'commercial building group founded 2018 (Melbourne)'),
        ('Prime Edition', 'VIC', 'developer (luxury residential)', 'qualitative', 'develops luxury residential projects in Melbourne'),
        ('Wickton', '', 'developer', 'qualitative', 'leads complex multi-stakeholder developments'),
        ('Traders In Purple', '', 'developer', 'qualitative', 'large-scale residential and mixed-use developments')]:
    add(source='The Urban Developer - 2026 Developer Outlook speaker profiles', source_url=TUD, as_at='2026-01-20 (article)',
        company_name=name, state=st, org_type=ot, size_indicator=ind, size_indicator_value=val,
        notes='Not a ranking; profile text from an event announcement. State only where the text names the city.')

with open(OUT, 'w', newline='', encoding='utf-8') as fh:
    w = csv.DictWriter(fh, fieldnames=COLS)
    w.writeheader()
    w.writerows(rows)
from collections import Counter
print(len(rows))
for k, v in Counter(r['source'] for r in rows).most_common():
    print(v, k)
