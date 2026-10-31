# Spam Act 2003 inferred consent requires that a conspicuously published address is NOT accompanied by a statement
# that the owner does not want unsolicited commercial messages. Re-read every page an address was taken from and flag
# addresses published alongside such a statement.
import pandas as pd, re, requests, threading, queue, json, sys, os
W = '/tmp/leads/work'
ev = pd.read_pickle(f'{W}/v2/email_evidence.pkl')
best = pd.read_pickle(f'{W}/v2/email_best.pkl')
pages = sorted({p for p in best.page.fillna('') if p.startswith('http')})
# leads whose best email came without a page URL (v1 homepage results): check their website homepage
df = pd.read_pickle(f'{W}/final_df.pkl'); df['abn_raw'] = df.ABN.str.replace(' ', '')
site = dict(zip(df.abn_raw, df.Website))
extra = sorted({site.get(a, '') for a, r in best.iterrows() if not str(r.page).startswith('http') and site.get(a, '').startswith('http')})
targets = sorted(set(pages) | set(extra))
OPT = re.compile(r"please do not (?:send|e-?mail)(?: us)?(?: any)? (?:unsolicited|spam|marketing|sales)|do not send us (?:any )?(?:unsolicited|spam|marketing|sales)|we do not (?:accept|want|wish to receive|welcome) (?:any )?(?:unsolicited|cold|sales|marketing)(?: (?:sales|marketing|commercial))? (?:e-?mails?|messages|calls|approaches|solicitations?|offers|marketing)|(?:do|does) not (?:wish|want) to receive (?:any )?unsolicited|no unsolicited (?:e-?mails?|calls|marketing|sales|solicitations?|approaches)(?:,)? (?:please|thank)|unsolicited (?:commercial )?(?:e-?mails?|messages|marketing|approaches|solicitations?|sales calls) (?:are|is|will) not (?:be )?(?:accepted|welcome|wanted|tolerated|responded|read)|\bno solicitations?\b|publication of (?:this|these|our) e-?mail address(?:es)? (?:does|do) not (?:constitute|imply) consent", re.I)
UA = 'AurixaLeadVerifier/1.0 (business contact verification; reads public contact pages only)'
res = {}; q = queue.Queue(); [q.put(t) for t in targets]; lock = threading.Lock()
def run():
    s = requests.Session(); s.headers['User-Agent'] = UA
    while True:
        try: u = q.get_nowait()
        except queue.Empty: return
        hit = ''
        try:
            r = s.get(u, timeout=9, stream=True)
            if r.status_code == 200 and 'html' in r.headers.get('content-type', ''):
                b = r.raw.read(1_500_000, decode_content=True).decode(r.encoding or 'utf-8', 'replace')
                t = re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', re.sub(r'(?is)<(script|style).*?</\1>', ' ', b)))
                m = OPT.search(t)
                if m: hit = t[max(0, m.start() - 60): m.end() + 60]
            r.close()
        except Exception: pass
        with lock: res[u] = hit
ths = [threading.Thread(target=run) for _ in range(80)]; [t.start() for t in ths]; [t.join() for t in ths]
flag = {}
for a, r in best.iterrows():
    u = r.page if str(r.page).startswith('http') else site.get(a, '')
    if res.get(u): flag[a] = res[u]
json.dump(flag, open(f'{W}/v2/optout_flags.json', 'w'))
print('pages checked', len(res), 'leads flagged (opt-out statement on page)', len(flag))
for a, h in list(flag.items())[:8]: print(' ', a, '|', h[:160])
