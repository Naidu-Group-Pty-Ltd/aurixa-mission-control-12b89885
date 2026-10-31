import csv, json, glob, collections
rows = []
for f in sorted(glob.glob('/tmp/leads/agents/websearch/round2_batch*_out.csv')):
    rows += list(csv.DictReader(open(f, encoding='utf-8')))
print(len(rows), collections.Counter(r['confidence'] for r in rows))
conf = {r['abn']: r['confidence'] for r in rows if r['website']}
nb = {r['abn']: r['note'] for r in rows if 'not a builder' in (r.get('note') or '').lower()}
json.dump(conf, open('/tmp/leads/work/v3/ws2_conf.json', 'w')); json.dump(nb, open('/tmp/leads/work/v3/not_builders2.json', 'w'))
with open('/tmp/leads/work/v3/in_ws2.jsonl', 'w') as f:
    for r in rows:
        if r['website'] and r['confidence'] in ('high', 'medium'):
            f.write(json.dumps(dict(abn=r['abn'], mode='site', site=r['website'], names=[r['company']], states=[], ind=False,
                web_conf='Official site identified by web search' if r['confidence'] == 'high' else 'Probable parent/brand site (web search, medium confidence)')) + '\n')
print('sites to crawl', sum(1 for r in rows if r['website'] and r['confidence'] in ('high', 'medium')), 'not builders', len(nb))
