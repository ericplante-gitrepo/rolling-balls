# Render the gap table (target, measured, pass/fail) from tools/accept3-results.json as markdown.
import json,sys
d=json.load(open('/workspace/rolling-balls-s3/tools/accept3-results.json'))
out=[f"Suite: {d['pass']} pass / {d['fail']} fail / {d['skip']} skip ({d['seedsPerLevel']} noisy seeds per level, {d['when']})\n","| Gap item | Target | Measured | Result |","|---|---|---|---|"]
for item,rows in d['gap'].items():
    for r in rows:
        m=str(r['measured']).replace('|','/').replace('\n',' ')
        out.append(f"| {item} | {r['target']} | {m[:300]} | {'PASS' if r['pass'] else 'FAIL'} |")
out.append("\n| Level | Nominal bot s | Noisy clean runs | Median s |\n|---|---|---|---|")
for k,v in d['perLevel'].items(): out.append(f"| L{k} | {v['nominalSec']} | {v['cleanRuns']}/{v['runs']} | {v.get('medianSec')} |")
print('\n'.join(out))
