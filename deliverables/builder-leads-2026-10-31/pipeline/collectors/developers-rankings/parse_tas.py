import re,html,sys,json
t=open(sys.argv[1],encoding='utf-8',errors='replace').read()
i=t.find('summary="Prequalifications')
t=t[i:]
rows=[]
for tr in re.findall(r'<tr[^>]*>(.*?)</tr>',t,flags=re.S):
    tds=re.findall(r'<td[^>]*>(.*?)</td>',tr,flags=re.S)
    cells=[re.sub(r'\s+',' ',html.unescape(re.sub(r'<[^>]+>',' ',c))).replace('​','').strip() for c in tds]
    cells=[c for c in cells]
    if len(cells)>=4 and re.match(r'\d{1,2}/\d{1,2}/\d{4}',cells[-1] or ''):
        rows.append(cells[-4:])
json.dump(rows,open(sys.argv[2],'w'),indent=0)
print(len(rows))
from collections import Counter
print(Counter(r[1] for r in rows))
cats=Counter()
for r in rows:
    for c in r[2].split(','): cats[c.strip()]+=1
for k,v in cats.most_common(): print(v,k)
