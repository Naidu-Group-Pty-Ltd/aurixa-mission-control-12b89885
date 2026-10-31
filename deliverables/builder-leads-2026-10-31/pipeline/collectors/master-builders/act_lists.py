"""Crawl ACT find-a-member listing: unfiltered, each builder-type, each builder-category (all pages)."""
import sys, re, os, html, urllib.parse
sys.path.insert(0, '/tmp/leads/agents/mba/scripts')
from fetchlib import fetch

R = '/tmp/leads/agents/mba/raw/act'
os.makedirs(f'{R}/lists', exist_ok=True)
BASE = 'https://mba.org.au/resources/find-a-member/'
s = open(f'{R}/find.html', encoding='utf-8').read()
f = re.findall(r'<form action="" class="filter-box">.*?</form>', s, flags=re.S)[0]
sel = dict(re.findall(r'<select name="([^"]+)">(.*?)</select>', f, flags=re.S))
types = [v for v, _ in re.findall(r'<option[^>]*value="([^"]*)"[^>]*>([^<]*)', sel['builder-type']) if v]
cats = [v for v, _ in re.findall(r'<option[^>]*value="([^"]*)"[^>]*>([^<]*)', sel['builder-category']) if v]


def crawl(tag, cat='', typ=''):
    page, last = 1, 1
    while page <= last:
        # the site's own pagination links write empty params as bare keys (page 2+ 301s otherwise)
        q = '&'.join(k if not v else f'{k}={urllib.parse.quote(v)}'
                     for k, v in (('builder-category', cat), ('builder-type', typ), ('keywords', '')))
        url = (BASE if page == 1 else f'{BASE}page/{page}/') + '?' + q
        out = f'{R}/lists/{tag}_p{page:03d}.html'
        if os.path.exists(out):
            body = open(out, encoding='utf-8').read()
        else:
            st, b = fetch(url, out=out)
            if st != 200:
                print('status', st, url, flush=True); return
            body = b.decode('utf-8', 'replace')
            open(out + '.url', 'w').write(url)
        nums = [int(x) for x in re.findall(r'class="page-numbers" href="[^"]*/page/(\d+)/', body)]
        last = max(nums + [page])
        page += 1
    print(tag, 'pages', last, flush=True)

crawl('all')
for t in types:
    crawl(f'type_{t}', typ=t)
for c in cats:
    crawl(f'cat_{c}', cat=c)
print('done', flush=True)
