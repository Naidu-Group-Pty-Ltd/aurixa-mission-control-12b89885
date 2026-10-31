#!/usr/bin/env bash
# Builder & developer lead scraper — end-to-end runner.
# Every stage resumes where it stopped (outputs are append-only JSONL keyed by ABN), so re-running is safe.
#
#   bash run_scraper.sh                  # in-house stages only (no API keys needed)
#   GOOGLE_PLACES_API_KEY=... HUNTER_API_KEY=... ZEROBOUNCE_API_KEY=... bash run_scraper.sh   # + paid connectors
#
# Workspace: /tmp/leads (raw/, work/, out/). Scripts: this directory.
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"; L=/tmp/leads; W=$L/work
# the scripts import each other from /tmp/leads/scripts, so stage them there
mkdir -p $L/scripts/connectors && cp "$SRC"/core/* $L/scripts/ && cp "$SRC"/connectors/* $L/scripts/connectors/
S=$L/scripts; C=$L/scripts/connectors
py() { python3 -I "$@"; }
mkdir -p $W/v2 $W/v3 $W/v4 $W/v5 $L/out

echo "== 1. Registers, ABR and ASIC (first run only: downloads ~2 GB of open data)"
[ -f $W/leads.duckdb ] || { py $S/fetch_qbcc.py 25608781-b28c-44f8-8545-0ab18d84082f $L/raw/qbcc/active.json; sh $S/run_abr.sh; py $S/load_db.py; }
py $S/norm_regs.py; py $S/resolve.py; py $S/validate.py; py $S/build_core.py; py $S/consolidate.py
[ -f $W/v2/../name_idx.done ] || { py $S/name_index.py && touch $W/name_idx.done; }
py $S/regs_resolve.py; py $S/filter_mba.py
py $S/ext_resolve.py mba $W/mba_filtered.csv $W/mba_resolved.csv
py $S/ext_resolve.py dev $L/agents/dev/developers_and_rankings.csv $W/dev_resolved.csv
py $S/assemble.py

echo "== 2. Websites and emails (in-house)"
py $S/enrich_web.py $W/web/candidates.tsv $W/web/web_out.jsonl 100
NT=400 py $S/dns_prepass.py $W/v2/in_disc.jsonl $W/v2/in_ind.jsonl $W/v2/dns.tsv
py $S/enrich_v2.py $W/v2/in_site.jsonl $W/v2/out_site.jsonl 100
DNS_CACHE=$W/v2/dns.tsv py $S/enrich_v2.py $W/v2/in_disc.jsonl $W/v2/out_disc.jsonl 140
DNS_CACHE=$W/v2/dns.tsv py $S/enrich_v2.py $W/v2/in_ind.jsonl $W/v2/out_ind.jsonl 60
NT=400 py $S/dns_prepass3.py $W/v3/in_disc.jsonl $W/v3/in_ind.jsonl $W/v3/dns3.tsv $W/v2/dns.tsv
cat $W/v2/dns.tsv $W/v3/dns3.tsv > $W/v3/dns_all.tsv
py $S/enrich_v3.py $W/v3/in_site.jsonl $W/v3/out_site.jsonl $W/v3/render_queue.jsonl 100
DNS_CACHE=$W/v3/dns_all.tsv py $S/enrich_v3.py $W/v3/in_disc.jsonl $W/v3/out_disc.jsonl $W/v3/render_queue.jsonl 120
DNS_CACHE=$W/v3/dns_all.tsv py $S/enrich_v3.py $W/v3/in_ind.jsonl $W/v3/out_ind.jsonl $W/v3/render_queue.jsonl 60
# Common Crawl domain list (open data): match names to real .au domains, then verify each candidate
[ -s $L/raw/cc/au_domains.tsv ] || curl -sS https://data.commoncrawl.org/projects/hyperlinkgraph/cc-main-2026-aug-sep-oct/domain/cc-main-2026-aug-sep-oct-domain-vertices.txt.gz | gunzip -c | awk -F'\t' '$2 ~ /^au\./' > $L/raw/cc/au_domains.tsv
py $S/cc_match.py
py $S/cc_crawl.py $W/v4/cc_candidates.jsonl $W/v4/out_cc.jsonl $W/v3/render_queue.jsonl
[ -s $L/raw/cc/com_build_domains.tsv ] || curl -sS https://data.commoncrawl.org/projects/hyperlinkgraph/cc-main-2026-aug-sep-oct/domain/cc-main-2026-aug-sep-oct-domain-vertices.txt.gz | gunzip -c | awk -F'\t' '$2 ~ /^com\.[a-z0-9-]*(build|construct|homes|projects|develop|carpent|renovat|joiner|fitout|interiors|contracting)[a-z0-9-]*$/' > $L/raw/cc/com_build_domains.tsv
py $S/cc_match_com.py; py $S/filter_com_candidates.py
py $S/cc_crawl.py $W/v4/cc_candidates_com_f.jsonl $W/v4/out_cc_com.jsonl $W/v3/render_queue.jsonl
py $S/pdf_emails.py $W/v3/in_pdf.jsonl $W/v3/out_pdf.jsonl
node $S/render_v3.mjs $W/v3/render_queue.jsonl $W/v3/render_out.jsonl

echo "== 3. Optional paid connectors (each is skipped unless its API key is set)"
if [ -n "${GOOGLE_PLACES_API_KEY:-}" ]; then
  py $C/places_websites.py $W/v3/in_disc.jsonl $W/v5/places_out.jsonl
  py -c "import sys; sys.path.insert(0, '$C'); import places_websites as p; p.to_site_input('$W/v5/places_out.jsonl', '$W/v5/in_places.jsonl')"
  py $S/enrich_v3.py $W/v5/in_places.jsonl $W/v5/out_places.jsonl $W/v3/render_queue.jsonl 60
fi
[ -n "${HUNTER_API_KEY:-}" ] && py $C/hunter_domains.py $W/v3/in_site.jsonl $W/v5/hunter_out.jsonl

echo "== 4. Validate, opt-out check, export"
py $S/validate_emails.py; py $S/optout_check.py; py $S/campaign_export.py
if [ -n "${ZEROBOUNCE_API_KEY:-}${NEVERBOUNCE_API_KEY:-}" ]; then
  P=$([ -n "${ZEROBOUNCE_API_KEY:-}" ] && echo zerobounce || echo neverbounce)
  py $C/verify_mailboxes.py $L/out/Mission_Control_Campaign_List_VALID_2026-10-31.csv $W/v5/verify_out.jsonl --provider $P
  py $S/validate_emails.py; py $S/campaign_export.py
fi
py $S/side_sheets.py; py $S/write_xlsx.py
echo "Done. Upload $L/out/Mission_Control_Campaign_List_2026-10-31.xlsx to a Mission Control campaign."
