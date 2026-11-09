import { chromium, webkit } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SHOTS = path.join(ROOT, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.map':'application/json' };
const server = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') url = '/index.html';
  const fp = path.join(ROOT, url.replace(/^\//,''));
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    res.writeHead(404); res.end('no'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(fp).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}/`;
console.log('serving', base);

const sizes = [
  { name: '844x390', w: 844, h: 390 },
  { name: '1024x768', w: 1024, h: 768 },
  { name: '1180x820', w: 1180, h: 820 },
];

async function loadCheck(browserType, label) {
  const browser = await browserType.launch({ headless: true });
  const results = [];
  for (const s of sizes) {
    const page = await browser.newPage({ viewport: { width: s.w, height: s.h } });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    const reqs = [];
    page.on('request', r => {
      const u = r.url();
      if (!u.startsWith(base) && !u.startsWith('data:') && !u.startsWith('blob:')) reqs.push(u);
    });
    await page.goto(base, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction(() => window.__test && window.__test.getState, { timeout: 10000 });
    await page.waitForTimeout(400);
    results.push({ size: s.name, errors, external: reqs });
    await page.close();
  }
  await browser.close();
  return results;
}

async function playAll() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__test);

  const levelResults = [];
  for (let L = 1; L <= 5; L++) {
    await page.evaluate(n => window.__test.startLevel(n), L);
    await page.waitForTimeout(100);
    // Mid screenshot after a bit of driving
    await page.evaluate(() => window.__test.setDrag(0, 1));
    // Drive with tick for determinism + some rAF
    let done = false;
    const t0 = Date.now();
    while (!done && Date.now() - t0 < 45000) {
      await page.evaluate(() => {
        // keep centered and accelerating; nudge away from walls
        const s = window.__test.getState();
        let nx = 0;
        if (s.ball.x > 0.4) nx = -0.6;
        if (s.ball.x < -0.4) nx = 0.6;
        // level 3 sliding wall: wait if near and wall blocking center
        window.__test.setDrag(nx, 1);
        for (let i = 0; i < 4; i++) window.__test.tick(1/60);
      });
      const st = await page.evaluate(() => window.__test.getState());
      if (st.progress > 0.35 && st.progress < 0.55) {
        const shot = path.join(SHOTS, `L${L}-mid.png`);
        if (!fs.existsSync(shot)) await page.screenshot({ path: shot, fullPage: false });
      }
      if (st.status === 'complete') { done = true; break; }
      if (st.status === 'falling' || st.status === 'respawning') {
        // wait out respawn via ticks
        await page.evaluate(() => { for (let i=0;i<130;i++) window.__test.tick(1/60); });
      }
    }
    const final = await page.evaluate(() => window.__test.getState());
    // ensure mid shot exists
    const mid = path.join(SHOTS, `L${L}-mid.png`);
    if (!fs.existsSync(mid)) await page.screenshot({ path: mid });
    levelResults.push({ level: L, status: final.status, progress: final.progress, coins: final.coins, errors: errors.slice() });
    if (final.status === 'complete') {
      await page.screenshot({ path: path.join(SHOTS, `L${L}-complete.png`) });
      // click continue for next
      await page.click('#continue-button').catch(()=>{});
    }
    errors.length = 0;
  }
  await browser.close();
  return levelResults;
}

async function respawnCheck() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__test);
  const result = await page.evaluate(() => {
    const T = window.__test;
    T.startLevel(4);
    T.setDrag(0, 1);
    let s;
    for (let i = 0; i < 800; i++) {
      T.tick(1/60); s = T.getState();
      if (s.checkpointIndex >= 0 || s.ball.z > 20) break;
    }
    T.clearDrag();
    if (s.checkpointIndex < 0) {
      T.teleport(0, 2, 19);
      for (let i = 0; i < 45; i++) T.tick(1/60);
      s = T.getState();
    }
    T.teleport(0, 2.0, 20); T.clearDrag();
    for (let i = 0; i < 5; i++) T.tick(1/60);
    T.teleport(4.5, 2.2, 35);
    for (let i = 0; i < 60; i++) {
      T.tick(1/60); s = T.getState();
      if (s.status === 'falling' || s.status === 'respawning') break;
    }
    if (s.status === 'playing') {
      T.teleport(4.5, -11, 35);
      for (let i = 0; i < 5; i++) T.tick(1/60);
      s = T.getState();
    }
    const statusAtFall = T.getState().status;
    let sim = 0, final = null;
    for (let i = 0; i < 300; i++) {
      T.tick(1/60); sim += 1/60; final = T.getState();
      if (final.status === 'playing') break;
    }
    return {
      beforeCP: s.checkpointIndex,
      fallingStatus: statusAtFall,
      respawnSimSec: +sim.toFixed(3),
      status: final.status,
      ballZ: +final.ball.z.toFixed(2),
      cp: final.checkpointIndex,
      ok: final.status === 'playing' && final.checkpointIndex >= 0 && sim >= 1.9 && sim <= 2.6
    };
  });
  await browser.close();
  return result;
}

const out = { chromiumLoad: null, webkitLoad: null, play: null, respawn: null };
try {
  out.chromiumLoad = await loadCheck(chromium, 'chromium');
} catch (e) { out.chromiumLoad = { error: String(e) }; }
try {
  out.webkitLoad = await loadCheck(webkit, 'webkit');
} catch (e) { out.webkitLoad = { error: String(e), note: 'webkit may lack host libs' }; }
out.play = await playAll();
out.respawn = await respawnCheck();

fs.writeFileSync(path.join(ROOT, 'tools/accept-results.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
server.close();
