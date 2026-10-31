"""WA pass 2: unfiltered 'all members' list + non-builder member types, to find members with no member type."""
import sys, re, os, urllib.parse
sys.path.insert(0, '/tmp/leads/agents/mba/scripts')
from fetchlib import fetch

R = '/tmp/leads/agents/mba/raw/wa'
BASE = 'https://www.mbawa.com/become-a-member/find-a-member/'


def crawl(tag, params):
    page, last = 1, 1
    while page <= last:
        q = ('?' + urllib.parse.urlencode(params, doseq=True)) if params else ''
        url = (BASE if page == 1 else f'{BASE}page/{page}/') + q
        out = f'{R}/lists/{tag}_p{page:03d}.html'
        if os.path.exists(out):
            body = open(out, encoding='utf-8').read()
        else:
            st, b = fetch(url, out=out)
            if st != 200:
                print('status', st, url, flush=True); return
            body = b.decode('utf-8', 'replace')
            open(out + '.url', 'w').write(url)
        nums = [int(x) for x in re.findall(r'aria-label="Page (\d+)"', body)]
        last = max(nums + [page])
        page += 1
    print(tag, 'pages', last, flush=True)

for mt in ('subcontractor', 'supplier', 'consultant', 'social-member'):
    crawl(f'xtype_{mt}', {'member_type': mt})
crawl('all', {})
print('done', flush=True)
