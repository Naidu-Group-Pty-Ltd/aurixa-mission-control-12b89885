import duckdb, re, collections
con = duckdb.connect('/tmp/leads/work/leads.duckdb')
con.execute("SET threads=4; SET memory_limit='10GB'")
# former-name check: does the register name appear as any (former or current) ASIC name for the ACN?
con.execute("""CREATE OR REPLACE TABLE former AS
  SELECT DISTINCT v.licence_no, v.state FROM v3 v JOIN asic a ON lpad(a.ACN,9,'0') = v.acn_final
  WHERE regexp_replace(upper(a."Company Name"),'[^A-Z0-9]','','g') = regexp_replace(upper(v.reg_name),'[^A-Z0-9]','','g')""")
con.execute("""CREATE OR REPLACE TABLE v4 AS SELECT v.*, (f.licence_no IS NOT NULL) asic_name_hist_match FROM v3 v
  LEFT JOIN former f ON f.licence_no=v.licence_no AND f.state=v.state""")
con.execute("""CREATE OR REPLACE TABLE v5 AS SELECT *,
 CASE
  WHEN abn IS NULL THEN 'EXCLUDE: no ABN could be resolved'
  WHEN abn_status IS NULL THEN 'EXCLUDE: ABN not found in ABR bulk extract'
  WHEN abn_status <> 'ACT' THEN 'EXCLUDE: ABN cancelled in ABR'
  WHEN entity_kind='Company' AND asic_status IS NULL THEN 'EXCLUDE: ACN not found in ASIC company dataset'
  WHEN entity_kind='Company' AND asic_status <> 'REGD' THEN 'EXCLUDE: ASIC status ' || asic_status
  WHEN entity_kind='Individual' AND entity_type_code <> 'IND' THEN 'EXCLUDE: individual licence listed against a non-individual ABN (employee/nominee)'
  WHEN name_score < 70 AND NOT asic_name_hist_match THEN 'EXCLUDE: register name does not match ABR/ASIC name'
  ELSE 'PASS' END validation
 FROM v4""")
print(con.execute("select state, entity_kind, validation, count(*) from v5 group by all order by 1,2,4 desc").fetchall())
