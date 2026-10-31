import sys, json, os, glob
sys.path.insert(0, '/tmp/leads/agents/mba/scripts')
from fetchlib import fetch

R = '/tmp/leads/agents/mba/raw/sa'
os.makedirs(f'{R}/profiles', exist_ok=True)
items = []
for f in sorted(glob.glob(f'{R}/builder_rest_p*.json')):
    items += json.load(open(f))
print(len(items), flush=True)
for i, it in enumerate(items):
    out = f'{R}/profiles/{it["id"]}.html'
    if os.path.exists(out):
        continue
    st, b = fetch(it['link'], out=out)
    if st != 200:
        print('status', st, it['link'], flush=True)
    if i % 25 == 0:
        print(i, flush=True)
print('done', flush=True)
