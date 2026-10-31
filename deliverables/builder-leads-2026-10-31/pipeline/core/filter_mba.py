# Keep only Master Builders directories whose robots.txt permits this collection (WA, SA, ACT, NT).
# Master Builders Victoria and Tasmania exclude Claude's crawler in robots.txt, so their rows are dropped.
import csv
rows = list(csv.DictReader(open('/tmp/leads/agents/mba/mba_members.csv', encoding='utf-8')))
keep = [r for r in rows if r['source'] in ('Master Builders WA', 'Master Builders SA', 'Master Builders ACT', 'Master Builders NT')]
for r in keep:
    if r['source'] == 'Master Builders ACT' and not r['state']: r['state'] = 'ACT'
w = csv.DictWriter(open('/tmp/leads/work/mba_filtered.csv', 'w'), fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(keep)
print(len(keep))
