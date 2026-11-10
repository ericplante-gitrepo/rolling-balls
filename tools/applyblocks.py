# Apply SEARCH/REPLACE blocks: python3 applyblocks.py <blocks.txt> <file>; reports misses, applies the rest.
import sys,re
t=open(sys.argv[1]).read(); p=sys.argv[2]; s=open(p).read()
blocks=re.findall(r'<<<<<<< SEARCH\n(.*?)\n=======\n(.*?)\n?>>>>>>> REPLACE',t,re.S)
ok=miss=0
for a,b in blocks:
    n=s.count(a)
    if n==1: s=s.replace(a,b); ok+=1
    else: miss+=1; print('MISS(count=%d):'%n, a[:160].replace('\n','\\n'))
open(p,'w').write(s); print('applied',ok,'missed',miss,'of',len(blocks))
