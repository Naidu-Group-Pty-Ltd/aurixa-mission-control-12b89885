import duckdb
con = duckdb.connect('/tmp/leads/work/leads.duckdb')
con.execute("SET threads=4; SET memory_limit='10GB'")
# business names per ABN (registered only)
con.execute("""CREATE OR REPLACE TABLE bn_abn AS SELECT BN_ABN abn, string_agg(DISTINCT trim(BN_NAME), ' | ') bns, count(DISTINCT trim(BN_NAME)) n_bn
  FROM bn WHERE BN_STATUS='Registered' AND BN_ABN IS NOT NULL AND BN_ABN<>'' GROUP BY 1""")
con.execute("""CREATE OR REPLACE TABLE lead_core AS
 WITH p AS (SELECT * FROM v5 WHERE validation='PASS'),
 fin AS (SELECT abn, max(CASE fin_cat_code WHEN 'SC1' THEN 1 WHEN 'SC2' THEN 2 WHEN 'EMRSC1' THEN 1 WHEN 'EMRSC2' THEN 2 WHEN '1' THEN 3 WHEN 'EMR1-2' THEN 3
        WHEN '2' THEN 4 WHEN '3' THEN 5 WHEN 'EMR3-7' THEN 5 WHEN '4' THEN 6 WHEN '5' THEN 7 WHEN '6' THEN 8 WHEN '7' THEN 9 END) fin_rank FROM p GROUP BY 1)
 SELECT abn,
   any_value(abr_name) abr_name, any_value(asic_name) asic_name, any_value(reg_name ORDER BY state) reg_name,
   string_agg(DISTINCT state, ', ' ORDER BY state) licence_states,
   string_agg(DISTINCT state || ': ' || licence_no, '; ') licence_numbers,
   string_agg(DISTINCT classes, '; ') licence_classes,
   string_agg(DISTINCT CASE WHEN fin_cat_code NOT IN ('N/A') THEN fin_cat_code END, ', ') qbcc_fin_cats,
   any_value(address) FILTER (WHERE address IS NOT NULL) address,
   any_value(entity_kind) entity_kind, any_value(entity_type_code) entity_type_code, any_value(entity_type) entity_type,
   any_value(abn_status) abn_status, any_value(abn_status_from) abn_status_from, any_value(gst_status) gst_status, any_value(gst_from) gst_from,
   any_value(abr_state) abr_state, any_value(abr_postcode) abr_postcode, any_value(postcode) FILTER (WHERE postcode IS NOT NULL) reg_postcode,
   any_value(acn_final) acn, any_value(asic_status) asic_status, any_value(asic_type) asic_type, any_value(asic_class) asic_class, any_value(asic_subclass) asic_subclass,
   any_value(asic_reg_date) asic_reg_date, any_value(other_names) abr_other_names, string_agg(DISTINCT abn_source, '; ') abn_source,
   min(name_score) min_name_score, bool_or(asic_name_hist_match) renamed_flag, max(expiry) vic_expiry
 FROM p GROUP BY abn""")
con.execute("""CREATE OR REPLACE TABLE lead_core2 AS SELECT l.*, f.fin_rank, b.bns, coalesce(b.n_bn,0) n_bn FROM lead_core l
   LEFT JOIN (SELECT abn, max(CASE fin_cat_code WHEN 'SC1' THEN 1 WHEN 'SC2' THEN 2 WHEN 'EMRSC1' THEN 1 WHEN 'EMRSC2' THEN 2 WHEN '1' THEN 3 WHEN 'EMR1-2' THEN 3
        WHEN '2' THEN 4 WHEN '3' THEN 5 WHEN 'EMR3-7' THEN 5 WHEN '4' THEN 6 WHEN '5' THEN 7 WHEN '6' THEN 8 WHEN '7' THEN 9 END) fin_rank FROM v5 WHERE validation='PASS' GROUP BY 1) f USING (abn)
   LEFT JOIN bn_abn b USING (abn)""")
print(con.execute("select licence_states, entity_kind, count(*) from lead_core2 group by all order by 3 desc").fetchall())
print(con.execute("select fin_rank, count(*) from lead_core2 group by 1 order by 1").fetchall())
print(con.execute("select asic_type, asic_class, asic_subclass, count(*) from lead_core2 group by all order by 4 desc limit 8").fetchall())
