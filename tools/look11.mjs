// v1.1 camera/look shots + ball on-screen metrics at 4 sizes. Usage: node tools/look11.mjs <outDir>
import { chromium } from 'playwright';
import path from 'path'; import fs from 'fs';
import { serve } from './lib.mjs';
const OUT = process.argv[2]; fs.mkdirSync(OUT, { recursive: true });
const { server, base } = await serve(path.resolve('.'));
const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
const res = {};
for (const [w, h] of [[844, 390], [390, 844], [1024, 768], [1180, 820]]) {
  const page = await (await b.newContext({ viewport: { width: w, height: h } })).newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e))); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(base); await page.waitForFunction(() => window.__test);
  const tag = `${w}x${h}`;
  // L1 start: ball at rest, then rolling at cruise speed
  const m = await page.evaluate(() => { const T = window.__test; T.manual = true; T.startLevel(1); T.clearDrag(); for (let i = 0; i < 60; i++) T.tick(1/60);
    const rest = T.ballScreen(); T.setDrag(0, 1); for (let i = 0; i < 150; i++) T.tick(1/60); const cruise = T.ballScreen(); const v = T.getState().speed; T.clearDrag(); return { rest, cruise, speed: v }; });
  await page.evaluate(() => { const T = window.__test; T.startLevel(1); T.clearDrag(); for (let i = 0; i < 60; i++) T.tick(1/60); });
  await page.screenshot({ path: path.join(OUT, `L1-start-${tag}.png`) });
  await page.evaluate(() => { const T = window.__test; T.startLevel(2); T.teleport(0, 1, 14); T.setDrag(0, 0.8); for (let i = 0; i < 70; i++) T.tick(1/60); T.clearDrag(); });
  await page.screenshot({ path: path.join(OUT, `L2-cubes-${tag}.png`) });
  await page.evaluate(() => { const T = window.__test; const C = T.getConfig(); T.startLevel(4); T.teleport(C.SCREEN_RIGHT_X, 3, 56); T.setDrag(0, 0.6); for (let i = 0; i < 60; i++) T.tick(1/60); T.clearDrag(); });
  await page.screenshot({ path: path.join(OUT, `L4-rails-${tag}.png`) });
  // fall frame: roll off L2's open screen-right edge, shoot ~0.8 s into the fall
  const fall = await page.evaluate(() => { const T = window.__test; T.startLevel(2); T.teleport(0, 1, 50); T.setDrag(1, 0.6);
    let cam0 = null; for (let i = 0; i < 600; i++) { T.tick(1/60); const s = T.getState(); if (s.status !== 'playing') { cam0 = T.getCamera(); break; } }
    T.clearDrag(); for (let i = 0; i < 48; i++) T.tick(1/60); const c = T.getCamera(); const s = T.getState();
    return { camMoved: cam0 ? +Math.hypot(c.x - cam0.x, c.y - cam0.y, c.z - cam0.z).toFixed(3) : null, ballY: +s.ball.y.toFixed(2), ballOnScreen: T.ballScreen(), status: s.status }; });
  await page.screenshot({ path: path.join(OUT, `fall-${tag}.png`) });
  res[tag] = { ...m, fall, errors };
}
await b.close(); server.close();
fs.writeFileSync(path.join(OUT, 'look11-metrics.json'), JSON.stringify(res, null, 2));
for (const [k, v] of Object.entries(res)) console.log(k, 'rest y', v.rest.cy.toFixed(3), 'h', v.rest.heightFrac.toFixed(3), '| cruise y', v.cruise.cy.toFixed(3), 'h', v.cruise.heightFrac.toFixed(3), 'v', v.speed.toFixed(1), '| fall', JSON.stringify(v.fall).slice(0, 160), v.errors.length);
