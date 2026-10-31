#!/usr/bin/env python3
"""Mailbox verification connector (ZeroBounce or NeverBounce): checks each campaign address against the receiving
mail server, the one check that cannot be done from a sandbox without outbound SMTP.

    ZEROBOUNCE_API_KEY=... python3 verify_mailboxes.py campaign_valid.csv verify_out.jsonl --provider zerobounce
    NEVERBOUNCE_API_KEY=... python3 verify_mailboxes.py campaign_valid.csv verify_out.jsonl --provider neverbounce

Input: the campaign CSV (column "Email"). Output rows (JSONL): {"email", "result", "sub_status", "provider"}
validate_emails.py reads verify_out.jsonl if present: 'invalid'/'spamtrap'/'abuse'/'do_not_mail' -> dropped,
'catch-all'/'unknown' -> Risky, 'valid' -> Valid (mailbox confirmed).
"""
import argparse, csv, json, os, time
import requests

def zb(s, key, e):
    r = s.get('https://api.zerobounce.net/v2/validate', params={'api_key': key, 'email': e, 'ip_address': ''}, timeout=30).json()
    return r.get('status', 'unknown'), r.get('sub_status', '')

def nb(s, key, e):
    r = s.get('https://api.neverbounce.com/v4/single/check', params={'key': key, 'email': e}, timeout=30).json()
    m = {'valid': 'valid', 'invalid': 'invalid', 'disposable': 'do_not_mail', 'catchall': 'catch-all', 'unknown': 'unknown'}
    return m.get(r.get('result', 'unknown'), 'unknown'), ','.join(r.get('flags', []))

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('inp'); ap.add_argument('out')
    ap.add_argument('--provider', choices=['zerobounce', 'neverbounce'], default='zerobounce'); ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()
    key = os.environ.get('ZEROBOUNCE_API_KEY' if a.provider == 'zerobounce' else 'NEVERBOUNCE_API_KEY', '')
    emails = [r['Email'].strip().lower() for r in csv.DictReader(open(a.inp, encoding='utf-8')) if r.get('Email')]
    done = {json.loads(l)['email'] for l in open(a.out)} if os.path.exists(a.out) else set()
    todo = [e for e in dict.fromkeys(emails) if e not in done][: a.limit or None]
    print(f'{len(todo)} addresses to verify with {a.provider} ({len(done)} already done)')
    if a.dry_run or not key:
        if not key: print('API key not set: dry run only.')
        return
    s = requests.Session(); fo = open(a.out, 'a'); fn = zb if a.provider == 'zerobounce' else nb
    for i, e in enumerate(todo, 1):
        try: res, sub = fn(s, key, e)
        except Exception as ex: res, sub = 'unknown', 'error ' + str(ex)[:40]
        fo.write(json.dumps(dict(email=e, result=res, sub_status=sub, provider=a.provider)) + '\n'); fo.flush()
        if i % 200 == 0: print(i, 'verified')
        time.sleep(0.05)

if __name__ == '__main__': main()
