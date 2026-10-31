#!/bin/bash
# usage: ckan_search.sh <base_api_url> <outdir> <query...>
base="$1"; out="$2"; shift 2
for q in "$@"; do
  qe=$(python3 -I -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$q")
  f="$out/ckan_$(echo "$q" | tr ' /' '__').json"
  code=$(curl -sS -m 60 -o "$f" -w "%{http_code}" "$base/package_search?q=$qe&rows=30")
  echo "== [$code] $q"
  python3 -I -c "
import json,sys
try:
  d=json.load(open(sys.argv[1]))
except Exception as e:
  print('  parse error',e); sys.exit()
r=d['result']; print('  count',r['count'])
for p in r['results']:
    print('  -',p['name'],'|',(p.get('title') or '')[:90],'|',p.get('metadata_modified','')[:10], '|', (p.get('organization') or {}).get('title'))
" "$f"
  sleep 1.2
done
