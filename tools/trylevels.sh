#!/bin/bash
# usage: tools/trylevels.sh <levelDef.js> <dir>  -> copies repo to <dir>, swaps levelDef, runs levelsim 40 seeds
set -e; SRC=/workspace/rolling-balls-s3; rm -rf "$2"; mkdir -p "$2"; cp -r $SRC/index.html $SRC/vendor $SRC/tools $SRC/game.js "$2"/; ln -s $SRC/node_modules "$2"/node_modules
python3 - "$1" "$2/game.js" <<'PY'
import sys; new=open(sys.argv[1]).read(); p=sys.argv[2]; g=open(p).read()
i=g.index("  function levelDef(n) {"); j=g.index("  function disposeRoot()")
new='\n'.join(('  '+l if l.strip() else l) for l in new.strip('\n').split('\n'))+'\n\n'
open(p,'w').write(g[:i]+new+g[j:])
PY
node --check "$2/game.js"; cd "$2" && timeout 600 node tools/levelsim.mjs . ${3:-40} 2>&1 | grep "^L\|TOTAL" | cut -c1-200
