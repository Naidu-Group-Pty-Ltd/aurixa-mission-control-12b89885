# Stream an ABR bulk-extract XML member out of a zip and emit a compact TSV.
import sys, re, zipfile, html
zpath, member, out = sys.argv[1], sys.argv[2], sys.argv[3]
r_abn = re.compile(r'<ABN status="(\w+)" ABNStatusFromDate="(\d+)">(\d{11})</ABN>')
r_et = re.compile(r'<EntityTypeInd>(\w+)</EntityTypeInd><EntityTypeText>([^<]*)</EntityTypeText>')
r_main = re.compile(r'<MainEntity><NonIndividualName type="MN"><NonIndividualNameText>([^<]*)</NonIndividualNameText>')
r_ind = re.compile(r'<LegalEntity><IndividualName type="LGL">(.*?)</IndividualName>')
r_given = re.compile(r'<GivenName>([^<]*)</GivenName>')
r_fam = re.compile(r'<FamilyName>([^<]*)</FamilyName>')
r_addr = re.compile(r'<State>([^<]*)</State><Postcode>([^<]*)</Postcode>')
r_acn = re.compile(r'<ASICNumber ASICNumberType="[^"]*">(\d*)</ASICNumber>')
r_gst = re.compile(r'<GST status="(\w+)" GSTStatusFromDate="(\d+)"')
r_oth = re.compile(r'<NonIndividualName type="(TRD|BN|OTN)"><NonIndividualNameText>([^<]*)</NonIndividualNameText>')
r_upd = re.compile(r'recordLastUpdatedDate="(\d+)"')
def clean(s): return html.unescape(s).replace('\t', ' ').strip()
with zipfile.ZipFile(zpath) as z, z.open(member) as f, open(out, 'w') as o:
    buf = b''
    for chunk in iter(lambda: f.read(1 << 24), b''):
        buf += chunk
        parts = buf.split(b'</ABR>')
        buf = parts.pop()
        for p in parts:
            s = p.decode('utf-8', 'replace')
            m = r_abn.search(s)
            if not m: continue
            et = r_et.search(s); mn = r_main.search(s)
            if mn: name = clean(mn.group(1))
            else:
                ind = r_ind.search(s); name = ''
                if ind:
                    g = ' '.join(r_given.findall(ind.group(1))); fm = r_fam.search(ind.group(1))
                    name = clean((g + ' ' + (fm.group(1) if fm else '')).strip())
            ad = r_addr.search(s); acn = r_acn.search(s); gst = r_gst.search(s); up = r_upd.search(s)
            others = ' | '.join(sorted({clean(x[1]) for x in r_oth.findall(s)}))[:1000]
            o.write('\t'.join([m.group(3), m.group(1), m.group(2), et.group(1) if et else '', clean(et.group(2)) if et else '',
                name, ad.group(1) if ad else '', ad.group(2) if ad else '', acn.group(1) if acn else '',
                gst.group(1) if gst else '', gst.group(2) if gst else '', up.group(1) if up else '', others]) + '\n')
print('ok', member)
