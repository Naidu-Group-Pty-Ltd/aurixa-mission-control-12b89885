"""Fetch WA profiles for members that appear in the unfiltered list but under no member type."""
import sys, re, glob, os
sys.path.insert(0, '/tmp/leads/agents/mba/scripts')
from fetchlib import fetch

R = '/tmp/leads/agents/mba/raw/wa'
typed, allm = set(), []
for f in sorted(glob.glob(f'{R}/lists/*.html')):
    tag = os.path.basename(f).rsplit('_p', 1)[0]
    urls = re.findall(r'<h4 class="pwd-find-a-member__company">\s*<a href="([^"]+)"', open(f, encoding='utf-8').read())
    if tag.startswith(('type_', 'xtype_')):
        typed.update(urls)
    elif tag == 'all':
        allm += [u for u in urls if u not in allm]
untyped = [u for u in allm if u not in typed]
print('all', len(allm), 'typed', len(typed), 'untyped', len(untyped), flush=True)
for u in untyped:
    slug = u.rstrip('/').rsplit('/', 1)[-1]
    out = f'{R}/profiles/{slug}.html'
    if not os.path.exists(out):
        st, b = fetch(u, out=out)
        if st != 200:
            print('status', st, u, flush=True)
print('done', flush=True)
