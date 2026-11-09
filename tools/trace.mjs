// usage: node tools/trace.mjs <root> <level> <s0> <s1> [seed] [noise]
import { chromium } from 'playwright'; import { serve } from './lib.mjs'; import fs from 'fs'; import path from 'path';
const [,, r0, L, s0, s1, seed = 1, noise = 0] = process.argv; const root = path.resolve(r0);
const acc = fs.readFileSync(new URL('./accept3.mjs', import.meta.url), 'utf8');
let bot = acc.slice(acc.indexOf('window.__bot = function'), acc.indexOf('};`;', acc.indexOf('window.__bot = function')) + 2);
bot = bot.replace('T.tick(dt); t += dt;', 'T.tick(dt); t += dt; { const q = T.getState(); if (q.s > window.__S0 && q.s < window.__S1 && window.__tr.length < 400) { const hh = T.getBotHint(q.s); window.__tr.push([+t.toFixed(2), +q.s.toFixed(2), +q.r.toFixed(2), +q.vs.toFixed(1), +q.vr.toFixed(1), q.status, q.grounded, +hh.r.toFixed(2), hh.throttle, hh.brakeTo]); } }');
const { server, base } = await serve(root);
const b = await chromium.launch({ args: ['--use-gl=swiftshader'] });
const p = await (await b.newContext({ viewport: { width: 400, height: 300 } })).newPage();
await p.goto(base); await p.waitForFunction(() => window.__test);
await p.evaluate(() => { window.__test.manual = true; window.__test.render = false; }); await p.evaluate(bot);
const r = await p.evaluate(([L, s0, s1, seed, noise]) => { window.__S0 = s0; window.__S1 = s1; window.__tr = []; const res = window.__bot(L, seed, { noise, maxT: 60 }); return { res, tr: window.__tr }; }, [+L, +s0, +s1, +seed, +noise]);
console.log(JSON.stringify(r.res)); for (const x of r.tr.filter((_, i) => i % 3 === 0)) console.log(JSON.stringify(x));
await b.close(); server.close();
