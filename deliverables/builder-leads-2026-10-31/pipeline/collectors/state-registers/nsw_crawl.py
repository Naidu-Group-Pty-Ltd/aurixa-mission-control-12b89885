# Polite adaptive crawl of NSW Verify Licence public register API (advQuery),
# filtered to Contractor Licence, class "Builder" (HBS_CON_Builder), status Current.
# Partition by licence-number prefix via the 'search' field (prefix match), splitting when the 200-result cap is hit.
import json, os, sys, time, urllib.request, urllib.error, string
B = "https://verify.licence.nsw.gov.au/publicregisterapi/api/v1/licence/search/advQuery"
OUT = sys.argv[1]  # dir for raw responses
STATE = os.path.join(OUT, '_state.json')
DELAY = 1.1
def body(prefix):
    return {"licenceGroup": "Trades", "autoComplete": False, "pageNumber": 0, "pageSize": 200,
            "licenceTypes": ["Contractor"], "status": ["Current"], "search": prefix,
            "licenceClassSearch": [{"classCodes": ["HBS_CON_Builder"], "licenceTypes": ["Contractor Licence"]}]}
def fetch(prefix):
    data = json.dumps(body(prefix)).encode()
    backoff = 5
    for attempt in range(6):
        req = urllib.request.Request(B, data=data, method='POST', headers={'Content-Type': 'application/json', 'Accept': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                raw = r.read()
                ct = r.headers.get('Content-Type', '')
                if 'json' not in ct:
                    raise SystemExit(f'STOP non-JSON response for {prefix}: {ct} {raw[:200]!r}')
                return json.loads(raw)
        except urllib.error.HTTPError as e:
            if e.code in (403, 401):
                raise SystemExit(f'STOP HTTP {e.code} on {prefix}: {e.read()[:300]!r}')
            if e.code == 400:
                return {'_error': 400, 'detail': e.read()[:300].decode('utf8', 'replace')}
            print(f'  HTTP {e.code} on {prefix}, backoff {backoff}s', flush=True)
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            print(f'  net error {e} on {prefix}, backoff {backoff}s', flush=True)
        time.sleep(backoff); backoff *= 2
    raise SystemExit(f'STOP repeated failures on {prefix}')
if os.path.exists(STATE):
    st = json.load(open(STATE))
else:
    seeds = [a + b for a in '123456789' for b in '0123456789'] + [d + 'C' for d in '123456789']
    seeds += [L + d for L in string.ascii_uppercase for d in '0123456789']
    seeds += ['EC']
    st = {'queue': seeds, 'done': {}}
n = 0
while st['queue']:
    p = st['queue'].pop(0)
    if p in st['done']: continue
    d = fetch(p)
    res = d.get('results', []) if isinstance(d, dict) else []
    pi = d.get('pagingInfo', {}) if isinstance(d, dict) else {}
    capped = bool(pi.get('totalRecordsLimitExceeded')) or len(res) >= 200
    with open(os.path.join(OUT, f'q_{p}.json'), 'w') as f: json.dump(d, f)
    st['done'][p] = {'n': len(res), 'capped': capped}
    if capped:
        kids = [p + c for c in '0123456789'] + ([p + 'C'] if p[-1].isdigit() else [])
        st['queue'] = kids + st['queue']
    n += 1
    if n % 20 == 0:
        json.dump(st, open(STATE, 'w'))
        print(f'{time.strftime("%H:%M:%S")} done={len(st["done"])} queue={len(st["queue"])} last={p} n={len(res)} capped={capped}', flush=True)
    time.sleep(DELAY)
json.dump(st, open(STATE, 'w'))
print('FINISHED', len(st['done']), flush=True)
