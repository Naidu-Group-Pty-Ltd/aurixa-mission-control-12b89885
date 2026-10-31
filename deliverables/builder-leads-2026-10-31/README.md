# Australian builders & developers — validated lead list (31 Oct 2026)

**File:** `Builders_Developers_Validated_Leads_AU_2026-10-31.xlsx`

## What is in it

| Sheet                         | Rows   | What it is                                                                                                                                                         |
| ----------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Summary                       | —      | Totals, organisation size × state, priority and exclusion counts                                                                                                   |
| Leads - Organisations         | 28,507 | Companies, trusts and partnerships with a current builder licence (or industry/government listing), an **active ABN** and, for companies, **ASIC status Registered** |
| Leads - Sole Traders          | 6,710  | Individual licensed builders with an active sole-trader ABN (no street address, by design)                                                                         |
| Original List - Validated     | 50     | Your Top-10 list with matched ABN, ABR/ASIC status, size, and a "Check" note where a manual look is needed                                                         |
| Excluded - Needs Review       | 3,109  | Organisations found in the sources that failed validation, with the reason (no ABN, ABN cancelled, deregistered, under administration, ambiguous name…)             |
| Methodology & Sources         | —      | Exactly how "active", ABN validation and organisation size were determined                                                                                         |

**Total validated leads: 35,217**. Of these, 8,447 have a phone or email, 8,803 have a confirmed company website (1,531 verified by the ABN printed on the site) and 935 are matched Master Builders members.

## Organisation size

Bands follow the QBCC financial categories (annual construction revenue):

| Size                | Leads  |
| ------------------- | ------ |
| Enterprise (>$240M) | 155    |
| Large ($30M–$240M)  | 643    |
| Medium ($3M–$30M)   | 5,343  |
| Small ($0.8M–$3M)   | 11,476 |
| Micro (<$0.8M)      | 17,600 |

- **High confidence (15,228 leads):** QBCC financial category, HIA Housing 100 rank, or ASIC-listed company.
- **Medium confidence (200 leads):** QBCC estimated category, or listed in your Top-10 list.
- **Low confidence (19,789 leads):** an estimate from public signals: years registered, number of licence states, commercial class, number of business names, GST status. Use it as a guide and confirm on first contact.

## Validation applied to every lead

1. ABN checksum (ATO modulus-89).
2. ABN **Active** in the ABR bulk extract dated 28 Oct 2026.
3. Companies: ACN **Registered** in the ASIC company dataset (Oct 2026). Deregistered, strike-off and external-administration companies were removed.
4. Licence register name matched against the ABR and ASIC names, allowing for renamed companies (checked against ASIC name history).
5. Current licence or registration on a state register, or a current industry or government listing.

Each row carries an `ABN Lookup` link to abr.business.gov.au, so anyone can re-check it.

## Sources

QBCC register (QLD, 30 Oct 2026); BPC/VBA register (VIC); WA Building Services Board register (30 Oct 2026); ACT builder licences (data.act.gov.au); NT Building Practitioners Board; NSW Fair Trading contractor-licence file (Dec 2023, flagged); ABR bulk extract; ASIC company and business-names datasets; Master Builders WA, SA, ACT and NT member directories; UDIA QLD and VIC; HIA Housing 100; WA Housing Authority builders panel; TAS Treasury prequalification register.

**Not collected:**

- SA and TAS licence registers, and the Master Builders NSW and QLD directories: these use Cloudflare/JS challenges or reCAPTCHA.
- Master Builders VIC and TAS directories: their robots.txt excludes Claude's crawler.

Members of those associations still appear when they hold a licence on a register above.

## Before outreach

Contact details are business contact points published by the business itself or by its association directory. Apply your Spam Act 2003 / Privacy Act 1988 process (consent, identification, unsubscribe) before emailing.

## Re-running

`pipeline/core` contains the scripts that build the list. Run them in this order:

1. `fetch_qbcc.py`, `run_abr.sh` / `abr_extract.py`, `load_db.py`
2. `norm_regs.py`, `resolve.py`, `validate.py`, `build_core.py`, `consolidate.py`
3. `name_index.py`, `enrich_web.py`
4. `regs_resolve.py`, `filter_mba.py`, then `ext_resolve.py` (once each for `mba` and `dev`)
5. `assemble.py`, `side_sheets.py`, `write_xlsx.py`

`pipeline/collectors` holds the per-source collectors. The scripts expect a scratch workspace under `/tmp/leads`.
