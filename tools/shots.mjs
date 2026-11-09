// Feature screenshots for before/after comparison. Usage: node tools/shots.mjs <gameDir> <outDir>
import { chromium } from 'playwright';
import path from 'path'; import fs from 'fs';
import { serve } from './lib.mjs';
const [DIR, OUT] = process.argv.slice(2); fs.mkdirSync(OUT, { recursive: true });
const { server, base } = await serve(path.resolve(DIR));
const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
// [level, x, z, name]: ball placed a few metres before each feature, then rolls forward ~1 s
const scenes = [[1, 0, 80, 'L1-gap'], [2, 0, 18, 'L2-cubes'], [3, 0, 36, 'L3-wall'], [4, 1, 52, 'L4-rails'], [5, 0, 172, 'L5-jump']];
for (const [w, h] of [[1180, 820], [390, 844], [844, 390], [1024, 768]]) {
  const page = await (await b.newContext({ viewport: { width: w, height: h } })).newPage();
  await page.goto(base); await page.waitForFunction(() => window.__test);
  for (const [L, x, z, name] of scenes) {
    await page.evaluate(([L, x, z]) => { const T = window.__test; if ('manual' in T) T.manual = true;
      T.startLevel(L); const C = T.getConfig ? T.getConfig() : { SCREEN_RIGHT_X: 1 }; const wx = x * C.SCREEN_RIGHT_X;
      T.teleport(wx, 3, z); T.setDrag(0, 0.5); for (let i = 0; i < 60; i++) T.tick(1 / 60); T.clearDrag(); T.tick(1 / 60);
      const lc = document.getElementById('level-complete'); if (lc) lc.style.display = 'none'; }, [L, x, z]);
    await page.screenshot({ path: path.join(OUT, `${name}-${w}x${h}.png`) });
  }
}
await b.close(); server.close();
