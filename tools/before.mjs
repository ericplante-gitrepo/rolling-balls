// Measures the a772f87 build (with a 2-line probe hook) for the bugs Eric saw, and takes "before" shots.
import { chromium } from 'playwright';
import fs from 'fs'; import path from 'path';
import { serve, SPIN_PROBE } from './lib.mjs';
const DIR = process.argv[2]; const SHOTS = process.argv[3];
const { server, base } = await serve(DIR);
const browser = await chromium.launch();
const sizes = [[844, 390], [390, 844], [1024, 768], [1180, 820]];
const res = {};
for (const [w, h] of sizes) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.goto(base); await page.waitForFunction(() => window.__test);
  await page.addScriptTag({ content: SPIN_PROBE });
  if (w === 1180) {
    res.spinForward = await page.evaluate(() => { const T = window.__test; T.startLevel(1); T.setDrag(0, 1); return window.__spinProbe(120, 1 / 60); });
    res.steerRight = await page.evaluate(() => { const T = window.__test; T.startLevel(1); T.setDrag(0, 0.6); for (let i = 0; i < 30; i++) T.tick(1/60);
      const a = T.projectBall(); T.setDrag(1, 0.6); for (let i = 0; i < 20; i++) T.tick(1/60); const b = T.projectBall();
      return { screenDx: +(b.sx - a.sx).toFixed(1), note: 'drag nx=+1 (finger right); positive = ball moved right on screen' }; });
    res.pullBack = await page.evaluate(() => { const T = window.__test; T.startLevel(1); T.setDrag(0, -1); for (let i = 0; i < 60; i++) T.tick(1/60); return { vzAfter1s: +T.getState().ball.vz.toFixed(2) }; });
    res.l1FullThrottleSec = await page.evaluate(() => { const T = window.__test; T.startLevel(1); T.setDrag(0, 1); let t = 0; for (let i = 0; i < 3600; i++) { T.tick(1/60); t += 1/60; if (T.getState().status === 'complete') break; } return +t.toFixed(2); });
  }
  await page.evaluate(() => { const T = window.__test; T.startLevel(1); T.clearDrag(); for (let i = 0; i < 30; i++) T.tick(1/60); });
  await page.screenshot({ path: path.join(SHOTS, `L1-start-${w}x${h}.png`) });
  await page.evaluate(() => { const T = window.__test; T.startLevel(4); T.teleport(0.85, 2.2, 36); for (let i = 0; i < 30; i++) T.tick(1/60); });
  await page.screenshot({ path: path.join(SHOTS, `L4-rails-${w}x${h}.png`) });
  await page.close();
}
await browser.close(); server.close();
fs.writeFileSync(path.join(SHOTS, 'before-metrics.json'), JSON.stringify(res, null, 2));
console.log(JSON.stringify(res, null, 2));
