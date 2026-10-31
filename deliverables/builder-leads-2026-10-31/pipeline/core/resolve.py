import duckdb, re
con = duckdb.connect('/tmp/leads/work/leads.duckdb')
con.execute("SET threads=4; SET memory_limit='10GB'")
con.execute("""CREATE OR REPLACE MACRO abn_ok(a) AS (len(a)=11 AND regexp_matches(a,'^\\d{11}$') AND
 ((CAST(substr(a,1,1) AS INT)-1)*10 + CAST(substr(a,2,1) AS INT)*1 + CAST(substr(a,3,1) AS INT)*3 + CAST(substr(a,4,1) AS INT)*5 +
  CAST(substr(a,5,1) AS INT)*7 + CAST(substr(a,6,1) AS INT)*9 + CAST(substr(a,7,1) AS INT)*11 + CAST(substr(a,8,1) AS INT)*13 +
  CAST(substr(a,9,1) AS INT)*15 + CAST(substr(a,10,1) AS INT)*17 + CAST(substr(a,11,1) AS INT)*19) % 89 = 0)""")
con.execute("""CREATE OR REPLACE TABLE asic_cur AS
 SELECT lpad(ACN,9,'0') acn, "Company Name" asic_name, Type asic_type, Class asic_class, "Sub Class" asic_subclass, Status asic_status,
        "Date of Registration" asic_reg_date, "Date of Deregistration" asic_dereg_date, CASE WHEN length(ABN)=11 THEN ABN END asic_abn
 FROM asic WHERE "Current Name Indicator"='Y'""")
# pick one ABR record per ACN (prefer active)
con.execute("""CREATE OR REPLACE TABLE abr_by_acn AS SELECT * FROM (
  SELECT *, row_number() OVER (PARTITION BY lpad(acn,9,'0') ORDER BY (abn_status='ACT') DESC, abn_status_from DESC) rn FROM abr WHERE acn IS NOT NULL AND acn<>'')
  WHERE rn=1""")
con.execute("""CREATE OR REPLACE TABLE reg2 AS
 SELECT r.*, CASE WHEN abn_ok(r.reg_abn) THEN r.reg_abn END reg_abn_ok,
   a.asic_abn, b.abn abr_acn_abn
 FROM reg r LEFT JOIN asic_cur a ON a.acn = lpad(r.reg_acn,9,'0') AND r.reg_acn IS NOT NULL
 LEFT JOIN abr_by_acn b ON lpad(b.acn,9,'0') = lpad(r.reg_acn,9,'0') AND r.reg_acn IS NOT NULL""")
print(con.execute("select state, entity_kind, count(*), sum(reg_abn is not null and reg_abn_ok is null) bad_checksum, sum(coalesce(reg_abn_ok, asic_abn, abr_acn_abn) is not null) resolved from reg2 group by all").fetchall())
# ---- individuals without ABN: match ABR individual by name + postcode ----
con.execute("""CREATE OR REPLACE MACRO nm(s) AS trim(regexp_replace(regexp_replace(upper(s),'[^A-Z ]',' ','g'),' +',' ','g'))""")
con.execute("""CREATE OR REPLACE TABLE ind_need AS SELECT licence_no, nm(reg_name) n, postcode,
   split_part(nm(reg_name),' ',1) || ' ' || split_part(nm(reg_name),' ',-1) n2 FROM reg2
   WHERE entity_kind='Individual' AND reg_abn_ok IS NULL""")
con.execute("""CREATE OR REPLACE TABLE abr_ind AS SELECT abn, nm(entity_name) n, split_part(nm(entity_name),' ',1)||' '||split_part(nm(entity_name),' ',-1) n2, postcode, state
   FROM abr WHERE entity_type_code='IND' AND abn_status='ACT' AND state='QLD'""")
con.execute("""CREATE OR REPLACE TABLE ind_match AS
 WITH m1 AS (SELECT i.licence_no, list(a.abn) abns FROM ind_need i JOIN abr_ind a ON a.n=i.n AND a.postcode=i.postcode GROUP BY 1),
      m2 AS (SELECT i.licence_no, list(a.abn) abns FROM ind_need i JOIN abr_ind a ON a.n2=i.n2 AND a.postcode=i.postcode
             WHERE i.licence_no NOT IN (SELECT licence_no FROM m1) GROUP BY 1)
 SELECT licence_no, abns[1] abn, 'ABR exact name + postcode' how FROM m1 WHERE len(abns)=1
 UNION ALL SELECT licence_no, abns[1], 'ABR first+last name + postcode' FROM m2 WHERE len(abns)=1""")
print(con.execute("select how, count(*) from ind_match group by 1").fetchall(), con.execute("select count(*) from ind_need").fetchall())
con.execute("""CREATE OR REPLACE TABLE reg3 AS SELECT r.*,
  coalesce(r.reg_abn_ok, r.asic_abn, r.abr_acn_abn, m.abn) abn,
  CASE WHEN r.reg_abn_ok IS NOT NULL THEN 'Register-listed ABN'
       WHEN r.asic_abn IS NOT NULL THEN 'ASIC company dataset (ACN to ABN)'
       WHEN r.abr_acn_abn IS NOT NULL THEN 'ABR bulk extract (ACN to ABN)'
       WHEN m.abn IS NOT NULL THEN m.how END abn_source
  FROM reg2 r LEFT JOIN ind_match m USING (licence_no)""")
print(con.execute("select state, entity_kind, count(*), count(abn) from reg3 group by all").fetchall())
