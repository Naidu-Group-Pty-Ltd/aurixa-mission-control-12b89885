import re,html,sys
def text(path):
    t=open(path,encoding='utf-8',errors='replace').read()
    t=re.sub(r'<script.*?</script>|<style.*?</style>|<nav.*?</nav>|<header.*?</header>|<footer.*?</footer>','',t,flags=re.S|re.I)
    t=re.sub(r'<(br|/p|/li|/tr|/h\d|/div|/td|/th)[^>]*>','\n',t,flags=re.I)
    s=html.unescape(re.sub(r'<[^>]+>',' ',t))
    s=re.sub(r'[ \t\r\f\v]+',' ',s)
    s=re.sub(r'\n\s*\n+','\n',s)
    return s
if __name__=='__main__':
    s=text(sys.argv[1])
    start=sys.argv[2] if len(sys.argv)>2 else None
    if start:
        i=s.find(start); s=s[i:] if i>=0 else s
    n=int(sys.argv[3]) if len(sys.argv)>3 else 6000
    print(s[:n])
