// Record a bot-driven gameplay clip frame by frame (deterministic): node tools/record.mjs <root> <out.mp4> <levels comma> [w] [h] [fps] [noise]
import { chromium } from 'playwright'; import { serve } from './lib.mjs'; import fs from 'fs'; import path from 'path'; import { execFileSync } from 'child_process';
const [,, r0, out, lv, W = 844, H = 390, FPS = 30, NOISE = 0.2] = process.argv; const root = path.resolve(r0);
const dir = fs.mkdtempSync('/tmp/rec-'); const { server, base } = await serve(root);
const b = await chromium.launch({ args: ['--use-gl=swiftshader'] });
const p = await (await b.newContext({ viewport: { width: +W, height: +H } })).newPage();
await p.goto(base); await p.waitForFunction(() => window.__test);
await p.evaluate(() => { window.__test.manual = true; });
let n = 0;
for (const L of lv.split(',').map(Number)) {
  await p.evaluate(([L, noise]) => { const T = window.__test; T.startLevel(L); let s = 777 + L; window.__rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; window.__wob = 0; window.__noise = noise; }, [L, +NOISE]);
  for (let f = 0; f < 60 * FPS; f++) {
    const st = await p.evaluate(fps => { const T = window.__test; const k = Math.round(60 / fps);
      for (let i = 0; i < k; i++) { const st = T.getState(); if (st.status === 'complete') return 'complete'; if (st.status === 'playing') { const h = T.getBotHint(st.s); if (window.__rnd() < 0.02) window.__wob = (window.__rnd() * 2 - 1) * window.__noise * 0.8; window.__wob *= 0.97;
        let nx = Math.max(-1, Math.min(1, (h.r + window.__wob - st.r) * 1.6 - st.vr * 0.12)); let ny = h.throttle; if (h.brakeTo != null && st.vs > h.brakeTo + 0.3) ny = -Math.min(1, (st.vs - h.brakeTo) / 2); T.setDrag(nx, ny); }
        T.tick(1 / 60); } return T.getState().status; }, +FPS);
    await p.screenshot({ path: path.join(dir, `f${String(n++).padStart(5, '0')}.png`) });
    if (st === 'complete') { for (let k = 0; k < FPS; k++) { await p.evaluate(() => window.__test.tick(1 / 30)); await p.screenshot({ path: path.join(dir, `f${String(n++).padStart(5, '0')}.png`) }); } break; }
  }
}
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(dir, 'f%05d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '28', out]);
console.log('frames', n, 'out', out); await b.close(); server.close(); fs.rmSync(dir, { recursive: true });
