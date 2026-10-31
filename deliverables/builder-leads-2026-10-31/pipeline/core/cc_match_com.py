# Same as cc_match.py, but against .com domains whose label contains a building word (Common Crawl domain list).
import json, re, math, collections, ahocorasick, importlib.util, sys
spec = importlib.util.spec_from_file_location('ccm', '/tmp/leads/scripts/cc_match.py')
src = open('/tmp/leads/scripts/cc_match.py').read()
# reuse token rules without re-running the .au pass
GEN = eval(re.search(r'GEN = (\{.*?\})\n', src, re.S).group(1)); BKW = re.compile(r'(build|construct|homes?|projects?|develop|carpent|renovat|reno|joiner|struct|property|properties|living|designs?|contract|interiors?|fitout|extensions?)')
import html as H
W = '/tmp/leads/work'
labels = {}
for l in open('/tmp/leads/raw/cc/com_build_domains.tsv'):
    _, rev, _n = l.rstrip('\n').split('\t'); p = rev.split('.')
    if len(p) == 2: labels.setdefault(p[1], []).append(p[1] + '.com')
print('com labels', len(labels), flush=True)
tried = set(l.split('\t', 1)[0].removeprefix('www.') for l in open(f'{W}/v3/dns_all.tsv'))
leads = [json.loads(l) for l in open(f'{W}/v3/in_disc.jsonl')] + [json.loads(l) for l in open(f'{W}/v3/in_ind.jsonl')]
found = set()
for f in (f'{W}/v3/out_disc.jsonl', f'{W}/v3/out_ind.jsonl', f'{W}/v4/out_cc.jsonl'):
    for l in open(f):
        j = json.loads(l)
        if j.get('website'): found.add(j['abn'])
leads = [r for r in leads if r['abn'] not in found and r['names']]
def toks(n):
    n = H.unescape(n).upper(); n = re.sub(r'\(.*?\)', ' ', n).replace('&', ' AND ')
    return [w for w in re.findall(r'[A-Z0-9]+', n) if len(w) >= 4 and w not in GEN and not w.isdigit()]
lead_toks = {}
for r in leads:
    t = []
    for n in r['names'][:8]:
        for w in toks(n):
            if w not in t: t.append(w)
    if t: lead_toks[r['abn']] = [w.lower() for w in t]
A = ahocorasick.Automaton()
for w in {w for t in lead_toks.values() for w in t}: A.add_word(w, w)
A.make_automaton()
hits = collections.defaultdict(set); freq = collections.Counter()
for lab in labels:
    for w in set(w for _, w in A.iter(lab)): hits[w].add(lab); freq[w] += 1
out = open(f'{W}/v4/cc_candidates_com.jsonl', 'w'); n = 0
for r in leads:
    t = lead_toks.get(r['abn'], [])
    sc = []
    for lab in {lab for w in t if freq[w] <= 150 for lab in hits.get(w, ())}:
        matched = [w for w in t if w in lab]; rest = lab
        for w in sorted(matched, key=len, reverse=True): rest = rest.replace(w, '')
        rest = rest.replace('-', '')
        if not (BKW.fullmatch(rest) or (BKW.search(rest) and len(rest) <= 16)): continue
        cover = sum(len(w) for w in matched) / len(lab)
        if cover < 0.35 and len(matched) < 2: continue
        s = sum(math.log(1 + 150 / (1 + freq[w])) for w in matched) * (0.5 + cover)
        for d in labels[lab]:
            if d not in tried: sc.append((s, d))
    sc.sort(reverse=True)
    if sc:
        n += 1; out.write(json.dumps(dict(abn=r['abn'], names=r['names'], states=r['states'], ind=r.get('ind', False), person=r.get('person'), candidates=[d for _, d in sc[:3]])) + '\n')
print('leads with .com candidates', n)
