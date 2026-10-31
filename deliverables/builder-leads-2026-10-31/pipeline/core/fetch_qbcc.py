import json, urllib.request, sys, time
RID = sys.argv[1]; out = sys.argv[2]
base = "https://www.data.qld.gov.au/api/3/action/datastore_search?resource_id=%s&limit=%d&offset=%d"
lim = 20000; off = 0; rows = []
while True:
    for attempt in range(4):
        try:
            with urllib.request.urlopen(base % (RID, lim, off), timeout=120) as r:
                d = json.load(r)["result"]; break
        except Exception as e:
            print("retry", off, e, file=sys.stderr); time.sleep(2 ** attempt)
    recs = d["records"]; rows.extend(recs); off += len(recs)
    print(off, d["total"], file=sys.stderr)
    if not recs or off >= d["total"]: break
json.dump(rows, open(out, "w"))
print("saved", len(rows))
