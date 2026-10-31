import zipfile,re,html,sys,json,os
def paras(xml):
    out=[]
    for p in re.findall(r'<w:p[ >].*?</w:p>',xml,flags=re.S):
        s=html.unescape(''.join(re.findall(r'<w:t(?:\s[^>]*)?>(.*?)</w:t>',p,flags=re.S))).strip()
        if s: out.append(s)
    return out
res={}
for path in sys.argv[2:]:
    x=zipfile.ZipFile(path).read('word/document.xml').decode('utf-8')
    tables=[]
    for tbl in re.findall(r'<w:tbl>.*?</w:tbl>',x,flags=re.S):
        rows=[]
        for tr in re.findall(r'<w:tr[ >].*?</w:tr>',tbl,flags=re.S):
            rows.append([paras(tc) for tc in re.findall(r'<w:tc>.*?</w:tc>',tr,flags=re.S)])
        tables.append(rows)
    allp=paras(x)
    res[os.path.basename(path)]={'tables':tables,'paras':allp[:15]}
json.dump(res,open(sys.argv[1],'w'),indent=1,ensure_ascii=False)
for k,v in res.items():
    print(k, [ [len(c) for c in r] for t in v['tables'] for r in t])
