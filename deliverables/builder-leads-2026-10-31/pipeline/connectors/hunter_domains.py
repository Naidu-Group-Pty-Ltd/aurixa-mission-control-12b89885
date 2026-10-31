#!/usr/bin/env python3
"""Hunter.io connector, for leads whose website we know but which publish no email (contact-form-only sites).

    HUNTER_API_KEY=... python3 hunter_domains.py sites_without_email.jsonl hunter_out.jsonl [--limit N] [--dry-run]

Input rows (JSONL): {"abn", "site"}  (site = https://www.example.com.au)
Output rows (JSONL): {"abn", "domain", "emails": [{"email","type","confidence","sources"}], "pattern", "status"}

Hunter's Domain Search returns addresses Hunter has found published on the web for that domain, each with its
source pages and a confidence score. Only 'generic' (role) addresses and personal addresses with confidence >= 90
are kept by default. Check your plan's request allowance (one request per domain).
Compliance: these are still harvested addresses for Spam Act purposes. Use only for relevant B2B messages with
sender identification and an unsubscribe, as for the rest of the list.
"""
import argparse, json, os, time
from urllib.parse import urlparse
import requests

def domain_of(site): return urlparse(site if site.startswith('http') else 'https://' + site).netloc.lower().removeprefix('www.').split(':')[0]

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('inp'); ap.add_argument('out')
    ap.add_argument('--limit', type=int, default=0); ap.add_argument('--dry-run', action='store_true'); ap.add_argument('--min-confidence', type=int, default=90)
    a = ap.parse_args(); key = os.environ.get('HUNTER_API_KEY', '')
    rows = [json.loads(l) for l in open(a.inp)]
    done = {json.loads(l)['abn'] for l in open(a.out)} if os.path.exists(a.out) else set()
    todo = [r for r in rows if r['abn'] not in done][: a.limit or None]
    print(f'{len(todo)} domain searches to make ({len(done)} already done)')
    if a.dry_run or not key:
        for r in todo[:3]: print('would search domain:', domain_of(r['site']))
        if not key: print('HUNTER_API_KEY is not set: dry run only.')
        return
    s = requests.Session(); fo = open(a.out, 'a')
    for r in todo:
        d = domain_of(r['site']); res = dict(abn=r['abn'], domain=d, emails=[], status='ok')
        for attempt in range(4):
            try:
                x = s.get('https://api.hunter.io/v2/domain-search', params={'domain': d, 'api_key': key, 'limit': 10}, timeout=20)
                if x.status_code == 429: time.sleep(2 ** attempt + 1); continue
                if x.status_code != 200: res['status'] = f'http {x.status_code}'; break
                data = x.json().get('data', {})
                res['pattern'] = data.get('pattern')
                for e in data.get('emails', []):
                    if e.get('type') == 'generic' or (e.get('confidence') or 0) >= a.min_confidence:
                        res['emails'].append(dict(email=e['value'].lower(), type=e.get('type'), confidence=e.get('confidence'),
                                                  sources=[src.get('uri') for src in (e.get('sources') or [])][:3]))
                break
            except Exception as ex: res['status'] = 'error ' + str(ex)[:60]; time.sleep(1)
        fo.write(json.dumps(res) + '\n'); fo.flush(); time.sleep(0.2)

if __name__ == '__main__': main()
