"""Crawl WA find-a-member listing pages for builder member types (all pages) and each builder category."""
import sys, re, json, os, urllib.parse
sys.path.insert(0, '/tmp/leads/agents/mba/scripts')
from fetchlib import fetch

R = '/tmp/leads/agents/mba/raw/wa'
os.makedirs(f'{R}/lists', exist_ok=True)
BASE = 'https://www.mbawa.com/become-a-member/find-a-member/'
s = open(f'{R}/find.html', encoding='utf-8').read()
cats = json.loads(re.search(r'var pwdFindAMember = (\{.*?\});\s*\n', s, flags=re.S).group(1))['categories']


def crawl(tag, params):
    page, last = 1, 1
    while page <= last:
        url = (BASE if page == 1 else f'{BASE}page/{page}/') + '?' + urllib.parse.urlencode(params, doseq=True)
        out = f'{R}/lists/{tag}_p{page:03d}.html'
        if os.path.exists(out):
            body = open(out, encoding='utf-8').read()
        else:
            st, b = fetch(url, out=out)
            if st != 200:
                print('status', st, url, flush=True); return
            body = b.decode('utf-8', 'replace')
            # sidecar with the exact URL
            open(out + '.url', 'w').write(url)
        nums = [int(x) for x in re.findall(r'aria-label="Page (\d+)"', body)]
        last = max(nums + [page])
        page += 1
    print(tag, 'pages', last, flush=True)

jobs = []
for mt in ('residential-builder', 'commercial-builder'):
    jobs.append((f'type_{mt}', {'member_type': mt}))
for mt in ('residential-builder', 'commercial-builder'):
    for slug in cats[mt]:
        jobs.append((f'cat_{mt}__{slug}', {'member_type': mt, 'member_cat[]': [slug]}))
for tag, params in jobs:
    crawl(tag, params)
print('done', flush=True)
