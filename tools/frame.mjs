import { chromium } from 'playwright'; import { serve } from './lib.mjs';
const { server, base } = await serve('/workspace/rolling-balls-s3');
const b = await chromium.launch({ args: ['--use-gl=swiftshader'] });
for (const [w, h] of [[844, 390], [390, 844], [1024, 768], [1180, 820]]) {
  const p = await (await b.newContext({ viewport: { width: w, height: h } })).newPage();
  await p.goto(base); await p.waitForFunction(() => window.__test);
  const r = await p.evaluate(() => { const T = window.__test; T.manual = true; T.startLevel(1); const o = {}; for (let i = 0; i < 40; i++) T.tick(1/60);
    const f = () => ({ hz: +T.getHorizon().toFixed(3), ball: +(T.getBallScreenSize() / innerHeight).toFixed(3), down: +(T.projectBall().sy / innerHeight).toFixed(3), track: T.getNearTrackWidth() && +T.getNearTrackWidth().frac.toFixed(3), fov: +T.getCamera().fov.toFixed(1) });
    o.rest = f(); T.setDrag(0, 1); for (let i = 0; i < 180; i++) T.tick(1/60); o.cruise = f(); return o; });
  console.log(w, h, JSON.stringify(r));
}
await b.close(); server.close();
