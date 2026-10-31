import csv, json, glob, collections
rows = []
for f in sorted(glob.glob('/tmp/leads/agents/websearch/round3_batch*_out.csv')):
    rows += list(csv.DictReader(open(f, encoding='utf-8')))
print(len(rows), collections.Counter(r['confidence'] for r in rows))
json.dump({r['abn']: r['confidence'] for r in rows if r['website']}, open('/tmp/leads/work/v4/ws3_conf.json', 'w'))
json.dump({r['abn']: r['note'] for r in rows if 'not a builder' in (r.get('note') or '').lower()}, open('/tmp/leads/work/v4/not_builders3.json', 'w'))
n = 0
with open('/tmp/leads/work/v4/in_ws3.jsonl', 'w') as f:
    for r in rows:
        if r['website'] and r['confidence'] in ('high', 'medium'):
            n += 1
            f.write(json.dumps(dict(abn=r['abn'], mode='site', site=r['website'], names=[r['company']], states=[], ind=False,
                web_conf='Official site identified by web search' if r['confidence'] == 'high' else 'Probable parent/brand site (web search, medium confidence)')) + '\n')
print('sites to crawl', n)
