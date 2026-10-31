"""Parse downloaded MBA directory files into /tmp/leads/agents/mba/mba_members.csv.
Run with: python3 -I build_csv.py"""
import sys, re, html, json, glob, csv, os
from collections import defaultdict, Counter
sys.path.insert(0, '/tmp/leads/agents/mba/scripts')
import parse_sa

RAW = '/tmp/leads/agents/mba/raw'
OUT = '/tmp/leads/agents/mba/mba_members.csv'
OUT_X = '/tmp/leads/agents/mba/mba_members_excluded_nonbuilders.csv'
COLS = ['source', 'source_url', 'business_name', 'trading_name', 'abn', 'licence_number', 'address', 'suburb',
        'state', 'postcode', 'phone', 'email', 'website', 'member_categories', 'membership_type', 'notes']
STATES = r'(NSW|VIC|QLD|SA|WA|TAS|ACT|NT)'


def txt(x):
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<svg.*?</svg>|<[^>]+>', ' ', x, flags=re.S))).strip()


def tidy_case(s):
    s = (s or '').strip()
    return s.title() if s.isupper() and len(s) > 3 else s


def pc_state(pc):
    try:
        n = int(pc)
    except (TypeError, ValueError):
        return ''
    if 800 <= n <= 999: return 'NT'
    if 200 <= n <= 299 or 2600 <= n <= 2618 or 2900 <= n <= 2920: return 'ACT'
    if 1000 <= n <= 2999: return 'NSW'
    if 3000 <= n <= 3999 or 8000 <= n <= 8999: return 'VIC'
    if 4000 <= n <= 4999 or 9000 <= n <= 9999: return 'QLD'
    if 5000 <= n <= 5999: return 'SA'
    if 6000 <= n <= 6999: return 'WA'
    if 7000 <= n <= 7999: return 'TAS'
    return ''


STATE_NAMES = {'new south wales': 'NSW', 'victoria': 'VIC', 'queensland': 'QLD', 'south australia': 'SA',
               'western australia': 'WA', 'tasmania': 'TAS', 'australian capital territory': 'ACT', 'northern territory': 'NT'}


def split_addr(a):
    """'street\nSuburb NT 0828' / 'street, Suburb NT 0828' / 'street, Suburb 0829' -> (street, suburb, state, pc).
    Only splits on an explicit newline/comma delimiter; otherwise returns the whole string as address."""
    a = (a or '').strip()
    if not a:
        return '', '', '', ''
    for full, ab in STATE_NAMES.items():
        a = re.sub(r'\b' + full + r'\b', ab, a, flags=re.I)
    m = re.search(r'[\n,]\s*([^\n,]*?)\s*,?\s+' + STATES + r'\.?,?\s+(\d{4})\s*$', a, flags=re.I)
    if m:
        street = a[:m.start()].strip(' ,\n')
        return re.sub(r'\s*\n\s*', ', ', street), tidy_case(m.group(1).strip(' ,')), m.group(2).upper(), m.group(3)
    m = re.search(r'[\n,]\s*([A-Za-z][A-Za-z \'-]*?)\s+(\d{4})\s*$', a)
    if m:
        street = a[:m.start()].strip(' ,\n')
        return re.sub(r'\s*\n\s*', ', ', street), tidy_case(m.group(1)), pc_state(m.group(2)), m.group(2)
    return re.sub(r'\s*\n\s*', ', ', a), '', '', ''


def clean_site(u):
    u = html.unescape((u or '').strip())
    if not u or re.match(r'^(https?://)?[^/]*@', u):
        return ''
    if '?' in u:  # drop tracking params only
        base, q = u.split('?', 1)
        q = '&'.join(x for x in q.split('&') if x and not x.lower().startswith('utm_'))
        u = base + ('?' + q if q else '')
    return u


def row(**kw):
    r = {c: '' for c in COLS}
    for k, v in kw.items():
        if k in r:
            r[k] = re.sub(r'\s+', ' ', str(v or '')).strip()
    return r

# ---------------- VIC ----------------
VIC_AREAS = {}

def parse_vic():
    out = []
    s = open(f'{RAW}/vic/find.html', encoding='utf-8').read()
    for v, lab in re.findall(r'name="service_area\[\]" value="([^"]+)">\s*<span>([^<]+)</span>', s):
        VIC_AREAS[v] = html.unescape(lab).strip()
    cards = [c for f in sorted(glob.glob(f'{RAW}/vic/list_p*.json')) for c in json.load(open(f))['data']['cards']]
    for c in cards:
        contact = ''
        pf = f'{RAW}/vic/profiles/{c["slug"]}.html'
        if os.path.exists(pf):
            ps = open(pf, encoding='utf-8').read()
            m = re.search(r'dir-single__direct-contact-name-main">(.*?)</span>\s*(?:<span class="dir-single__direct-contact-name-role">(.*?)</span>)?', ps, flags=re.S)
            if m:
                contact = txt(m.group(1)) + (f' ({txt(m.group(2))})' if m.group(2) and txt(m.group(2)) else '')
        pc = c.get('postcode') or ''
        st = pc_state(pc) or 'VIC'
        areas = [VIC_AREAS.get(a, a.replace('_', ' ').title()) for a in c.get('service_areas') or []]
        notes = []
        if contact: notes.append('Contact: ' + contact)
        if c.get('joined_date'): notes.append('Member since ' + c['joined_date'])
        if c.get('company_size_label'): notes.append('Size: ' + c['company_size_label'])
        if areas: notes.append('Service areas: ' + ', '.join(areas))
        if c.get('tier'): notes.append('Directory tier: ' + c['tier'])
        if c.get('has_awards'): notes.append('Has awards')
        cats = ([c['work_type']] if c.get('work_type') else []) + list(c.get('trade_categories') or [])
        out.append(row(source='Master Builders VIC', source_url=c['url'], business_name=html.unescape(c['title']),
                       address=c['address'] if c.get('show_full_address') else '', suburb=tidy_case(c.get('suburb')),
                       state=st, postcode=pc, phone=c.get('contact_phone'), email=c.get('contact_email'),
                       website=clean_site(c.get('website_url')), member_categories='; '.join(cats), notes='; '.join(notes)))
        out[-1]['_keep'] = True  # directory is "Find a Master Builder" (builders only)
    return out

# ---------------- SA ----------------
SA_KEEP = {'New Homes', 'Commercial Builder', 'Renovations', 'Additions & Extensions', 'Bathroom Renovations'}

def parse_sa_rows():
    out = []
    for r in parse_sa.parse():
        cats = set(x.strip() for x in r['member_categories'].split(';') if x.strip())
        rr = row(**r)
        rr['_keep'] = bool(cats & SA_KEEP)
        out.append(rr)
    return out

# ---------------- WA ----------------

def parse_wa():
    s = open(f'{RAW}/wa/find.html', encoding='utf-8').read()
    catmap = json.loads(re.search(r'var pwdFindAMember = (\{.*?\});\s*\n', s, flags=re.S).group(1))['categories']
    mtype, mcats, xtype, allm = {}, defaultdict(list), {}, set()
    for f in sorted(glob.glob(f'{RAW}/wa/lists/*.html')):
        tag = os.path.basename(f).rsplit('_p', 1)[0]
        body = open(f, encoding='utf-8').read()
        urls = re.findall(r'<h4 class="pwd-find-a-member__company">\s*<a href="([^"]+)"', body)
        if tag.startswith('type_'):
            t = tag[5:]
            for u in urls: mtype[u] = t
        elif tag.startswith('cat_'):
            t, slug = tag[4:].split('__')
            lab = catmap[t].get(slug, slug)
            for u in urls:
                if lab not in mcats[u]: mcats[u].append(lab)
        elif tag.startswith('xtype_'):
            for u in urls: xtype.setdefault(u, tag[6:])
        elif tag == 'all':
            allm.update(urls)
    # members in the unfiltered list with no member type at all (not labelled builder or non-builder)
    for u in sorted(allm - set(mtype) - set(xtype)):
        mtype[u] = ''
    labels = {'residential-builder': 'Residential Builder', 'commercial-builder': 'Commercial Builder'}
    out, unknown = [], Counter()
    for u, t in mtype.items():
        slug = u.rstrip('/').rsplit('/', 1)[-1]
        pf = f'{RAW}/wa/profiles/{slug}.html'
        if not os.path.exists(pf):
            continue
        ps = open(pf, encoding='utf-8').read()
        name = txt(re.search(r'<h1 class="w-text[^"]*"><span class="w-text-h"><span class="w-text-value">(.*?)</span>', ps, flags=re.S).group(1))
        bi = ps.find('class="pwd-member-single height_large') if 'class="pwd-member-single height_large' in ps else ps.find('wpb_row pwd-member-single ')
        blk = ps[bi:ps.find('pwd-member-single__actions', bi)]
        meta = {}
        for li in re.findall(r'<li>(.*?)</li>', blk[:blk.find('</ul>') + 5], flags=re.S):
            m = re.match(r'\s*<strong>(.*?)</strong>(.*)', li, flags=re.S)
            if m:
                meta[txt(m.group(1)).rstrip(':').strip()] = txt(m.group(2))
            elif txt(li):
                meta['_extra'] = (meta.get('_extra', '') + ' | ' + txt(li)).strip(' |')
        links = re.findall(r'<a href="([^"]+)"[^>]*>', blk[blk.find('</ul>'):] if '</ul>' in blk else '')
        site = ''
        for h in links:
            h = html.unescape(h)
            if h.startswith('mailto:'):
                meta.setdefault('E', h[7:])
            elif h.startswith('http') and 'mbawa.com' not in h:
                site = site or h
        desc = txt(re.search(r'pwd-member-single__description md-mb"><div class="wpb_wrapper">(.*?)</div></div>', ps, flags=re.S).group(1)) if 'pwd-member-single__description' in ps else ''
        secs = [txt(x) for x in re.findall(r'pwd-member-single__section md-mb"><div class="wpb_wrapper">(.*?)</div></div>', ps, flags=re.S)]
        for k in meta:
            if k not in ('Builders Reg No', 'Areas', 'Contact', 'T', 'E', 'M', 'A', 'Address', '_extra', 'F'):
                unknown[k] += 1
        address = meta.get('Address') or meta.get('A') or ''
        street, sub, st2, pc = split_addr(address)
        email = meta.get('E', '')
        m = re.search(r'[\w.+-]+@[\w-]+(?:\.[\w-]+)+', meta.get('_extra', ''))
        if not email and m: email = m.group(0)
        notes = []
        if not t: notes.append('No member type shown in directory')
        if meta.get('Contact'): notes.append('Contact: ' + meta['Contact'])
        if meta.get('Areas'): notes.append('Areas: ' + meta['Areas'])
        if meta.get('M'): notes.append('Mobile: ' + meta['M'])
        if desc: notes.append('About: ' + desc[:300])
        extra_sec = ' | '.join(x for x in secs if x)
        if extra_sec: notes.append(extra_sec[:300])
        r = row(source='Master Builders WA', source_url=u, business_name=name, licence_number=meta.get('Builders Reg No', ''),
                address=street, suburb=sub, state=(st2 or pc_state(pc) or 'WA'), postcode=pc,
                phone=meta.get('T', '') or meta.get('M', ''), email=email, website=clean_site(site),
                member_categories='; '.join(mcats.get(u, []) or ([labels[t]] if t in labels else [])), membership_type=labels.get(t, t), notes='; '.join(notes))
        r['_keep'] = True
        out.append(r)
    if unknown: print('WA unknown meta labels:', unknown.most_common(), file=sys.stderr)
    return out

# ---------------- ACT ----------------
ACT_BUILDER_CATS = {'Contract Homes', 'Contract Homes over $500,000', 'Contract Homes under $500,000', 'Custom Built Homes',
    'Custom Design Homes', 'Display Homes', 'Display Homes over $500,000', 'Display Homes under $500,000', 'Project Homes',
    'Project Homes over $500,000', 'Project Homes under $500,000', 'New Homes', 'Extensions & Renovations',
    'Renovations and Remodelling', 'Remodelling & Renovations', 'Knockdown rebuilds', 'Dual Occupancy Residence',
    'Multi-Unit / Medium Density', 'Multi-storey units', 'Multi-Level Accommodation', 'Design and Construct',
    'Colonial/ Federation Homes', 'Transportable/Kit Homes', 'Second Residents/Granny Flats', 'Lump Sum Contracting',
    'Commercial Office Fitouts', 'Office/ Retail Fitout', 'Office Fit-outs', 'Factories & Warehouses', 'Shops & Hotels',
    'Health Facilities', 'Education Facilities', 'Aged Care/Retirement Facilities', 'Heritage Restoration'}

def parse_act():
    s = open(f'{RAW}/act/find.html', encoding='utf-8').read()
    f = re.findall(r'<form action="" class="filter-box">.*?</form>', s, flags=re.S)[0]
    sel = dict(re.findall(r'<select name="([^"]+)">(.*?)</select>', f, flags=re.S))
    tlab = {v: html.unescape(l) for v, l in re.findall(r'<option[^>]*value="([^"]*)"[^>]*>([^<]*)', sel['builder-type']) if v}
    clab = {v: html.unescape(l) for v, l in re.findall(r'<option[^>]*value="([^"]*)"[^>]*>([^<]*)', sel['builder-category']) if v}

    def items(body):
        for it in re.findall(r'<div class="search-builders-item">(.*?)</ul>\s*</div>', body, flags=re.S):
            name = txt(re.search(r'<h4 class="h4 item-title">(.*?)</h4>', it, flags=re.S).group(1))
            ph = re.search(r'href="tel:[^"]*">(.*?)</a>', it, flags=re.S)
            em = re.search(r'href="mailto:([^"]*)"', it)
            ws = re.search(r"<strong>Website:</strong>\s*<a[^>]*href='([^']*)'", it) or re.search(r'<strong>Website:</strong>\s*<a[^>]*href="([^"]*)"', it)
            yield (name, txt(ph.group(1)) if ph else '', html.unescape(em.group(1)).strip() if em else '', ws.group(1).strip() if ws else '')

    def key(t):
        return (t[0].lower(), re.sub(r'\D', '', t[1]), t[2].lower())
    recs, srcurl = {}, {}
    types, cats = defaultdict(list), defaultdict(list)
    for fn in sorted(glob.glob(f'{RAW}/act/lists/*.html')):
        tag = os.path.basename(fn).rsplit('_p', 1)[0]
        body = open(fn, encoding='utf-8').read()
        url = open(fn + '.url').read().strip() if os.path.exists(fn + '.url') else 'https://mba.org.au/resources/find-a-member/'
        for t in items(body):
            k = key(t)
            if tag == 'all':
                recs.setdefault(k, t); srcurl.setdefault(k, url)
            elif tag.startswith('type_'):
                lab = tlab.get(tag[5:], tag[5:])
                if lab not in types[k]: types[k].append(lab)
            elif tag.startswith('cat_'):
                lab = clab.get(tag[4:], tag[4:])
                if lab not in cats[k]: cats[k].append(lab)
            if k not in recs:  # seen only in filtered lists
                recs[k] = t; srcurl[k] = url
    out = []
    builder_types = {'Residential Builder', 'Commercial Builder'}
    dev_cats = {'Project Management', 'Property Development', 'Land Development'}
    for k, t in recs.items():
        ty, ca = types.get(k, []), cats.get(k, [])
        if set(ty) & builder_types or set(ca) & dev_cats:
            keep = True
        elif not ty:  # no member type shown: decide on builder-type categories (keep if nothing shown at all)
            keep = (not ca) or bool(set(ca) & ACT_BUILDER_CATS)
        else:
            keep = False
        r = row(source='Master Builders ACT', source_url=srcurl[k], business_name=t[0], phone=t[1], email=t[2],
                website=clean_site(t[3]), member_categories='; '.join(ca), membership_type='; '.join(ty),
                notes='No address/state shown in directory' + ('' if (ty or ca) else '; no type or category shown'))
        r['_keep'] = keep
        out.append(r)
    return out

# ---------------- NT ----------------

def parse_nt():
    s = open(f'{RAW}/nt/find.html', encoding='utf-8').read()
    terms = {t['slug']: html.unescape(t['name']) for t in json.load(open(f'{RAW}/nt/tax_business_category.json'))}
    rest = {x['id']: x for x in json.load(open(f'{RAW}/nt/businesses_rest.json'))}
    starts = [m for m in re.finditer(r'<div [^>]*class="(elementor elementor-7052 e-loop-item e-loop-item-(\d+)[^"]*)"', s)]
    out = []
    for n, m in enumerate(starts):
        seg = s[m.start(): starts[n + 1].start() if n + 1 < len(starts) else len(s)]
        pid = int(m.group(2))
        cats = [terms.get(c[len('business_category-'):], c) for c in m.group(1).split() if c.startswith('business_category-')]
        name = txt(re.search(r'elementor-element-54d31842.*?<h\d[^>]*>(.*?)</h\d>', seg, flags=re.S).group(1))
        w = seg[seg.find('elementor-element-6972d191'):seg.find('elementor-element-338a3a04')]
        f = {}
        for li in re.findall(r'<li class="elementor-icon-list-item[^"]*"[^>]*>(.*?)</li>', w, flags=re.S):
            icon = ' '.join(re.findall(r'class="(?:fas|far|fab) ([^"]*)"', li))
            tm = re.search(r'elementor-icon-list-text">(.*?)</span>', li, flags=re.S)
            raw = html.unescape(re.sub(r'<br\s*/?>', '\n', tm.group(1))) if tm else ''
            raw = re.sub(r'<[^>]+>', '', raw).strip()
            if raw: f[icon] = raw
        ws = re.search(r'elementor-element-5f2ab924.*?<a[^>]*href="([^"]*)"', seg, flags=re.S)
        site = html.unescape(ws.group(1)) if ws else ''
        street, sub, st, pc = split_addr(f.get('fa-map-marker-alt', ''))
        notes = []
        if f.get('fa-map'): notes.append('Region: ' + f['fa-map'])
        if f.get('fa-city'): notes.append(f['fa-city'])
        if pid in rest: notes.append('Profile: ' + rest[pid]['link'])
        keep = bool(set(cats) & {'Commercial Contractor/Builder', 'Residential Housing Contractor/Builder'}) or not cats
        if not cats: notes.append('No category shown in directory')
        r = row(source='Master Builders NT', source_url='https://mbnt.com.au/find-a-master-builder-member/', business_name=name,
                address=street, suburb=sub, state=st or pc_state(pc) or 'NT', postcode=pc,
                phone=f.get('fa-phone', ''), email=f.get('fa-envelope', ''), website=clean_site(site),
                member_categories='; '.join(cats), notes='; '.join(notes))
        r['_keep'] = keep
        out.append(r)
    return out


def main():
    allrows = []
    for fn in (parse_vic, parse_sa_rows, parse_wa, parse_act, parse_nt):
        rs = fn()
        print(fn.__name__, len(rs), 'keep', sum(r['_keep'] for r in rs), file=sys.stderr)
        allrows += rs
    keep = [r for r in allrows if r['_keep']]
    drop = [r for r in allrows if not r['_keep']]
    for path, rs in ((OUT, keep), (OUT_X, drop)):
        with open(path, 'w', newline='', encoding='utf-8') as fh:
            w = csv.DictWriter(fh, fieldnames=COLS, extrasaction='ignore')
            w.writeheader()
            for r in rs:
                w.writerow(r)
    print('written', len(keep), 'excluded', len(drop), file=sys.stderr)
    print(Counter(r['source'] for r in keep), file=sys.stderr)

if __name__ == '__main__':
    main()
