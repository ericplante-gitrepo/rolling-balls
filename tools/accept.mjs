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
  // Level 4 has checkpoint at z=18
  await page.evaluate(() => {
    window.__test.startLevel(4);
    // drive to checkpoint
    window.__test.setDrag(0, 1);
    for (let i=0;i<400;i++) window.__test.tick(1/60);
  });
  let st = await page.evaluate(() => window.__test.getState());
  // if not past checkpoint, teleport past it and tick
  if (st.checkpointIndex < 0) {
    await page.evaluate(() => {
      window.__test.teleport(0, 2, 19);
      for (let i=0;i<30;i++) window.__test.tick(1/60);
    });
    st = await page.evaluate(() => window.__test.getState());
  }
  const before = st;
  // fall off
  await page.evaluate(() => {
    window.__test.teleport(6, 2, 30); // off rail width
    for (let i=0;i<20;i++) window.__test.tick(1/60);
  });
  const falling = await page.evaluate(() => window.__test.getState());
  const t0 = Date.now();
  // tick until respawned
  let after;
  for (let i=0;i<200;i++) {
    await page.evaluate(() => window.__test.tick(1/60));
    after = await page.evaluate(() => window.__test.getState());
    if (after.status === 'playing' && falling.status !== 'playing') break;
  }
  const elapsed = (Date.now() - t0); // wall clock not sim — compute sim: 2.0s target
  // Better: count ticks
  // Re-run timing via sim
  await page.evaluate(() => {
    window.__test.startLevel(4);
    window.__test.teleport(0, 2, 19);
    for (let i=0;i<30;i++) window.__test.tick(1/60);
    window.__test.teleport(6, 2, 30);
    for (let i=0;i<10;i++) window.__test.tick(1/60);
  });
  let sim = 0;
  let status='';
  let ballZ=0, cp=-1;
  for (let i=0;i<300;i++) {
    await page.evaluate(() => window.__test.tick(1/60));
    sim += 1/60;
    const s = await page.evaluate(() => window.__test.getState());
    status = s.status; ballZ = s.ball.z; cp = s.checkpointIndex;
    if (s.status === 'playing' && sim > 0.3) break;
  }
  await browser.close();
  return { beforeCP: before.checkpointIndex, fallingStatus: falling.status, respawnSimSec: sim, status, ballZ, cp };
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
