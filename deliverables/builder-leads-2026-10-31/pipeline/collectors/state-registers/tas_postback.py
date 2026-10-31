# Build ASP.NET postback form body from saved page (selects a licence area radio). Prints urlencoded body.
import re, sys, urllib.parse, html
t = open(sys.argv[1], errors='replace').read()
target = sys.argv[2]; value = sys.argv[3]
f = {}
for m in re.finditer(r'<input[^>]*type="hidden"[^>]*>', t):
    n = re.search(r'name="([^"]+)"', m.group(0)); v = re.search(r'value="([^"]*)"', m.group(0))
    if n: f[n.group(1)] = html.unescape(v.group(1)) if v else ''
f['__EVENTTARGET'] = target; f['__EVENTARGUMENT'] = ''
f[target.rsplit('$', 1)[0]] = value
print(urllib.parse.urlencode(f))
