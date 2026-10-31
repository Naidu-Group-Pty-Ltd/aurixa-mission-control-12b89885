#!/usr/bin/env python3
"""Google Places (New) connector: find the WEBSITE of each lead that has none, so the crawler can read the email
the business publishes on its own site.

    GOOGLE_PLACES_API_KEY=... python3 places_websites.py leads_without_site.jsonl places_out.jsonl [--limit N] [--dry-run]

Input rows (JSONL): {"abn", "names": [legal name, business names...], "states": [...], "postcode"?}
Output rows (JSONL): {"abn", "website", "phone", "place_name", "address", "match": score, "status"}
Feed the output to enrich_v3.py in "site" mode (see to_site_input()).

Cost: Text Search with websiteUri in the field mask is billed at the Places "Text Search Enterprise" SKU. Check the
current Google Maps Platform price list before a full run; ~17.5k leads is ~17.5k requests (one per lead).
Terms: Google Maps Platform terms limit storing Places content. This connector keeps only the website URL needed
to visit the business's own site; review the terms for your use.
"""
import argparse, json, os, re, sys, time
import requests
from rapidfuzz import fuzz

ENDPOINT = 'https://places.googleapis.com/v1/places:searchText'
FIELDS = 'places.displayName,places.websiteUri,places.nationalPhoneNumber,places.formattedAddress,places.types,places.businessStatus'
STATES = {'QLD', 'VIC', 'NSW', 'WA', 'SA', 'TAS', 'ACT', 'NT'}
SUFX = re.compile(r'\b(PTY|LTD|LIMITED|PROPRIETARY|THE TRUSTEE FOR|TRUST|P/L)\b\.?', re.I)
BLOCKED_HOSTS = re.compile(r'(facebook|instagram|linkedin|hipages|oneflare|yellowpages|truelocal|houzz|serviceseeking|google\.)', re.I)

def clean(n): return re.sub(r'\s+', ' ', SUFX.sub(' ', n)).strip(' .,&')

def best_match(rec, places):
    names = [clean(n) for n in rec['names'] if n]
    best = None
    for p in places:
        pname = (p.get('displayName') or {}).get('text', '')
        score = max(fuzz.token_set_ratio(pname.lower(), n.lower()) for n in names)
        addr = p.get('formattedAddress', '')
        st = next((s for s in STATES if re.search(r'\b' + s + r'\b', addr)), None)
        if rec.get('states') and st and st not in rec['states']: score -= 25
        if p.get('businessStatus') and p['businessStatus'] != 'OPERATIONAL': score -= 50
        if best is None or score > best[0]: best = (score, p, pname, addr)
    return best

def search(session, key, rec):
    q = f"{clean(rec['names'][0])} builder {' '.join(rec.get('states', [])[:1])}".strip()
    body = {'textQuery': q, 'regionCode': 'AU', 'maxResultCount': 5}
    for attempt in range(4):
        r = session.post(ENDPOINT, json=body, headers={'X-Goog-Api-Key': key, 'X-Goog-FieldMask': FIELDS}, timeout=20)
        if r.status_code == 429 or r.status_code >= 500: time.sleep(2 ** attempt); continue
        r.raise_for_status(); return r.json().get('places', [])
    return []

def to_site_input(out_path, site_jsonl):
    """Convert this connector's output into enrich_v3.py 'site' mode input."""
    with open(site_jsonl, 'w') as f:
        for l in open(out_path):
            j = json.loads(l)
            if j.get('website'):
                f.write(json.dumps(dict(abn=j['abn'], mode='site', site=j['website'], names=[j.get('place_name', '')], states=[], ind=False,
                                        web_conf='Website from Google Places (name match %d)' % j['match'])) + '\n')

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('inp'); ap.add_argument('out')
    ap.add_argument('--limit', type=int, default=0); ap.add_argument('--dry-run', action='store_true'); ap.add_argument('--min-match', type=int, default=80)
    a = ap.parse_args()
    key = os.environ.get('GOOGLE_PLACES_API_KEY', '')
    rows = [json.loads(l) for l in open(a.inp)]
    done = set()
    if os.path.exists(a.out): done = {json.loads(l)['abn'] for l in open(a.out)}
    todo = [r for r in rows if r['abn'] not in done][: a.limit or None]
    print(f'{len(todo)} lookups to make ({len(done)} already done)')
    if a.dry_run or not key:
        for r in todo[:3]: print('would query:', f"{clean(r['names'][0])} builder {' '.join(r.get('states', [])[:1])}")
        if not key: print('GOOGLE_PLACES_API_KEY is not set: dry run only.')
        return
    s = requests.Session(); fo = open(a.out, 'a'); n = 0
    for r in todo:
        try:
            m = best_match(r, search(s, key, r))
            res = dict(abn=r['abn'], status='no match')
            if m and m[0] >= a.min_match:
                web = m[1].get('websiteUri', '')
                res = dict(abn=r['abn'], website='' if BLOCKED_HOSTS.search(web) else web, phone=m[1].get('nationalPhoneNumber', ''),
                           place_name=m[2], address=m[3], match=int(m[0]), status='ok')
        except Exception as ex: res = dict(abn=r['abn'], status='error ' + str(ex)[:80])
        fo.write(json.dumps(res) + '\n'); fo.flush(); n += 1
        if n % 100 == 0: print(n, 'done')
        time.sleep(0.05)

if __name__ == '__main__': main()
