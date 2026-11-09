// Level tuning helper: nominal + N noisy seeds per level, prints clean rate and fall spots.
// usage: node tools/levelsim.mjs <root> [seeds=20] [levels=1-10] [traceLevel:s0:s1]
import { chromium } from 'playwright'; import { serve } from './lib.mjs'; import fs from 'fs'; import path from 'path';
const root = path.resolve(process.argv[2]); const N = +(process.argv[3] || 20);
const lv = (process.argv[4] || '1-10').split('-').map(Number); const levels = []; for (let i = lv[0]; i <= (lv[1] || lv[0]); i++) levels.push(i);
const acc = fs.readFileSync(new URL('./accept3.mjs', import.meta.url), 'utf8');
const bot = acc.slice(acc.indexOf('window.__bot = function'), acc.indexOf('};`;', acc.indexOf('window.__bot = function')) + 2);
const { server, base } = await serve(root);
const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
const p = await (await b.newContext({ viewport: { width: 640, height: 480 } })).newPage();
const errs = []; p.on('pageerror', e => errs.push(String(e)));
await p.goto(base); await p.waitForFunction(() => window.__test);
await p.evaluate(() => { window.__test.manual = true; window.__test.render = false; }); await p.evaluate(bot);
let clean = 0, tot = 0;
for (const L of levels) {
  const r = await p.evaluate(([L, N]) => { const nom = window.__bot(L, 1, { noise: 0 }); const runs = []; for (let s = 1; s <= N; s++) runs.push(window.__bot(L, 1000 + s * 31, { noise: 0.35, maxT: 120 }));
    const len = window.__test.getTrackInfo ? window.__test.getTrackInfo().length : null; return { nom, runs, len }; }, [L, N]);
  const c = r.runs.filter(x => x.done && x.falls === 0).length; clean += c; tot += N;
  const spots = r.runs.flatMap(x => x.fallAt).sort((a, b) => a - b);
  console.log(`L${L} len=${r.len && r.len.toFixed ? r.len.toFixed(0) : JSON.stringify(r.len)} nominal t=${r.nom.t} falls=${r.nom.falls} at ${JSON.stringify(r.nom.fallAt)} | noisy clean ${c}/${N} falls@ ${JSON.stringify(spots)}`);
}
console.log(`TOTAL clean ${clean}/${tot} = ${(100 * clean / tot).toFixed(1)}%`, 'errors', errs.slice(0, 3));
await b.close(); server.close();
