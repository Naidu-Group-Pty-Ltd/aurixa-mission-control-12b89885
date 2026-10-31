import re,html,sys,json
t=open(sys.argv[1],encoding='utf-8',errors='replace').read()
for m in re.finditer(r'<script type="application/ld\+json">(.*?)</script>',t,flags=re.S):
    try: d=json.loads(m.group(1))
    except Exception as e: continue
    if isinstance(d,dict) and d.get('articleBody'):
        b=d['articleBody']
        b=re.sub(r'<(br|/p|/li|/tr|/h\d|/td|/th)[^>]*>','\n',b)
        b=re.sub(r'<td[^>]*>',' | ',b)
        b=html.unescape(re.sub(r'<[^>]+>','',b))
        print('HEADLINE:',d.get('headline'),'| PUB:',d.get('datePublished'),'| URL:',d.get('url'))
        print(re.sub(r'\n\s*\n+','\n',b))
