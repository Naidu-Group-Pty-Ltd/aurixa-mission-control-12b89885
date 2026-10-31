import duckdb
con = duckdb.connect('/tmp/leads/work/leads.duckdb')
con.execute("SET threads=4; SET memory_limit='10GB'")
con.execute("""CREATE OR REPLACE TABLE abr AS SELECT * FROM read_csv('/tmp/leads/work/abr/*.tsv', delim='\t', header=false, quote='', escape='',
  columns={'abn':'VARCHAR','abn_status':'VARCHAR','abn_status_from':'VARCHAR','entity_type_code':'VARCHAR','entity_type':'VARCHAR','entity_name':'VARCHAR',
  'state':'VARCHAR','postcode':'VARCHAR','acn':'VARCHAR','gst_status':'VARCHAR','gst_from':'VARCHAR','abr_updated':'VARCHAR','other_names':'VARCHAR'}, ignore_errors=true)""")
print(con.execute("select count(*), count(distinct abn), sum(abn_status='ACT') from abr").fetchall())
con.execute("""CREATE OR REPLACE TABLE asic AS SELECT * FROM read_csv('/tmp/leads/raw/asic/COMPANY_202610.csv', delim='\t', header=true, quote='', all_varchar=true, ignore_errors=true)""")
print(con.execute("describe asic").fetchall())
print(con.execute("select count(*) from asic").fetchall())
con.execute("""CREATE OR REPLACE TABLE bn AS SELECT * FROM read_csv('/tmp/leads/raw/asic/BUSINESS_NAMES_202610.csv', delim='\t', header=true, quote='', all_varchar=true, ignore_errors=true)""")
print(con.execute("select count(*) from bn").fetchall())
