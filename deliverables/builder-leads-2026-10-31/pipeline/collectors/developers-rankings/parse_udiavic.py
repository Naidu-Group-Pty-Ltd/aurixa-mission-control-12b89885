import re,html,sys,json,glob,os
def clean(s): return re.sub(r'\s+',' ',html.unescape(re.sub(r'<[^>]+>',' ',s))).strip()
out=[]
for f in sorted(glob.glob(os.path.join(sys.argv[1],'page_*.html'))):
    t=open(f,encoding='utf-8',errors='replace').read()
    pg=int(re.search(r'page_(\d+)',f).group(1))
    parts=re.split(r'<div class="member logo-member[^"]*">',t)[1:]
    for p in parts:
        p=p.split('<div class="member logo-member')[0]
        rec={'page':pg}
        m=re.search(r'<p class="member-title">(.*?)</p>',p,flags=re.S); rec['name']=clean(m.group(1)) if m else ''
        for k in ['category','location','activity']:
            m=re.search(r'<div class="member-%s member-inner-content">(.*?)</div>'%k,p,flags=re.S)
            rec[k]=clean(m.group(1)) if m else ''
        m=re.search(r'<div class="member-contact member-inner-content">(.*?)</div>',p,flags=re.S)
        rec['phone']=''
        if m:
            ph=re.search(r'href="tel:([^"]*)"',m.group(1)); rec['phone']=html.unescape(ph.group(1)).strip() if ph else clean(m.group(1))
        rec['email_obfuscated']=bool(re.search(r'data-cfemail|__cf_email__|email-protection',p))
        m=re.search(r'<div class="member-website[^"]*">.*?<a href="([^"]+)"><button',p,flags=re.S)
        rec['website']=html.unescape(m.group(1)) if m else ''
        out.append(rec)
json.dump(out,open(sys.argv[2],'w'),indent=1,ensure_ascii=False)
print(len(out))
from collections import Counter
print(Counter(r['category'] for r in out))
