# Parse WA Building Services Board register PDF (Section 1: current building contractors) -> JSONL
import pdfplumber, json, sys, re, collections
src, out = sys.argv[1], sys.argv[2]
COLS = [('status', 0), ('reg_no', 60), ('former_reg_no', 118), ('name', 158), ('address', 350), ('first_registered', 482), ('supervisor', 545)]
def col(x):
    c = None
    for n, x0 in COLS:
        if x >= x0 - 1: c = n
    return c
pdf = pdfplumber.open(src)
recs = []; cur = None; in_s1 = False; done = False; asat = None
for pi, p in enumerate(pdf.pages):
    words = p.extract_words(keep_blank_chars=False, use_text_flow=False)
    lines = collections.OrderedDict()
    for w in sorted(words, key=lambda w: (round(w['top']), w['x0'])):
        key = None
        for k in lines:
            if abs(k - w['top']) <= 2.5: key = k; break
        if key is None: key = w['top']; lines[key] = []
        lines[key].append(w)
    for top in sorted(lines):
        ws = sorted(lines[top], key=lambda w: w['x0'])
        text = ' '.join(w['text'] for w in ws)
        if text.startswith('SECTION 1 -'):
            in_s1 = True; asat = text.split('AS AT')[-1].strip(); continue
        if text.startswith('SECTION 2 -'):
            done = True; break
        if not in_s1: continue
        if top < 170 or top > 578: continue  # header/notes/footer
        if text.startswith(('STATUS', 'REG NO', 'FORMER')): continue
        first = ws[0]
        if first['x0'] < 50 and first['text'] in ('Current', 'Suspended', 'Cancelled', 'Expired'):
            cur = {'status': first['text'], 'reg_no': '', 'former_reg_no': '', 'name': [], 'address': [], 'first_registered': '', 'supervisor': [], 'conditions': [], 'page': pi + 1}
            recs.append(cur)
            ws = ws[1:]
        if cur is None: continue
        bycol = collections.defaultdict(list)
        for w in ws: bycol[col(w['x0'])].append(w['text'])
        if ws and col(ws[0]['x0']) == 'name':
            s0 = ' '.join(bycol.get('name', []))
            if cur['conditions'] or (re.match(r'(Restricted|Sanctions)', s0) and cur['name']):
                cond = [w['text'] for w in ws if not (col(w['x0']) == 'supervisor')]
                cur['conditions'].append(' '.join(cond))
                sv = ' '.join(bycol.get('supervisor', []))
                if sv:
                    if re.match(r'(BP\d|no affect|affect\.)', sv): cur['supervisor'].append(sv)
                    else: cur['conditions'].append(sv)
                continue
        for c, t in bycol.items():
            s = ' '.join(t)
            if c in ('reg_no', 'former_reg_no', 'first_registered'):
                cur[c] = (cur[c] + ' ' + s).strip()
            elif c == 'name':
                # condition lines appear below the record in the name column
                if cur['conditions'] or re.match(r'(Restricted|BCA|NCC|Class|Limited|Condition|Must|Only|Not )', s) and len(cur['name']) >= 1 and not bycol.get('address'):
                    cur['conditions'].append(s)
                else:
                    cur['name'].append(s)
            elif c in ('address', 'supervisor'):
                cur[c].append(s)
            elif c == 'status':
                cur.setdefault('extra', []).append(s)
    if done: break
with open(out, 'w') as f:
    for r in recs:
        r['name'] = ' '.join(r['name']); r['address'] = ' '.join(r['address'])
        r['conditions'] = ' '.join(r['conditions']); r['as_at'] = asat
        f.write(json.dumps(r) + '\n')
print('as at', asat, 'records', len(recs), collections.Counter(r['status'] for r in recs))
