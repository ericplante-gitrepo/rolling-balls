// quick screenshot: node tools/shot.mjs <root> <out.png> <level> <s> [w] [h]
import { chromium } from 'playwright'; import { serve } from './lib.mjs'; import path from 'path';
const [,, r0, out, L, s0, W = 844, H = 390] = process.argv; const { server, base } = await serve(path.resolve(r0));
const b = await chromium.launch({ args: ['--use-gl=swiftshader'] }); const p = await (await b.newContext({ viewport: { width: +W, height: +H } })).newPage();
await p.goto(base); await p.waitForFunction(() => window.__test);
await p.evaluate(([L, s0]) => { const T = window.__test; T.manual = true; T.startLevel(L); const h = T.getBotHint(s0); T.placeBall(s0, h.r || 0, 14, 0); for (let i = 0; i < 40; i++) { const st = T.getState(); const hh = T.getBotHint(st.s); T.setDrag(Math.max(-1, Math.min(1, (hh.r - st.r) * 1.6)), 1); T.tick(1/60); } }, [+L, +s0]);
await p.screenshot({ path: out }); await b.close(); server.close();
