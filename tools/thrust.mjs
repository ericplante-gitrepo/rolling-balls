// Realistic-touch forward-speed probe: finger down, drag mostly sideways (little/no upward travel),
// hold for 3 s, then release and coast 2 s. Prints speed over time per viewport.
// Usage: node tools/thrust.mjs <gameDir> [WxH,...]
import { chromium } from 'playwright'; import path from 'path';
import { serve } from './lib.mjs';
const ROOT = path.resolve(process.argv[2] || '.');
const SIZES = (process.argv[3] || '1024x768,1180x820').split(',').map(s => s.split('x').map(Number));
const { server, base } = await serve(ROOT);
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
const out = [];
for (const [w, h] of SIZES) for (const up of [0, 0.03]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true, isMobile: w < 900 });
  const page = await ctx.newPage(); page.setDefaultTimeout(120000);
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.goto(base, { waitUntil: 'load' }); await page.waitForFunction(() => window.__test && window.__test.getState);
  await page.evaluate(() => { const T = window.__test; T.manual = true; T.render = false; T.startLevel(1); for (let i = 0; i < 40; i++) T.tick(1/60); });
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 0 }] });
  const sp = () => page.evaluate(() => { const s = window.__test.getState(); return +(s.vs ?? s.speed ?? 0).toFixed(2); });
  const tick = n => page.evaluate(n => { for (let i = 0; i < n; i++) window.__test.tick(1/60); }, n);
  const cx = Math.round(w / 2), cy = Math.round(h * 0.75);
  await touch('touchStart', cx, cy);
  // sideways-dominant drag: 25% of width right, `up` share of height upward, over 5 moves
  for (let k = 1; k <= 5; k++) { await touch('touchMove', cx + Math.round(0.05 * k * w), cy - Math.round(up * h * k / 5)); await tick(1); }
  const held = []; for (let i = 0; i < 12; i++) { await tick(15); held.push(await sp()); }
  const drag = await page.evaluate(() => window.__test.getDrag ? window.__test.getDrag() : null);
  await touch('touchEnd');
  const v0 = await sp(); const coast = []; for (let i = 0; i < 8; i++) { await tick(15); coast.push(await sp()); }
  const ts = held.findIndex(v => v >= 0.9 * 16);
  out.push({ size: `${w}x${h}`, upShare: up, drag, heldEvery0p25s: held, t90: ts < 0 ? null : (ts + 1) * 0.25, coastFrom: v0, coastEvery0p25s: coast, lossAfter1s: v0 > 0 ? +(1 - coast[3] / v0).toFixed(3) : null, errors });
  await ctx.close();
}
console.log(JSON.stringify(out, null, 1));
await browser.close(); server.close();
