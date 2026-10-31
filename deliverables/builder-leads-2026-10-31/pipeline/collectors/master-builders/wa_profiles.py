import sys, re, glob, os
sys.path.insert(0, '/tmp/leads/agents/mba/scripts')
from fetchlib import fetch

R = '/tmp/leads/agents/mba/raw/wa'
os.makedirs(f'{R}/profiles', exist_ok=True)
urls = []
for f in sorted(glob.glob(f'{R}/lists/type_*.html')):
    s = open(f, encoding='utf-8').read()
    for u in re.findall(r'<h4 class="pwd-find-a-member__company">\s*<a href="([^"]+)"', s):
        if u not in urls:
            urls.append(u)
print(len(urls), flush=True)
for i, u in enumerate(urls):
    slug = u.rstrip('/').rsplit('/', 1)[-1]
    out = f'{R}/profiles/{slug}.html'
    if os.path.exists(out):
        continue
    st, b = fetch(u, out=out)
    if st != 200:
        print('status', st, u, flush=True)
    if i % 50 == 0:
        print(i, flush=True)
print('done', flush=True)
