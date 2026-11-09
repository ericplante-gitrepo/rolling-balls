import { chromium, webkit } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SHOTS = path.join(ROOT, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};
const server = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') url = '/index.html';
  const fp = path.join(ROOT, url.replace(/^\//, ''));
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
  { name: '390x844', w: 390, h: 844 },
  { name: '1024x768', w: 1024, h: 768 },
  { name: '1180x820', w: 1180, h: 820 },
];

async function loadCheck(browserType) {
  const browser = await browserType.launch({ headless: true });
  const results = [];
  for (const s of sizes) {
    const page = await browser.newPage({ viewport: { width: s.w, height: s.h } });
    const errors = [];
    const failed = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('response', r => {
      if (r.status() === 404) failed.push(r.url());
    });
    const external = [];
    page.on('request', r => {
      const u = r.url();
      if (!u.startsWith(base) && !u.startsWith('data:') && !u.startsWith('blob:')) external.push(u);
    });
    await page.goto(base, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction(() => window.__test && window.__test.getState, { timeout: 10000 });
    await page.waitForTimeout(300);
    results.push({ size: s.name, errors, status404: failed, external });
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
    await page.waitForTimeout(50);
    let midTaken = false;
    const t0 = Date.now();
    let done = false;
    while (!done && Date.now() - t0 < 50000) {
      await page.evaluate(() => {
        const s = window.__test.getState();
        let nx = 0;
        if (s.level === 4) {
          // prefer right rail
          if (s.ball.x < 0.7) nx = 0.85;
          else if (s.ball.x > 1.1) nx = -0.4;
        } else {
          if (s.ball.x > 0.4) nx = -0.6;
          if (s.ball.x < -0.4) nx = 0.6;
        }
        window.__test.setDrag(nx, 1);
        for (let i = 0; i < 4; i++) window.__test.tick(1 / 60);
      });
      const st = await page.evaluate(() => window.__test.getState());
      if (!midTaken && st.progress > 0.35 && st.progress < 0.6 && st.status === 'playing') {
        await page.evaluate(() => { document.getElementById('level-complete').style.display = 'none'; });
        await page.screenshot({ path: path.join(SHOTS, `L${L}-mid.png`) });
        midTaken = true;
      }
      if (st.status === 'complete') { done = true; break; }
      if (st.status === 'falling' || st.status === 'respawning') {
        await page.evaluate(() => { for (let i = 0; i < 130; i++) window.__test.tick(1 / 60); });
      }
    }
    const final = await page.evaluate(() => window.__test.getState());
    if (!midTaken) await page.screenshot({ path: path.join(SHOTS, `L${L}-mid.png`) });
    if (final.status === 'complete') {
      await page.screenshot({ path: path.join(SHOTS, `L${L}-complete.png`) });
      await page.click('#continue-button').catch(() => {});
    }
    levelResults.push({ level: L, status: final.status, progress: final.progress, coins: final.coins, errors: errors.slice() });
    errors.length = 0;
  }
  await browser.close();
  return levelResults;
}

async function respawnChecks() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__test);

  async function one(withCP) {
    return page.evaluate((withCP) => {
      const T = window.__test;
      T.startLevel(4);
      if (withCP) {
        T.setDrag(0, 1);
        let s;
        for (let i = 0; i < 800; i++) {
          T.tick(1 / 60); s = T.getState();
          if (s.checkpointIndex >= 0 || s.ball.z > 20) break;
        }
        T.clearDrag();
        if (s.checkpointIndex < 0) {
          T.teleport(0, 2, 19);
          for (let i = 0; i < 45; i++) T.tick(1 / 60);
          s = T.getState();
        }
        T.teleport(0, 2.0, 20); T.clearDrag();
        for (let i = 0; i < 5; i++) T.tick(1 / 60);
      } else {
        // before checkpoint: fall near start
        for (let i = 0; i < 10; i++) T.tick(1 / 60);
      }
      const cpBefore = T.getState().checkpointIndex;
      T.teleport(4.5, 2.2, withCP ? 35 : 8);
      let s = T.getState();
      for (let i = 0; i < 60; i++) {
        T.tick(1 / 60); s = T.getState();
        if (s.status === 'falling' || s.status === 'respawning') break;
      }
      if (s.status === 'playing') {
        T.teleport(4.5, -11, withCP ? 35 : 8);
        for (let i = 0; i < 5; i++) T.tick(1 / 60);
      }
      const statusAtFall = T.getState().status;
      let sim = 0, final = null;
      for (let i = 0; i < 300; i++) {
        T.tick(1 / 60); sim += 1 / 60; final = T.getState();
        if (final.status === 'playing') break;
      }
      return {
        withCP, cpBefore, statusAtFall, respawnSimSec: +sim.toFixed(3),
        status: final.status, ballZ: +final.ball.z.toFixed(2), cp: final.checkpointIndex,
        ok: final.status === 'playing' && sim >= 1.9 && sim <= 2.6 &&
          (withCP ? (final.checkpointIndex >= 0 && final.ball.z > 15 && final.ball.z < 25)
                  : (final.checkpointIndex < 0 && final.ball.z < 5))
      };
    }, withCP);
  }

  const after = await one(true);
  const before = await one(false);
  await browser.close();
  return { beforeCheckpoint: before, afterCheckpoint: after };
}

async function specialShots() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__test);
  // sky-check: L4 mid dual rails
  await page.evaluate(() => {
    window.__test.startLevel(4);
    window.__test.teleport(0.85, 3, 40);
    for (let i = 0; i < 25; i++) window.__test.tick(1 / 60);
    document.getElementById('level-complete').style.display = 'none';
  });
  await page.screenshot({ path: path.join(SHOTS, 'sky-check.png') });
  await page.screenshot({ path: path.join(SHOTS, 'L4-mid.png') });
  // ball-closeup: near start, facing ball+pause
  await page.evaluate(() => {
    window.__test.startLevel(1);
    window.__test.teleport(0, 1, 6);
    window.__test.clearDrag();
    for (let i = 0; i < 20; i++) window.__test.tick(1 / 60);
  });
  await page.screenshot({ path: path.join(SHOTS, 'ball-closeup.png') });
  // also ensure L4 complete exists from playAll; retake level-complete-ui
  await page.evaluate(() => { window.__test.finishNow(); });
  await page.screenshot({ path: path.join(SHOTS, 'level-complete-ui.png') });
  await browser.close();
}

const out = {};
try { out.chromiumLoad = await loadCheck(chromium); }
catch (e) { out.chromiumLoad = { error: String(e) }; }
try { out.webkitLoad = await loadCheck(webkit); }
catch (e) { out.webkitLoad = { error: String(e), note: 'webkit host libs' }; }
out.play = await playAll();
out.respawn = await respawnChecks();
await specialShots();
fs.writeFileSync(path.join(ROOT, 'tools/accept-results.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
server.close();
