# Build a name -> ABN lookup index (active ABNs only) from ASIC company names, ASIC business names and ABR names.
import duckdb
con = duckdb.connect('/tmp/leads/work/leads.duckdb')
con.execute("SET threads=4; SET memory_limit='10GB'")
con.execute(r"""CREATE OR REPLACE MACRO nkey(s) AS trim(regexp_replace(regexp_replace(regexp_replace(
   ' ' || regexp_replace(upper(s), '[^A-Z0-9 ]', ' ', 'g') || ' ',
   ' (THE TRUSTEE FOR|TRUSTEE FOR|ATF|PTY|PROPRIETARY|LTD|LIMITED|P L|CO|THE|AND|TRUST|UNIT TRUST|FAMILY TRUST|DISCRETIONARY TRUST) ', ' ', 'g'),
   ' (PTY|LTD|LIMITED|THE|AND|CO|TRUST) ', ' ', 'g'), ' +', ' ', 'g'))""")
con.execute("""CREATE OR REPLACE TABLE name_idx AS
 WITH act AS (SELECT abn, state FROM abr WHERE abn_status='ACT')
 SELECT DISTINCT k, abn, src FROM (
   SELECT nkey(a.asic_name) k, coalesce(a.asic_abn, b.abn) abn, 'ASIC company name' src FROM asic_cur a LEFT JOIN abr_by_acn b ON lpad(b.acn,9,'0')=a.acn WHERE a.asic_status='REGD'
   UNION ALL SELECT nkey(BN_NAME), BN_ABN, 'ASIC business name' FROM bn WHERE BN_STATUS='Registered' AND length(BN_ABN)=11
   UNION ALL SELECT nkey(entity_name), abn, 'ABR entity name' FROM abr WHERE abn_status='ACT' AND entity_type_code<>'IND'
 ) x WHERE abn IN (SELECT abn FROM act) AND length(k) >= 3""")
print(con.execute("select count(*), count(distinct k) from name_idx").fetchall())
