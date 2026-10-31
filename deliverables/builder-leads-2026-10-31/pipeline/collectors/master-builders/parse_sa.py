import re, html, json, glob, os

R = '/tmp/leads/agents/mba/raw/sa'
BUILDER_CATS = {'New Homes', 'Commercial Builder', 'Renovations', 'Additions & Extensions', 'Bathroom Renovations',
                'Sheds', 'Pergolas', 'Verandahs & Carports'}


def txt(x):
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<svg.*?</svg>|<[^>]+>', ' ', x, flags=re.S))).strip()


def parse():
    items = []
    for f in sorted(glob.glob(f'{R}/builder_rest_p*.json')):
        items += json.load(open(f))
    terms = {}
    for f in glob.glob(f'{R}/tax_*.json'):
        for t in json.load(open(f)):
            terms[t['id']] = html.unescape(t['name'])
    rows = []
    for it in items:
        p = f'{R}/profiles/{it["id"]}.html'
        s = open(p, encoding='utf-8').read()
        i = s.find('elementor-location-single'); j = s.find('elementor-location-footer')
        seg = s[i:j]
        rec = dict(phone='', email='', licence='', website='', suburb='')
        w = seg.find('elementor-widget-icon-list')
        wend = seg.find('elementor-widget-text-editor', w)
        for li in re.findall(r'<li class="elementor-icon-list-item[^"]*">(.*?)</li>', seg[w:wend], flags=re.S):
            icon = ' '.join(re.findall(r'class="e-font-icon-svg ([^"]*)"', li))
            hrefs = re.findall(r'href="([^"]*)"', li)
            t = txt(li)
            if not t:
                continue
            if 'phone' in icon:
                rec['phone'] = t
            elif 'envelope' in icon:
                rec['email'] = t
            elif 'dot-circle' in icon:
                rec['licence'] = t
            elif 'internet-explorer' in icon or 'globe' in icon:
                h = html.unescape(hrefs[0]) if hrefs else t
                rec['website'] = h if h.startswith('http') else t
            elif 'location' in icon or 'map' in icon:
                rec['suburb'] = t
        title = txt(re.search(r'theme-post-title.*?<h[1-6][^>]*>(.*?)</h[1-6]>', seg, flags=re.S).group(1))
        cats = [terms.get(c, '') for c in it.get('builders-category', [])]
        subs = [terms.get(c, '') for c in it.get('builders-suburb', [])]
        about = txt(it['content']['rendered'])
        rows.append(dict(source='Master Builders SA', source_url=it['link'], business_name=title,
                         licence_number=rec['licence'], suburb=rec['suburb'] or '; '.join(subs), state='SA',
                         phone=rec['phone'], email=rec['email'], website=rec['website'],
                         member_categories='; '.join(c for c in cats if c),
                         notes=('About: ' + about[:300]) if about else '',
                         _keep=(not cats) or bool(set(cats) & BUILDER_CATS)))
    return rows

if __name__ == '__main__':
    from collections import Counter
    rows = parse()
    print(len(rows), sum(r['_keep'] for r in rows))
    print(Counter(r['member_categories'] for r in rows).most_common(40))
    for r in rows[:4]:
        print(r)
    print(Counter(bool(r[k]) for r in rows for k in ['phone']), Counter(bool(r['email']) for r in rows), Counter(bool(r['licence_number']) for r in rows), Counter(bool(r['website']) for r in rows))
