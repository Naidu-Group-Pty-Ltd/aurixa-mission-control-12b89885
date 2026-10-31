# Parse NSW Fair Trading "Current Licence Extract - Contractor Licence" (as at 4 Dec 2023) -> builder-class rows (JSON lines)
import openpyxl, json, sys, re, collections
src, out = sys.argv[1], sys.argv[2]
wb = openpyxl.load_workbook(src, read_only=True)
rows = []
for ws in wb.worksheets[1:]:
    it = ws.iter_rows(values_only=True)
    kind = next(it)[0]
    hdr = next(it)
    for r in it:
        if not r or r[0] is None: continue
        d = dict(zip(hdr, r))
        classes = [c.strip() for c in (d.get('Classes') or '').split(';')]
        d['kind'] = kind
        d['class_list'] = classes
        for k in ('Issue Date', 'Expiry Date'):
            if d.get(k) is not None and hasattr(d[k], 'isoformat'): d[k] = d[k].date().isoformat()
        rows.append(d)
cls = collections.Counter(c for d in rows for c in d['class_list'])
print('total rows', len(rows))
print([ (c,n) for c,n in cls.most_common() if re.search('build', c, re.I)])
b = [d for d in rows if 'Builder' in d['class_list']]
print('builder rows', len(b), collections.Counter(d['kind'] for d in b))
print('number patterns', collections.Counter(re.sub(r'\d', '9', str(d['Licence Number'])) for d in b).most_common(15))
print('expiry>=2026-10-31', sum(1 for d in b if (d.get('Expiry Date') or '') >= '2026-10-31'))
with open(out, 'w') as f:
    for d in b: f.write(json.dumps(d, default=str) + '\n')
