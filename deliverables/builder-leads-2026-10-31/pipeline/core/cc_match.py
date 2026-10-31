# Common Crawl discovery: match each lead's distinctive name tokens against the ~1.15M real .au domains in the
# Common Crawl web graph (cc-main-2026-aug-sep-oct). Produces ranked candidate domains per lead; the crawler then
# verifies each candidate (ABN on site, or full name + state) before taking anything from it.
import json, re, math, collections, sys, ahocorasick, html as H
W = '/tmp/leads/work'
GEN = {'CONSTRUCTIONS', 'CONSTRUCTION', 'BUILDING', 'BUILDERS', 'BUILDER', 'HOMES', 'HOME', 'GROUP', 'PROJECTS', 'PROJECT', 'SERVICES', 'SERVICE',
       'DEVELOPMENTS', 'DEVELOPMENT', 'PROPERTY', 'PROPERTIES', 'CONTRACTING', 'CONTRACTORS', 'CONTRACTOR', 'ENTERPRISES', 'HOLDINGS', 'INVESTMENTS',
       'CONSTRUCT', 'BUILD', 'BUILT', 'SOLUTIONS', 'INDUSTRIES', 'AND', 'MANAGEMENT', 'COMMERCIAL', 'RESIDENTIAL', 'CUSTOM', 'QUALITY', 'PTY', 'LTD',
       'LIMITED', 'TRUSTEE', 'TRUST', 'FAMILY', 'UNIT', 'DISCRETIONARY', 'THE', 'FOR', 'AUSTRALIA', 'AUST', 'AUSTRALIAN', 'QLD', 'VIC', 'NSW', 'TAS',
       'ACT', 'WEST', 'NORTH', 'SOUTH', 'EAST', 'COAST', 'CITY', 'GOLD', 'SUNSHINE', 'NATIONAL', 'GENERAL', 'MAINTENANCE', 'RENOVATIONS', 'CARPENTRY',
       'JOINERY', 'PLUMBING', 'ELECTRICAL', 'ROOFING', 'CONCRETE', 'CIVIL', 'DESIGN', 'DESIGNS', 'LIVING', 'CORP', 'CORPORATION', 'COMPANY', 'PARTNERS',
       'ASSOCIATES', 'INTERNATIONAL', 'GLOBAL', 'TOTAL', 'BEST', 'PREMIER', 'PREMIUM', 'ELITE', 'PRESTIGE', 'MASTER', 'CLASSIC', 'MODERN', 'NEW',
       'TRADES', 'TRADE', 'WORKS', 'SYSTEMS', 'TECH', 'ONE', 'FIRST', 'GREEN', 'BLUE', 'RED', 'BLACK', 'WHITE', 'STAR', 'ROYAL', 'UNITED', 'ALLIANCE'}
BKW = re.compile(r'(build|construct|homes?|projects?|develop|carpent|renovat|reno|joiner|struct|property|properties|living|designs?|contract|interiors?|fitout|extensions?)')
STA = {'QLD': 'qld', 'VIC': 'vic', 'NSW': 'nsw', 'WA': 'wa', 'SA': 'sa', 'TAS': 'tas', 'ACT': 'act', 'NT': 'nt'}
# ---- domains ----
labels = {}  # label -> list of full domains
for l in open('/tmp/leads/raw/cc/au_domains.tsv'):
    _, rev, _n = l.rstrip('\n').split('\t')
    p = rev.split('.')
    if p[0] != 'au': continue
    if len(p) == 3 and p[1] in ('com', 'net'): lab, dom = p[2], f'{p[2]}.{p[1]}.au'
    elif len(p) == 2: lab, dom = p[1], f'{p[1]}.au'
    else: continue
    labels.setdefault(lab, []).append(dom)
print('labels', len(labels), flush=True)
# ---- leads still without a website ----
tried = set(l.split('\t', 1)[0].removeprefix('www.') for l in open(f'{W}/v3/dns_all.tsv'))
leads = [json.loads(l) for l in open(f'{W}/v3/in_disc.jsonl')] + [json.loads(l) for l in open(f'{W}/v3/in_ind.jsonl')]
found = set()
for f in (f'{W}/v3/out_disc.jsonl', f'{W}/v3/out_ind.jsonl'):
    for l in open(f):
        j = json.loads(l)
        if j.get('website'): found.add(j['abn'])
leads = [r for r in leads if r['abn'] not in found and r['names']]
print('leads to match', len(leads), flush=True)
def toks(n):
    n = H.unescape(n).upper(); n = re.sub(r'\(.*?\)', ' ', n).replace('&', ' AND ')
    return [w for w in re.findall(r'[A-Z0-9]+', n) if len(w) >= 4 and w not in GEN and not w.isdigit()]
lead_toks = {}
for r in leads:
    t = []
    for n in r['names'][:8]:
        for w in toks(n):
            if w not in t: t.append(w)
    if t: lead_toks[r['abn']] = t
A = ahocorasick.Automaton()
allt = {w.lower() for t in lead_toks.values() for w in t}
for w in allt: A.add_word(w, w)
A.make_automaton()
hits = collections.defaultdict(set); freq = collections.Counter()
for lab in labels:
    seen = set(w for _, w in A.iter(lab))
    for w in seen: hits[w].add(lab); freq[w] += 1
print('tokens', len(allt), 'with domain hits', len(hits), flush=True)
out = open(f'{W}/v4/cc_candidates.jsonl', 'w'); n_c = 0
for r in leads:
    t = [w.lower() for w in lead_toks.get(r['abn'], [])]
    if not t: continue
    cands = collections.Counter()
    for w in t:
        if freq[w] > 400: continue  # too common to be distinctive
        for lab in hits.get(w, ()):
            cands[lab] += 1
    scored = []
    for lab, k in cands.items():
        matched = [w for w in t if w in lab]
        cover = sum(len(w) for w in matched) / len(lab)
        rest = lab
        for w in sorted(matched, key=len, reverse=True): rest = rest.replace(w, '')
        rest_ok = (rest == '' or BKW.fullmatch(rest) or BKW.search(rest) and len(rest) <= 14 or any(rest.strip('-') == s for s in STA.values()))
        idf = sum(math.log(1 + 400 / (1 + freq[w])) for w in matched)
        sc = idf * (0.5 + cover) + (1.0 if BKW.search(lab) else 0) + (0.5 if any(STA.get(s, '#') in lab for s in r['states']) else 0)
        if (len(matched) >= 2 or cover >= 0.45) and rest_ok and len(lab) <= 40:
            for dom in labels[lab]:
                if dom not in tried: scored.append((sc, dom))
    scored.sort(reverse=True)
    if scored:
        n_c += 1
        out.write(json.dumps(dict(abn=r['abn'], names=r['names'], states=r['states'], ind=r.get('ind', False), person=r.get('person'),
                                  candidates=[d for _, d in scored[:4]])) + '\n')
print('leads with candidates', n_c)
