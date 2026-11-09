// Rolling Balls acceptance suite (slice-2). Usage: node tools/accept.mjs [gameDir] [--quick]
// Chromium only by default (WebKit host libs missing on this box; attempted and reported).
import { chromium, webkit } from 'playwright';
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
import { serve, SPIN_PROBE } from './lib.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : path.join(__dirname, '..'));
const QUICK = process.argv.includes('--quick');
const SEEDS = QUICK ? 4 : 25;
const SHOTS = path.join(__dirname, '..', 'shots', 'slice-2', 'after');
fs.mkdirSync(SHOTS, { recursive: true });
const { server, base } = await serve(ROOT);
const SIZES = [[844, 390], [390, 844], [1024, 768], [1180, 820]];
const results = []; // {group, name, pass, detail}
const check = (group, name, pass, detail) => { results.push({ group, name, pass: !!pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} [${group}] ${name}`, detail === undefined ? '' : JSON.stringify(detail)); };

const LAUNCH = { args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] };
async function open(w = 1180, h = 820, opts = {}) {
  const browser = await chromium.launch(LAUNCH);
  const ctx0 = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: !!opts.touch, isMobile: !!opts.touch && w < 900 });
  const ctx = { close: async () => { await ctx0.close().catch(() => {}); await browser.close().catch(() => {}); } };
  const page = await ctx0.newPage();
  const errors = [], external = [], missing = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('request', r => { const u = r.url(); if (!u.startsWith(base) && !u.startsWith('data:') && !u.startsWith('blob:')) external.push(u); });
  page.on('response', r => { if (r.status() >= 400) missing.push(r.url()); });
  await page.goto(base, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => window.__test && window.__test.getState);
  await page.addScriptTag({ content: SPIN_PROBE });
  await page.addScriptTag({ content: BOT });
  await page.evaluate(r => { window.__test.manual = true; if (!r) window.__test.render = false; }, !!opts.render);
  return { ctx, page, errors, external, missing };
}
// Seeded auto-bot: follows getBotHint with steering noise and reacts to sliding walls.
const BOT = `
window.__bot = function (level, seed, opts) {
  opts = opts || {}; const T = window.__test; const dt = opts.dt || 1/60; const maxT = opts.maxT || 90;
  let s = seed >>> 0; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const noise = opts.noise == null ? 0.25 : opts.noise; const cfg = T.getConfig();
  T.startLevel(level); let t = 0, falls = 0, maxSpeed = 0, steerN = 0, nTarget = 0, wobble = 0, lastSt = 'playing';
  const trace = [];
  while (t < maxT) {
    const st = T.getState();
    if (st.status === 'complete') return { level, seed, done: true, t: +t.toFixed(2), falls: st.fallenCount, coins: st.coins, maxSpeed: +maxSpeed.toFixed(2), trace: opts.trace ? trace : undefined };
    if (st.status === 'playing') {
      const look = st.ball.z + Math.max(2, st.speed * 0.35);
      const h = T.getBotHint(look);
      let tx = h.x, thr = h.throttle;
      for (const o of T.getObstacles()) {
        if (o.type !== 'sliding') continue;
        const dz = o.z - st.ball.z; if (dz < -1 || dz > 14) continue;
        const half = o.w / 2 + cfg.BALL_R + 0.25;
        if (Math.abs(tx - o.x) < half) { // pick the open side of the deck
          const left = o.x - half, right = o.x + half; const deckHalf = 2 - cfg.BALL_R - 0.1;
          const cand = []; if (left > -deckHalf) cand.push(Math.max(-deckHalf, left - 0.2)); if (right < deckHalf) cand.push(Math.min(deckHalf, right + 0.2));
          if (cand.length) tx = cand.reduce((a, b) => Math.abs(a - st.ball.x) < Math.abs(b - st.ball.x) ? a : b);
        }
      }
      if (rnd() < 0.02) wobble = (rnd() * 2 - 1) * noise * 0.8;
      wobble *= 0.97;
      const errScreen = (tx + wobble - st.ball.x) * cfg.SCREEN_RIGHT_X; // + means target is to the screen-right
      const nx = Math.max(-1, Math.min(1, errScreen * 1.6 - st.ball.vx * cfg.SCREEN_RIGHT_X * 0.12 + (rnd() * 2 - 1) * noise * 0.3));
      const ny = Math.max(-1, Math.min(1, thr + (rnd() * 2 - 1) * noise * 0.2));
      T.setDrag(nx, ny);
    }
    if (opts.trace && trace.length < 4000) trace.push([+t.toFixed(3), st.ball.x, st.ball.y, st.ball.z, st.speed, st.status]);
    T.tick(dt); t += dt; maxSpeed = Math.max(maxSpeed, T.getState().speed || 0);
  }
  const st = T.getState();
  return { level, seed, done: false, t: +t.toFixed(2), falls: st.fallenCount, z: +st.ball.z.toFixed(1), status: st.status };
};`;

// ---------- 1. Load: 4 viewports, errors, external requests (Chromium), WebKit attempt
for (const [w, h] of SIZES) {
  const o = await open(w, h, { render: true });
  await o.page.evaluate(() => { const T = window.__test; T.startLevel(1); for (let i = 0; i < 60; i++) T.tick(1 / 60); });
  await o.page.waitForTimeout(300);
  check('load', `${w}x${h} no console errors`, o.errors.length === 0, o.errors.slice(0, 3));
  check('load', `${w}x${h} no external requests`, o.external.length === 0, o.external.slice(0, 3));
  check('load', `${w}x${h} no 4xx/5xx`, o.missing.length === 0, o.missing.slice(0, 3));
  const pb = await o.page.evaluate(() => window.__test.getPlanetScreen());
  const okPlanet = pb && pb.left >= 0 && pb.top >= 0 && pb.right <= w && pb.bottom <= h && (pb.left + pb.right) / 2 < w / 2 && (pb.top + pb.bottom) / 2 < h / 2;
  check('look', `${w}x${h} planet fully on screen, upper-left`, okPlanet, pb && { l: Math.round(pb.left), t: Math.round(pb.top), r: Math.round(pb.right), b: Math.round(pb.bottom) });
  const buf = await o.page.screenshot({ path: path.join(SHOTS, `L1-start-${w}x${h}.png`) });
  // sky: sample top 25% band at x=88% of width (away from HUD/planet) via canvas pixels
  const sky = await o.page.evaluate(async ([w, h, b64]) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64;
    await img.decode(); const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const g = cv.getContext('2d'); g.drawImage(img, 0, 0, w, h);
    const px = (x, y) => Array.from(g.getImageData(Math.round(x), Math.round(y), 1, 1).data.slice(0, 3));
    return { top2: px(w * 0.88, h * 0.02), q12: px(w * 0.88, h * 0.12) };
  }, [w, h, buf.toString('base64')]).catch(e => ({ err: String(e) }));
  const violet = [0x3A, 0x1D, 0x7A]; const dist = a => a ? Math.hypot(a[0] - violet[0], a[1] - violet[1], a[2] - violet[2]) : 999;
  check('look', `${w}x${h} sky top is violet #3A1D7A`, sky.top2 && dist(sky.top2) < 40, sky);
  await o.ctx.close();
}
try { const wb = await webkit.launch(); await wb.close(); check('load', 'webkit available', true); }
catch (e) { results.push({ group: 'load', name: 'webkit (not available on box)', pass: null, detail: String(e).split('\n')[0] }); console.log('SKIP webkit'); }

// ---------- 2. Spin direction vs velocity
{
  const o = await open();
  const runs = await o.page.evaluate(() => {
    const T = window.__test; const r = {};
    T.startLevel(1); T.setDrag(0, 1); r.forward = window.__spinProbe(240, 1 / 60);
    T.startLevel(1); T.setDrag(0, 1); for (let i = 0; i < 40; i++) T.tick(1/60);
    r.zigzag = window.__spinProbe(360, 1 / 60, i => T.setDrag(Math.sin(i / 20), 0.8));
    T.startLevel(1); T.setDrag(0, 0.3); for (let i = 0; i < 40; i++) T.tick(1/60);
    r.steerRight = window.__spinProbe(30, 1 / 60, () => T.setDrag(1, 0.3));
    r.steerLeft = window.__spinProbe(30, 1 / 60, () => T.setDrag(-1, 0.3));
    T.startLevel(1); T.setDrag(0, 1); for (let i = 0; i < 90; i++) T.tick(1/60);
    r.coastAndBrake = window.__spinProbe(180, 1 / 60, i => T.setDrag(0, i < 90 ? 0 : -1));
    r.at30Hz = (T.startLevel(1), T.setDrag(0.3, 1), window.__spinProbe(90, 1 / 30));
    r.at120Hz = (T.startLevel(1), T.setDrag(-0.3, 1), window.__spinProbe(360, 1 / 120));
    return r;
  });
  for (const [k, v] of Object.entries(runs)) check('spin', `spin axis = cross(up, v), angle = dist/R: ${k}`, v.n > 10 && v.bad === 0 && v.worstDot > 0.9, { n: v.n, good: v.good, bad: v.bad, worstDot: v.worstDot, meanRatio: v.meanRatio, badSamples: v.samples });
  // seeded drag runs on every level
  const lv = await o.page.evaluate((SEEDS) => {
    const T = window.__test; const out = [];
    for (let L = 1; L <= 5; L++) for (let s = 1; s <= Math.min(SEEDS, 6); s++) {
      T.startLevel(L); let seed = s * 7919 + L;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      let nx = 0, ny = 1;
      const p = window.__spinProbe(600, 1 / 60, i => { if (i % 20 === 0) { nx = rnd() * 2 - 1; ny = 0.3 + rnd() * 0.7; } T.setDrag(nx, ny); });
      out.push(p);
    }
    return out.reduce((a, p, i) => ({ wallFramesExcluded: a.wallFramesExcluded + (p.wallFrames || 0), n: a.n + p.n, bad: a.bad + p.bad, worstDot: Math.min(a.worstDot, p.worstDot), badSamples: a.badSamples.concat(p.samples.slice(0, 2).map(x => Object.assign({ run: i }, x))).slice(0, 10) }), { wallFramesExcluded: 0, n: 0, bad: 0, worstDot: 1, badSamples: [] });
  }, SEEDS);
  check('spin', 'random seeded drags on all 5 levels: every grounded frame rolls the right way', lv.n > 1000 && lv.bad === 0, lv);
  await o.ctx.close();
}

// ---------- 3. Drag-to-direction mapping (mouse + touch, real pointer events)
async function mapping(kind) {
  const o = await open(1180, 820, { touch: kind === 'touch' });
  const { page } = o;
  await page.evaluate(() => { const T = window.__test; T.startLevel(1); T.clearDrag(); for (let i = 0; i < 20; i++) T.tick(1/60); });
  const cx = 590, cy = 560; let cdp;
  if (kind === 'touch') cdp = await page.context().newCDPSession(page);
  const settle = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const down0 = async (x, y, id = 0) => kind === 'mouse' ? (await page.mouse.move(x, y), await page.mouse.down()) : cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id }] });
  const move0 = async (x, y, pts) => kind === 'mouse' ? page.mouse.move(x, y, { steps: 4 }) : cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts || [{ x, y, id: 0 }] });
  const down = async (...a) => { await down0(...a); await settle(); };
  const move = async (...a) => { await move0(...a); await settle(); };
  const up = async () => { kind === 'mouse' ? await page.mouse.up() : await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await settle(); };
  const tick = n => page.evaluate(n => { for (let i = 0; i < n; i++) window.__test.tick(1/60); }, n);
  // screen position of the ball relative to the projected track centre line at the ball (camera follows x, so measure against the track)
  const st = () => page.evaluate(() => { const T = window.__test; const s = T.getState(); const b = T.projectBall(); const c = T.projectPoint(0, s.ball.y, s.ball.z); return { s, p: { sx: b.sx - c.sx }, d: T.getDrag() }; });
  const r = {};
  await down(cx, cy); await move(cx, cy - 120); await tick(60);
  let a = await st(); r.forward = { ny: a.d.ny, vz: +a.s.ball.vz.toFixed(2) };
  await move(cx + 150, cy - 120); await tick(15);
  let b = await st(); r.right = { nx: b.d.nx, screenDx: +(b.p.sx - a.p.sx).toFixed(1), vx: +b.s.ball.vx.toFixed(2) };
  await move(cx - 150, cy - 120); await tick(15);
  let c = await st(); r.left = { nx: c.d.nx, screenDx: +(c.p.sx - b.p.sx).toFixed(1) };
  await move(cx - 150, cy + 200); await tick(120);
  let d = await st(); r.pullBack = { ny: d.d.ny, vz: +d.s.ball.vz.toFixed(3) };
  if (kind === 'touch') { // second finger must not hijack
    await move(cx, cy, [{ x: cx - 150, y: cy + 200, id: 0 }]);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx - 150, y: cy + 200, id: 0 }, { x: 900, y: 200, id: 1 }] }); await settle();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx - 150, y: cy + 200, id: 0 }, { x: 1100, y: 100, id: 1 }] }); await settle();
    const e = await st(); r.secondFinger = { ny: e.d.ny, nx: e.d.nx };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx - 150, y: cy + 200, id: 0 }] }); await settle(); // finger 1 lifted, finger 0 stays
    const f = await st(); r.afterSecondLift = { active: f.d.active, ny: f.d.ny };
  }
  await up(); await tick(2);
  const g = await st(); r.release = { active: g.d.active, nx: g.d.nx, ny: g.d.ny };
  // floating origin: drag far right then a small move left must steer left immediately
  await page.evaluate(() => { const T = window.__test; T.startLevel(1); T.clearDrag(); });
  await down(300, 600); await move(900, 600); await move(860, 600); await tick(1);
  const h = await st(); r.floatingOrigin = { nxAfterSmallLeft: h.d.nx };
  await up();
  check('input', `${kind}: drag up = forward`, r.forward.ny > 0.9 && r.forward.vz > 5, r.forward);
  check('input', `${kind}: drag right = ball moves right on screen`, r.right.nx > 0.5 && r.right.screenDx > 15, r.right);
  check('input', `${kind}: drag left = ball moves left on screen`, r.left.nx < -0.5 && r.left.screenDx < -15, r.left);
  check('input', `${kind}: pull back brakes, never reverses`, r.pullBack.ny < -0.5 && r.pullBack.vz >= -0.01 && r.pullBack.vz < 1, r.pullBack);
  check('input', `${kind}: release clears input (coast)`, !r.release.active && r.release.nx === 0 && r.release.ny === 0, r.release);
  check('input', `${kind}: floating origin, reversing is instant`, r.floatingOrigin.nxAfterSmallLeft < 0.9, r.floatingOrigin);
  if (kind === 'touch') {
    check('input', 'touch: second finger ignored', r.secondFinger.ny < -0.5, r.secondFinger);
    check('input', 'touch: lifting second finger keeps first', r.afterSecondLift.active && r.afterSecondLift.ny < -0.5, r.afterSecondLift);
  }
  check('input', `${kind}: no errors`, o.errors.length === 0, o.errors.slice(0, 2));
  await o.ctx.close();
}
await mapping('mouse'); await mapping('touch');

// ---------- 4. Speed curves, steering, slopes, jumps, rails, respawn, camera, timestep
{
  const o = await open(); const { page } = o;
  const m = await page.evaluate(() => {
    const T = window.__test; const C = T.getConfig(); const r = { cfg: { MAX_SPEED: C.MAX_SPEED, ACCEL: C.ACCEL, BRAKE: C.BRAKE, LAT_MAX: C.LAT_MAX, RESPAWN_S: C.RESPAWN_S } };
    const run = (n, dt, f) => { for (let i = 0; i < n; i++) { if (f) f(i); T.tick(dt); } };
    // accel from rest
    T.startLevel(1); T.setDrag(0, 1); let t = 0, t90 = null, curve = [];
    for (let i = 0; i < 240; i++) { T.tick(1/60); t += 1/60; const v = T.getState().speed; if (i % 15 === 14) curve.push(+v.toFixed(2)); if (t90 === null && v >= 0.9 * C.MAX_SPEED) t90 = +t.toFixed(2); }
    r.accel = { t90, vAt4s: curve[curve.length - 1], curve };
    // coast
    const v0 = T.getState().speed; T.clearDrag(); run(120, 1/60); r.coast = { v0: +v0.toFixed(2), vAfter2s: +T.getState().speed.toFixed(2) };
    // brake
    T.startLevel(1); T.setDrag(0, 1); run(120, 1/60); T.setDrag(0, -1); let tb = 0, minVz = 99;
    for (let i = 0; i < 180; i++) { T.tick(1/60); tb += 1/60; const s = T.getState(); minVz = Math.min(minVz, s.ball.vz); if (s.ball.vz < 0.05 && !r.brake) r.brake = { stopSec: +tb.toFixed(2) }; }
    r.brake = Object.assign(r.brake || {}, { minVz: +minVz.toFixed(3) });
    // lateral response + release drift
    T.startLevel(1); T.setDrag(0, 0.5); run(60, 1/60); const x0 = T.getState().ball.x; let tl = 0, tLat = null;
    for (let i = 0; i < 30; i++) { T.setDrag(1, 0.5); T.tick(1/60); tl += 1/60; if (tLat === null && Math.abs(T.getState().ball.vx) >= 0.9 * C.LAT_MAX) tLat = +tl.toFixed(3); }
    T.setDrag(0, 0.5); const xr = T.getState().ball.x; run(60, 1/60); r.lateral = { t90: tLat, releaseDrift: +Math.abs(T.getState().ball.x - xr).toFixed(3), vxAfter: +T.getState().ball.vx.toFixed(3) };
    // guard rail bounce on L1 first 60 m: hold full right for 1.5 s
    T.startLevel(1); T.setDrag(0, 1); run(60, 1/60); let maxAbsX = 0, fell = false, bounced = false, prevVx = 0;
    for (let i = 0; i < 90; i++) { T.setDrag(1, 1); T.tick(1/60); const s = T.getState(); maxAbsX = Math.max(maxAbsX, Math.abs(s.ball.x)); if (s.status !== 'playing') fell = true; if (Math.sign(s.ball.vx) !== Math.sign(prevVx) && Math.abs(prevVx) > 1) bounced = true; prevVx = s.ball.vx; }
    r.rail = { maxAbsX: +maxAbsX.toFixed(3), fell, bounced };
    // L1 ramp lip launch and gap clear at full throttle; fail at ~6 m/s
    const gapRun = (thr) => { T.startLevel(1); let maxVyAir = 0, airT = 0, maxH = -99, fallen = false, done = false;
      for (let i = 0; i < 60 * 40; i++) { const s = T.getState(); const capped = thr < 1 && s.speed > 6 ? 0 : thr; T.setDrag(0, capped); T.tick(1/60); const s2 = T.getState();
        if (!s2.grounded && s2.status === 'playing') { airT += 1/60; maxVyAir = Math.max(maxVyAir, s2.ball.vy); maxH = Math.max(maxH, s2.ball.y); }
        if (s2.fallenCount > 0) { fallen = true; break; } if (s2.status === 'complete') { done = true; break; } }
      return { maxVyAir: +maxVyAir.toFixed(2), airSec: +airT.toFixed(2), maxY: +maxH.toFixed(2), fallen, done }; };
    r.gapFast = gapRun(1); r.gapSlow = gapRun(0.5);
    // respawn timing, before checkpoint (L1) and after checkpoint (L4), camera holds during fall
    const fallTest = (L, preZ) => { T.startLevel(L); if (preZ) { T.setDrag(0, 1); for (let i = 0; i < 1200 && T.getState().checkpointIndex < 0; i++) T.tick(1/60); }
      const s0 = T.getState(); const cpZ = s0.ball.z; const camY0 = T.getCamera().y; T.clearDrag();
      T.teleport(s0.ball.x + 4.5 * C.SCREEN_RIGHT_X, s0.ball.y + 0.5, s0.ball.z + 3); T.setVelocity(0, 0, 5);
      let t = 0, tf = null, tr = null, minCamY = 99, steps = 0;
      for (let i = 0; i < 600; i++) { T.tick(1/60); t += 1/60; const s = T.getState(); if (tf === null && s.status !== 'playing') tf = t;
        if (tf !== null && s.status !== 'playing') minCamY = Math.min(minCamY, T.getCamera().y);
        if (tf !== null && s.status === 'playing') { tr = t; break; } }
      const s = T.getState(); return { cpIndex: s.checkpointIndex, respawnSec: tr && +(tr - tf).toFixed(3), respawnZ: +s.ball.z.toFixed(2), cpZ: +cpZ.toFixed(2), camDropDuringFall: +(camY0 - minCamY).toFixed(2), speedAfter: +s.speed.toFixed(3) }; };
    r.respawnStart = fallTest(1, false); r.respawnCP = fallTest(4, true);
    // frame-rate independence: same input at 30/60/120 Hz for 4 s
    const fr = dt => { T.startLevel(1); T.setDrag(0.2, 1); const n = Math.round(4 / dt), half = Math.round(2 / dt); for (let i = 0; i < n; i++) { if (i === half) T.setDrag(-0.2, 1); T.tick(dt); } const s = T.getState(); return [+s.ball.z.toFixed(3), +s.ball.x.toFixed(3)]; };
    r.timestep = { hz30: fr(1/30), hz60: fr(1/60), hz120: fr(1/120) };
    // camera smoothness during a nominal L5 run: max camera acceleration and look jitter
    T.startLevel(5); const cams = []; let prev = null; let maxJerk = 0, maxStep = 0;
    for (let i = 0; i < 60 * 20; i++) { const h = T.getBotHint(T.getState().ball.z + 4); T.setDrag((h.x - T.getState().ball.x) * C.SCREEN_RIGHT_X * 1.5, h.throttle); T.tick(1/60);
      const c = T.getCamera(); if (T.getState().status !== 'playing') { prev = null; continue; }
      if (prev) { const v = [c.x - prev.c.x, c.y - prev.c.y, c.z - prev.c.z]; if (prev.v) { const a = Math.hypot(v[0] - prev.v[0], v[1] - prev.v[1], v[2] - prev.v[2]); maxJerk = Math.max(maxJerk, a); } maxStep = Math.max(maxStep, Math.hypot(...v)); prev = { c, v }; } else prev = { c };
      if (T.getState().status === 'complete') break; }
    r.camera = { maxFrameDeltaVel: +maxJerk.toFixed(4), maxStepPerFrame: +maxStep.toFixed(3) };
    return r;
  });
  const C = m.cfg;
  check('speed', 'top speed in 10-14 m/s band (video 11-13.5)', C.MAX_SPEED >= 10 && C.MAX_SPEED <= 14 && Math.abs(m.accel.vAt4s - C.MAX_SPEED) < 1, { MAX_SPEED: C.MAX_SPEED, vAt4s: m.accel.vAt4s });
  check('speed', '0 to 90% top speed in 0.7-1.6 s (video ~1.2 s)', m.accel.t90 >= 0.7 && m.accel.t90 <= 1.6, m.accel);
  check('speed', 'coasting keeps momentum but bleeds speed (2 s: 25-80% kept)', m.coast.vAfter2s > 0.25 * m.coast.v0 && m.coast.vAfter2s < 0.8 * m.coast.v0, m.coast);
  check('speed', 'brake stops in < 1.2 s and never reverses', m.brake.stopSec && m.brake.stopSec < 1.2 && m.brake.minVz >= -0.01, m.brake);
  check('steer', 'lateral reaches 90% LAT_MAX in < 0.35 s', m.lateral.t90 !== null && m.lateral.t90 < 0.35, m.lateral);
  check('steer', 'release drift < 0.6 m (no ice skating)', m.lateral.releaseDrift < 0.6 && Math.abs(m.lateral.vxAfter) < 0.2, m.lateral);
  check('rails', 'guard rail keeps ball on deck and bounces', !m.rail.fell && m.rail.maxAbsX <= 2.0 && m.rail.bounced, m.rail);
  check('jump', 'L1 ramp lip launches a real arc (vy>1.5, air>0.3 s) and clears the gap at full throttle', m.gapFast.done && !m.gapFast.fallen && m.gapFast.maxVyAir > 1.5 && m.gapFast.airSec > 0.3, m.gapFast);
  check('jump', 'L1 gap needs speed: ~6 m/s run falls', m.gapSlow.fallen, m.gapSlow);
  check('respawn', 'fall before any checkpoint: respawn at start after 2.0 s', m.respawnStart.respawnSec >= 1.95 && m.respawnStart.respawnSec <= 2.06 && m.respawnStart.respawnZ < 2 && m.respawnStart.speedAfter < 0.01, m.respawnStart);
  check('respawn', 'fall after L4 checkpoint: respawn at checkpoint after 2.0 s', m.respawnCP.cpIndex >= 0 && m.respawnCP.respawnSec >= 1.95 && m.respawnCP.respawnSec <= 2.06 && Math.abs(m.respawnCP.respawnZ - m.respawnCP.cpZ) < 3, m.respawnCP);
  check('camera', 'camera holds at track level during a fall (drops < 1.5 m)', m.respawnStart.camDropDuringFall < 1.5 && m.respawnCP.camDropDuringFall < 1.5, { start: m.respawnStart.camDropDuringFall, cp: m.respawnCP.camDropDuringFall });
  check('camera', 'camera follow smooth (frame-to-frame velocity change < 0.05 m, step < 0.4 m)', m.camera.maxFrameDeltaVel < 0.05 && m.camera.maxStepPerFrame < 0.4, m.camera);
  const [a, b, c] = [m.timestep.hz30, m.timestep.hz60, m.timestep.hz120];
  check('timestep', 'same input at 30/60/120 Hz ends within 5 cm', Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.05 && Math.hypot(c[0] - b[0], c[1] - b[1]) < 0.05, m.timestep);
  fs.writeFileSync(path.join(__dirname, 'metrics-slice2.json'), JSON.stringify(m, null, 2));
  await o.ctx.close();
}

// ---------- 5. Every level completable by the auto-bot: nominal + many seeded noisy runs
const perLevel = {};
{
  const o = await open(); const { page } = o;
  for (let L = 1; L <= 5; L++) {
    const nominal = await page.evaluate(L => window.__bot(L, 1, { noise: 0 }), L);
    check('levels', `L${L} nominal bot completes with 0 falls in 10-40 s`, nominal.done && nominal.falls === 0 && nominal.t >= 10 && nominal.t <= 40, nominal);
    const runs = await page.evaluate(([L, n]) => { const out = []; for (let s = 1; s <= n; s++) out.push(window.__bot(L, 1000 + s * 31, { noise: 0.35 })); return out; }, [L, SEEDS]);
    const done = runs.filter(r => r.done); const t = done.map(r => r.t).sort((a, b) => a - b);
    perLevel[L] = { nominalSec: nominal.t, runs: runs.length, completed: done.length, cleanRuns: done.filter(r => r.falls === 0).length, medianSec: t[Math.floor(t.length / 2)], totalFalls: runs.reduce((a, r) => a + r.falls, 0) };
    check('levels', `L${L} seeded noisy bot (${SEEDS} seeds) all complete`, done.length === runs.length, perLevel[L]);
  }
  // 30/120 Hz nominal completion
  for (const dt of [1 / 30, 1 / 120]) {
    const rs = await page.evaluate(dt => [1, 2, 3, 4, 5].map(L => window.__bot(L, 1, { noise: 0, dt })), dt);
    check('levels', `all 5 levels complete at ${Math.round(1 / dt)} Hz`, rs.every(r => r.done), rs.map(r => [r.level, r.done, r.t, r.falls]));
  }
  check('levels', 'no page errors during level runs', o.errors.length === 0, o.errors.slice(0, 3));
  // Continue after L5 loops to L1
  await page.evaluate(() => { window.__test.startLevel(5); window.__test.finishNow(); });
  await page.click('#continue-button');
  const lvl = await page.evaluate(() => window.__test.getState().level);
  check('levels', 'Continue after level 5 loops to level 1', lvl === 1, { level: lvl });
  await o.ctx.close();
}

// ---------- 6. Screenshots (after) at 4 viewports
for (const [w, h] of SIZES) {
  const o = await open(w, h, { render: true }); const { page } = o;
  const shots = [[2, 52, 'L2-smash'], [3, 60, 'L3-walls'], [4, 45, 'L4-rails'], [5, 120, 'L5-mid']];
  for (const [L, z, name] of shots) {
    await page.evaluate(([L, z]) => { const T = window.__test; T.startLevel(L); const h = T.getBotHint(z); T.teleport(h.x, 6, z); T.setDrag(0, 0.6); for (let i = 0; i < 70; i++) T.tick(1/60); T.clearDrag(); }, [L, z]);
    await page.screenshot({ path: path.join(SHOTS, `${name}-${w}x${h}.png`) });
  }
  if (w === 1180) {
    await page.evaluate(() => { const T = window.__test; T.startLevel(1); T.clearDrag(); for (let i = 0; i < 10; i++) T.tick(1/60); });
    for (let k = 0; k < 4; k++) { // spin filmstrip: forward roll, band should tumble forward
      await page.evaluate(() => { const T = window.__test; T.setDrag(0, 0.35); for (let i = 0; i < 4; i++) T.tick(1/60); });
      await page.screenshot({ path: path.join(SHOTS, `spin-${k}.png`), clip: { x: 440, y: 420, width: 300, height: 300 } });
    }
    await page.evaluate(() => { window.__test.startLevel(1); window.__test.finishNow(); });
    await page.screenshot({ path: path.join(SHOTS, `level-complete-${w}x${h}.png`) });
  }
  await o.ctx.close();
}

server.close();
const pass = results.filter(r => r.pass === true).length, fail = results.filter(r => r.pass === false).length, skip = results.filter(r => r.pass === null).length;
const out = { root: ROOT, when: new Date().toString(), seedsPerLevel: SEEDS, pass, fail, skip, perLevel, results };
fs.writeFileSync(path.join(__dirname, 'accept-results.json'), JSON.stringify(out, null, 2));
console.log(`\nTOTAL pass ${pass} fail ${fail} skip ${skip}`);
process.exit(fail ? 1 : 0);
