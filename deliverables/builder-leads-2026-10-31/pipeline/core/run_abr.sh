cd /tmp/leads
for z in raw/abr/public_split_1_10.zip raw/abr/public_split_11_20.zip; do
  python3 -I -c "import zipfile,sys;[print(n) for n in zipfile.ZipFile(sys.argv[1]).namelist()]" $z | while read m; do echo "$z $m"; done
done | xargs -P 3 -n 2 sh -c 'python3 -I scripts/abr_extract.py "$0" "$1" "work/abr/$(basename $1 .xml).tsv"'
echo ALLDONE
