# Keep .com candidates only where a matched name token is distinctive (rare in English: a surname or brand) or 2+ tokens match.
import json, re, html as H
from wordfreq import zipf_frequency as z
src = open('/tmp/leads/scripts/cc_match.py').read(); GEN = eval(re.search(r'GEN = (\{.*?\})\n', src, re.S).group(1))
def toks(n):
    n = H.unescape(n).upper(); n = re.sub(r'\(.*?\)', ' ', n).replace('&', ' AND ')
    return [w.lower() for w in re.findall(r'[A-Z0-9]+', n) if len(w) >= 4 and w not in GEN and not w.isdigit()]
out = open('/tmp/leads/work/v4/cc_candidates_com_f.jsonl', 'w')
for l in open('/tmp/leads/work/v4/cc_candidates_com.jsonl'):
    r = json.loads(l); t = list(dict.fromkeys(w for nm in r['names'][:8] for w in toks(nm)))
    keep = [d for d in r['candidates'] if (lambda m: len(m) >= 2 or any(z(w, 'en') < 3.6 for w in m))([w for w in t if w in d.split('.')[0]])]
    if keep: r['candidates'] = keep; out.write(json.dumps(r) + '\n')
