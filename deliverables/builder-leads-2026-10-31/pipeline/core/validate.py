import duckdb
from rapidfuzz import fuzz
con = duckdb.connect('/tmp/leads/work/leads.duckdb')
con.execute("SET threads=4; SET memory_limit='10GB'")
con.execute("""CREATE OR REPLACE TABLE v AS
 SELECT r.*, b.abn_status, b.abn_status_from, b.entity_type_code, b.entity_type, b.entity_name abr_name, b.state abr_state, b.postcode abr_postcode,
        nullif(b.acn,'') abr_acn, b.gst_status, b.gst_from, b.other_names,
        coalesce(nullif(lpad(r.reg_acn,9,'0'),'000000000'), nullif(lpad(b.acn,9,'0'),'000000000')) acn_final
 FROM reg3 r LEFT JOIN abr b ON b.abn = r.abn""")
con.execute("""CREATE OR REPLACE TABLE v2 AS SELECT v.*, a.asic_name, a.asic_type, a.asic_class, a.asic_subclass, a.asic_status, a.asic_reg_date, a.asic_abn asic_abn2
 FROM v LEFT JOIN asic_cur a ON a.acn = v.acn_final""")
df = con.execute("select * from v2").df()
import re
def norm(s):
    s = s.upper() if isinstance(s, str) else ''
    s = re.sub(r'\b(PTY|LTD|LIMITED|PROPRIETARY|CO|COMPANY|THE|TRUSTEE|FOR|ATF|AS|TRUST|AUSTRALIA)\b', ' ', s)
    return re.sub(r'[^A-Z0-9 ]', ' ', s)
df['name_score'] = [max(fuzz.token_set_ratio(norm(a), norm(b)) if isinstance(b,str) else 0, fuzz.token_set_ratio(norm(a), norm(c)) if isinstance(c,str) else 0)
                    for a, b, c in zip(df.reg_name, df.abr_name, df.asic_name)]
con.register('dfv', df)
con.execute("CREATE OR REPLACE TABLE v3 AS SELECT * FROM dfv")
print(con.execute("""select state, entity_kind, count(*) n, count(abn) has_abn, sum(abn_status='ACT') abn_active, sum(abn_status='CAN') abn_cancelled,
   sum(asic_status='REGD') asic_regd, sum(asic_status in ('DRGD','SOFF','EXAD')) asic_bad, sum(name_score<70) weak_name
   from v3 group by all""").fetchall())
print(con.execute("select reg_name, abr_name, asic_name, name_score from v3 where name_score<70 and abn is not null limit 25").fetchall())
