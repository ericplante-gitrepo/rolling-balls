// Rolling Balls acceptance suite (slice-3: curves, slopes, hammers, rolling balls, pads, bars, rails, 10 levels).
// Usage: node tools/accept3.mjs [gameDir] [--quick] [--only=group,group]
import { chromium, webkit } from 'playwright';
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
import { serve } from './lib.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : path.join(__dirname, '..'));
const QUICK = process.argv.includes('--quick');
const ONLY = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const want = g => !ONLY.length || ONLY.includes(g);
const SEEDS = QUICK ? 6 : 20;
const SHOTS = path.join(ROOT, 'shots', 'slice-3');
fs.mkdirSync(SHOTS, { recursive: true });
const { server, base } = await serve(ROOT);
const SIZES = [[844, 390], [390, 844], [1024, 768], [1180, 820]];
const results = []; const gap = {}; // gap[item] = {target, measured, pass}
const check = (group, name, pass, detail) => { results.push({ group, name, pass: !!pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} [${group}] ${name}`, detail === undefined ? '' : JSON.stringify(detail).slice(0, 600)); return !!pass; };
const gapRow = (item, target, measured, pass) => { (gap[item] = gap[item] || []).push({ target, measured, pass: !!pass }); };
const LAUNCH = { args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] };

const PROBE = `
window.__probe = {
  // rolling-without-slip check from world displacement; skips frames that are not free rolling
  spin(frames, dt, onFrame) {
    const T = window.__test; const out = { n: 0, good: 0, bad: 0, skipped: 0, worstDot: 1, samples: [] };
    for (let i = 0; i < frames; i++) {
      if (onFrame && onFrame(i) === false) break;
      const s0 = T.getState(); const q0 = new THREE.Quaternion().fromArray(T.getBallQuaternion());
      T.tick(dt);
      const s1 = T.getState(); const q1 = new THREE.Quaternion().fromArray(T.getBallQuaternion());
      if (s1.status === 'complete') break;
      if (s0.status !== 'playing' || s1.status !== 'playing' || !s0.grounded || !s1.grounded) continue;
      if ((s0.onBar ?? -1) >= 0 || (s1.onBar ?? -1) >= 0) { out.skipped++; continue; }
      const near = T.getObstacles().some(o => (o.type === 'sliding' || o.type === 'hammer' || o.type === 'rollball') && Math.abs(s1.s - o.s) < (o.d || 1) / 2 + 1.6 && Math.abs(s1.r - o.r) < (o.w || 1) / 2 + 1.6);
      if (near) { out.skipped++; continue; }
      const dx = s1.ball.x - s0.ball.x, dz = s1.ball.z - s0.ball.z, dist = Math.hypot(dx, dz);
      if (dist < 0.02 || dist > 1.0) continue;
      const dq = q1.clone().multiply(q0.clone().invert()); if (dq.w < 0) { dq.x=-dq.x; dq.y=-dq.y; dq.z=-dq.z; dq.w=-dq.w; }
      const ang = 2 * Math.acos(Math.min(1, dq.w)); const sn = Math.sqrt(Math.max(1e-12, 1 - dq.w * dq.w));
      const ax = [dq.x / sn, dq.y / sn, dq.z / sn]; const ex = [dz / dist, 0, -dx / dist];
      const dot = ax[0] * ex[0] + ax[1] * ex[1] + ax[2] * ex[2];
      const dy = s1.ball.y - s0.ball.y; const ratio = ang / (Math.hypot(dist, dy) / 0.45);
      out.n++; out.worstDot = Math.min(out.worstDot, dot);
      const ok = dot > 0.85 && ratio > 0.8 && ratio < 1.2;
      if (ok) out.good++; else { out.bad++; if (out.samples.length < 6) out.samples.push({ s: +s1.s.toFixed(2), r: +s1.r.toFixed(2), dot: +dot.toFixed(3), ratio: +ratio.toFixed(3), kind: s1.pieceKind }); }
      // a backward-spin frame = spin axis opposite to travel
      if (dot < 0) out.backward = (out.backward || 0) + 1;
    }
    out.worstDot = +out.worstDot.toFixed(3); return out;
  }
};
window.__bot = function (level, seed, opts) {
  opts = opts || {}; const T = window.__test; const dt = opts.dt || 1/60; const maxT = opts.maxT || 120;
  let s = seed >>> 0; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const noise = opts.noise == null ? 0.35 : opts.noise;
  if (typeof level === 'object') T.loadCustomLevel(level); else T.startLevel(level);
  let t = 0, maxSpeed = 0, wobble = 0; const falls = [];
  let lastFall = 0; let backward = 0;
  while (t < maxT) {
    const st = T.getState();
    if (st.status === 'complete') return { level: typeof level === 'object' ? 'custom' : level, seed, done: true, t: +t.toFixed(2), falls: st.fallenCount, fallAt: falls, coins: st.coins, maxSpeed: +maxSpeed.toFixed(2) };
    if (st.fallenCount > lastFall) { falls.push(+st.s.toFixed(1)); lastFall = st.fallenCount; }
    if (st.status === 'playing') {
      const h = T.getBotHint(st.s);
      if (rnd() < 0.02) wobble = (rnd() * 2 - 1) * noise * 0.8;
      wobble *= 0.97;
      const err = (h.r + wobble - st.r);
      let nx = Math.max(-1, Math.min(1, err * 1.6 - st.vr * 0.12 + (rnd() * 2 - 1) * noise * 0.3));
      let ny = h.throttle;
      if (h.brakeTo != null && st.vs > h.brakeTo + 0.3) ny = -Math.min(1, (st.vs - h.brakeTo) / 2);
      ny = Math.max(-1, Math.min(1, ny + (rnd() * 2 - 1) * noise * 0.2));
      T.setDrag(nx, ny);
    }
    T.tick(dt); t += dt; maxSpeed = Math.max(maxSpeed, T.getState().speed || 0);
  }
  const st = T.getState();
  return { level, seed, done: false, t: +t.toFixed(2), falls: st.fallenCount, fallAt: falls, s: +st.s.toFixed(1), status: st.status };
};`;

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
  await page.addScriptTag({ content: PROBE });
  await page.evaluate(r => { window.__test.manual = true; if (!r) window.__test.render = false; }, !!opts.render);
  return { ctx, page, errors, external, missing };
}
const r2 = v => v == null ? v : +(+v).toFixed(2);

// ---------- 1. Load every level at 4 sizes, framing, look basics, screenshots
if (want('load')) for (const [w, h] of SIZES) {
  const o = await open(w, h, { render: true });
  const frames = await o.page.evaluate(() => { const T = window.__test; const out = [];
    for (let L = 1; L <= T.getLevelCount(); L++) { T.startLevel(L); T.setDrag(0, 1); for (let i = 0; i < 40; i++) T.tick(1 / 60); const p = T.projectBall(); out.push({ L, sy: p.sy, size: T.getBallScreenSize ? T.getBallScreenSize() : null }); }
    T.startLevel(1); for (let i = 0; i < 30; i++) T.tick(1/60); return { count: T.getLevelCount(), out }; });
  await o.page.waitForTimeout(200);
  check('load', `${w}x${h} all ${frames.count} levels load+run with no console errors`, o.errors.length === 0, o.errors.slice(0, 3));
  check('load', `${w}x${h} no external requests / 4xx`, o.external.length === 0 && o.missing.length === 0, o.external.concat(o.missing).slice(0, 3));
  const f1 = frames.out[0]; const down = f1.sy / h, size = (f1.size || 0) / h;
  check('camera', `${w}x${h} ball ~70% down the screen (65-76%)`, down >= 0.65 && down <= 0.76, { down: r2(down) });
  check('camera', `${w}x${h} ball 5-8% of screen height`, size >= 0.05 && size <= 0.08, { size: +size.toFixed(3) });
  gapRow('framing', 'ball 65-76% down, 5-8% tall at 4 sizes', `${w}x${h}: ${Math.round(down * 100)}% down, ${(size * 100).toFixed(1)}%`, down >= 0.65 && down <= 0.76 && size >= 0.05 && size <= 0.08);
  const pb = await o.page.evaluate(() => window.__test.getPlanetScreen());
  check('look', `${w}x${h} planet fully on screen, upper-left`, pb && pb.left >= 0 && pb.top >= 0 && pb.right <= w && pb.bottom <= h && (pb.left + pb.right) / 2 < w / 2 && (pb.top + pb.bottom) / 2 < h / 2, pb);
  await o.page.screenshot({ path: path.join(SHOTS, `L1-start-${w}x${h}.png`) });
  const shots = [[2, 'curve', p => p.find(x => Math.abs(x.turn || 0) >= 45)], [3, 'rails', p => p.find(x => x.kind === 'rails')], [5, 'hammer', null], [6, 'pads', p => p.find(x => x.kind === 'gap')], [7, 'side', null], [8, 'rollball', null], [9, 'bowl', p => p.find(x => Math.abs(x.bank || 0) >= 30)], [10, 'bars', p => p.find(x => x.kind === 'bars')]];
  for (const [L, name, pick] of shots) {
    const ok = await o.page.evaluate(([L, name, pickSrc]) => { const T = window.__test; T.startLevel(L); const P = T.getPieces(); let s0 = 20;
      if (pickSrc) { const pc = (new Function('return ' + pickSrc))()(P); if (pc) s0 = Math.max(2, pc.s0 - 14); }
      else { const ob = T.getObstacles().find(o => o.type === (name === 'side' ? 'side' : name)); if (ob) s0 = Math.max(2, ob.s - 16); }
      const h = T.getBotHint(s0); T.placeBall(s0, h.r || 0, 9, 0); T.setDrag(0, 0.8); for (let i = 0; i < 40; i++) { const st = T.getState(); const hh = T.getBotHint(st.s); T.setDrag(Math.max(-1, Math.min(1, (hh.r - st.r) * 1.6)), 0.8); T.tick(1/60); } T.clearDrag(); return T.getState().status; }, [L, name, pick ? pick.toString() : null]).catch(e => String(e));
    await o.page.screenshot({ path: path.join(SHOTS, `L${L}-${name}-${w}x${h}.png`) });
  }
  if (w === 1180) { await o.page.evaluate(() => { window.__test.startLevel(1); window.__test.finishNow(); }); await o.page.screenshot({ path: path.join(SHOTS, `level-complete-${w}x${h}.png`) }); }
  check('load', `${w}x${h} no errors after screenshot tour`, o.errors.length === 0, o.errors.slice(0, 3));
  await o.ctx.close();
}
try { const wb = await webkit.launch(); await wb.close(); check('load', 'webkit available', true); }
catch (e) { results.push({ group: 'load', name: 'webkit (not available on box)', pass: null, detail: String(e).split('\n')[0] }); console.log('SKIP webkit'); }

// ---------- 2. Spin: never backward, rolling without slip, on every level incl. curves/banks/slopes
if (want('spin')) {
  const o = await open();
  const runs = await o.page.evaluate(() => { const T = window.__test; const P = window.__probe; const r = {};
    T.startLevel(1); T.setDrag(0, 1); r.forward = P.spin(300, 1 / 60);
    T.startLevel(2); T.setDrag(0, 1); r.zigzag = P.spin(600, 1 / 60, i => T.setDrag(Math.sin(i / 20), 0.8));
    r.at30Hz = (T.startLevel(1), T.setDrag(0.3, 1), P.spin(90, 1 / 30));
    r.at120Hz = (T.startLevel(9), T.setDrag(-0.3, 1), P.spin(600, 1 / 120));
    return r; });
  for (const [k, v] of Object.entries(runs)) check('spin', `rolls the way it moves: ${k}`, v.n > 20 && v.bad === 0 && !v.backward, v);
  const lv = await o.page.evaluate(() => { const T = window.__test; const P = window.__probe; let n = 0, bad = 0, backward = 0, worst = 1; const samples = [];
    for (let L = 1; L <= T.getLevelCount(); L++) for (let k = 1; k <= 3; k++) {
      let seed = k * 7919 + L; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      T.startLevel(L); let nx = 0, ny = 1;
      const p = P.spin(900, 1 / 60, i => { const st = T.getState(); const h = T.getBotHint(st.s); if (i % 25 === 0) { nx = (rnd() * 2 - 1) * 0.6; ny = 0.4 + rnd() * 0.6; } T.setDrag(Math.max(-1, Math.min(1, (h.r - st.r) * 1.5 + nx)), ny); });
      n += p.n; bad += p.bad; backward += p.backward || 0; worst = Math.min(worst, p.worstDot); samples.push(...p.samples.slice(0, 1).map(x => Object.assign({ L }, x))); }
    return { n, bad, backward, worstDot: worst, samples: samples.slice(0, 8) }; });
  check('spin', 'seeded drags on all levels: 0 backward-spin frames', lv.n > 3000 && lv.backward === 0, lv);
  check('spin', 'seeded drags on all levels: rolling matches travel (>=99.5% of frames)', lv.n > 3000 && lv.bad <= lv.n * 0.005, lv);
  gapRow('global', '0 backward-spin frames', `${lv.backward || 0} backward in ${lv.n} rolling frames (${lv.bad} off-ratio)`, lv.backward === 0);
  check('spin', 'no errors', o.errors.length === 0, o.errors.slice(0, 3));
  await o.ctx.close();
}

// ---------- 3. Drag-to-direction mapping (mouse + touch, real pointer events), on a straight and in a curve
async function mapping(kind) {
  const o = await open(1180, 820, { touch: kind === 'touch', render: true }); const { page } = o;
  await page.evaluate(() => { const T = window.__test; T.startLevel(1); T.clearDrag(); for (let i = 0; i < 20; i++) T.tick(1/60); });
  const cx = 590, cy = 560; let cdp; if (kind === 'touch') cdp = await page.context().newCDPSession(page);
  const settle = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const down = async (x, y) => { kind === 'mouse' ? (await page.mouse.move(x, y), await page.mouse.down()) : await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 0 }] }); await settle(); };
  const move = async (x, y) => { kind === 'mouse' ? await page.mouse.move(x, y, { steps: 4 }) : await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, id: 0 }] }); await settle(); };
  const up = async () => { kind === 'mouse' ? await page.mouse.up() : await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await settle(); };
  const tick = n => page.evaluate(n => { for (let i = 0; i < n; i++) window.__test.tick(1/60); }, n);
  const st = () => page.evaluate(() => { const T = window.__test; const s = T.getState(); const b = T.projectBall(); const c0 = T.worldAt(s.s, 0, 0); const c = T.projectPoint(c0.x, c0.y, c0.z); return { s, rel: b.sx - c.sx, d: T.getDrag() }; });
  const r = {};
  await down(cx, cy); await move(cx, cy - 120); await tick(60);
  const a = await st(); r.forward = { ny: a.d.ny, vs: r2(a.s.vs) };
  await move(cx + 150, cy - 120); await tick(15); const b = await st(); r.right = { nx: b.d.nx, screenDx: r2(b.rel - a.rel), dr: r2(b.s.r - a.s.r) };
  await move(cx - 150, cy - 120); await tick(15); const c = await st(); r.left = { nx: c.d.nx, screenDx: r2(c.rel - b.rel), dr: r2(c.s.r - b.s.r) };
  await move(cx - 150, cy + 200); await tick(120); const d = await st(); r.pullBack = { ny: d.d.ny, vs: +d.s.vs.toFixed(3) };
  await up(); await tick(2); const g = await st(); r.release = { active: g.d.active, nx: g.d.nx, ny: g.d.ny };
  // inside a curve: drag right still moves screen-right
  const cs = await page.evaluate(() => { const T = window.__test; T.startLevel(2); const pc = T.getPieces().find(p => Math.abs(p.turn || 0) >= 45); T.placeBall(pc.s0 + pc.len * 0.4, 0, 9, 0); T.clearDrag(); for (let i = 0; i < 20; i++) T.tick(1/60); return pc.turn; });
  const e0 = await st(); await down(cx, cy); await move(cx, cy - 80); await move(cx + 150, cy - 80); await tick(12); const e1 = await st(); await up();
  r.curveRight = { turn: cs, dr: r2(e1.s.r - e0.s.r), screenDx: r2(e1.rel - e0.rel) };
  check('input', `${kind}: drag up = forward`, r.forward.ny > 0.9 && r.forward.vs > 5, r.forward);
  check('input', `${kind}: drag right = ball moves right on screen`, r.right.nx > 0.5 && r.right.screenDx > 15 && r.right.dr > 0, r.right);
  check('input', `${kind}: drag left = ball moves left on screen`, r.left.nx < -0.5 && r.left.screenDx < -15 && r.left.dr < 0, r.left);
  check('input', `${kind}: drag right inside a curve = screen right`, r.curveRight.dr > 0 && r.curveRight.screenDx > 10, r.curveRight);
  check('input', `${kind}: pull back brakes, never reverses`, r.pullBack.ny < -0.5 && r.pullBack.vs >= -0.01 && r.pullBack.vs < 1, r.pullBack);
  check('input', `${kind}: release clears input`, !r.release.active && r.release.nx === 0 && r.release.ny === 0, r.release);
  check('input', `${kind}: no errors`, o.errors.length === 0, o.errors.slice(0, 2));
  await o.ctx.close();
}
if (want('input')) { await mapping('mouse'); await mapping('touch'); }

// ---------- 4. Base feel (slice-2 numbers must hold) + every gap item measured on custom test levels
if (want('physics')) {
  const o = await open(); const { page } = o;
  const m = await page.evaluate(() => {
    const T = window.__test; const C = T.getConfig(); const r = { cfg: C };
    const run = (n, dt, f) => { for (let i = 0; i < n; i++) { if (f && f(i) === false) break; T.tick(dt || 1/60); } };
    const flat = (len) => ({ name: 'flat', pieces: [{ len: len || 300 }], obstacles: [], checkpoints: [], hints: [{ s: 0, r: 0, throttle: 1 }] });
    // accel / coast / brake / steer
    T.loadCustomLevel(flat()); T.setDrag(0, 1); let t = 0, t90 = null;
    for (let i = 0; i < 240; i++) { T.tick(1/60); t += 1/60; if (t90 === null && T.getState().vs >= 0.9 * C.MAX_SPEED) t90 = +t.toFixed(2); }
    r.accel = { t90, vAt4s: +T.getState().vs.toFixed(2) };
    const v0 = T.getState().vs; T.clearDrag(); run(120); r.coast = { v0: +v0.toFixed(2), vAfter2s: +T.getState().vs.toFixed(2) };
    T.loadCustomLevel(flat()); T.setDrag(0, 1); run(120); T.setDrag(0, -1); let tb = 0, minV = 99; r.brake = {};
    for (let i = 0; i < 180; i++) { T.tick(1/60); tb += 1/60; const s = T.getState(); minV = Math.min(minV, s.vs); if (s.vs < 0.05 && !r.brake.stopSec) r.brake.stopSec = +tb.toFixed(2); }
    r.brake.minVs = +minV.toFixed(3);
    T.loadCustomLevel(flat()); T.setDrag(0, 0.5); run(60); let tl = 0, tLat = null;
    for (let i = 0; i < 30; i++) { T.setDrag(1, 0.5); T.tick(1/60); tl += 1/60; if (tLat === null && T.getState().vr >= 0.9 * C.LAT_MAX) tLat = +tl.toFixed(3); }
    T.setDrag(0, 0.5); const rr = T.getState().r; run(60); r.lateral = { t90: tLat, releaseDrift: +Math.abs(T.getState().r - rr).toFixed(3) };
    // guard rail at top speed (pad speed 16) on a straight
    T.loadCustomLevel(flat()); T.placeBall(10, 0, C.PAD_SPEED, 0); let maxR = 0, fell = false, bounced = false, pv = 0;
    for (let i = 0; i < 90; i++) { T.setDrag(1, 1); T.tick(1/60); const s = T.getState(); maxR = Math.max(maxR, Math.abs(s.r)); if (s.status !== 'playing') fell = true; if (pv > 1 && s.vr < 0) bounced = true; pv = s.vr; }
    r.rail = { maxAbsR: +maxR.toFixed(3), half: T.getTrackInfo(10, 0).half, fell, bounced };

    // G1 curves + banking: 90 deg, R 12, bank 30, no steering at 11 m/s and at 16 m/s
    const curveLvl = (R, deg, bank, guard) => ({ name: 'curve', pieces: [{ len: 30 }, { len: R * Math.abs(deg) * Math.PI / 180, turn: deg, bank, guard: guard || 'both' }, { len: 60 }], obstacles: [], checkpoints: [], hints: [{ s: 0, r: 0, throttle: 1 }] });
    const curveRun = (R, deg, bank, v, hold) => { T.loadCustomLevel(curveLvl(R, deg, bank)); const P = T.getPieces(); const cp = P[1];
      T.placeBall(cp.s0 - 12, 0, v, 0); let maxOut = 0, maxRise = 0, left = false, exitT = null, recenter = null, tt = 0; const sgn = Math.sign(deg);
      for (let i = 0; i < 60 * 8; i++) { const st = T.getState();
        // hold speed v with throttle only up to v (no steering)
        T.setDrag(0, hold ? (st.vs < v ? 1 : 0) : 0); T.tick(1/60); tt += 1/60; const s = T.getState();
        if (s.status !== 'playing') { left = true; break; }
        if (s.s > cp.s0 + 3 && s.s < cp.s1 - 3) { const out = -s.r * sgn; maxOut = Math.max(maxOut, out); const info = T.getTrackInfo(s.s, s.r); const info0 = T.getTrackInfo(s.s, 0); maxRise = Math.max(maxRise, info.y - info0.y); }
        if (s.s >= cp.s1 && exitT === null) exitT = tt;
        if (exitT !== null && recenter === null) { const cam = T.getCamera(); const hd = T.getTrackInfo(s.s, 0).heading; let d = Math.abs(((cam.yaw - hd) + Math.PI * 3) % (Math.PI * 2) - Math.PI); if (d < 5 * Math.PI / 180) recenter = +(tt - exitT).toFixed(3); }
        if (exitT !== null && tt - exitT > 1.5) break; }
      return { R, deg, bank, v, maxOutward: +maxOut.toFixed(2), maxRise: +maxRise.toFixed(2), left, recenterSec: recenter }; };
    r.curve = [curveRun(12, 90, 30, 11, true), curveRun(12, -90, 30, 11, true), curveRun(8, 60, 35, 10, true), curveRun(15, 45, 20, 12, true), curveRun(12, 90, 30, C.MAX_SPEED, true)];
    // G2 slopes
    const slopeLvl = (g, len) => ({ name: 'slope', pieces: [{ len: 20 }, { len, grade: g }, { len: 40 }], obstacles: [], checkpoints: [], hints: [{ s: 0, r: 0, throttle: 1 }] });
    T.loadCustomLevel(slopeLvl(-0.15, 90)); T.placeBall(21, 0, 8, 0); T.clearDrag(); run(180); r.downhill15 = { from: 8, after3s: +T.getState().vs.toFixed(2), gain: +(T.getState().vs - 8).toFixed(2) };
    T.loadCustomLevel(slopeLvl(-0.25, 260)); T.placeBall(21, 0, 10, 0); let vmax = 0; T.setDrag(0, 1); run(60 * 6, 1/60, () => { const s = T.getState(); if (s.s > 275) return false; vmax = Math.max(vmax, s.vs); }); r.downhill25 = { vmax: +vmax.toFixed(2), cap: C.DOWNHILL_CAP };
    T.loadCustomLevel(slopeLvl(0.20, 80)); T.placeBall(20.5, 0, C.MAX_SPEED, 0); T.setDrag(0, 1); run(120); const vu = T.getState().vs; r.uphill20 = { from: C.MAX_SPEED, after2s: +vu.toFixed(2), lossPct: +(100 * (C.MAX_SPEED - vu) / C.MAX_SPEED).toFixed(1) };
    T.loadCustomLevel(slopeLvl(0.25, 120)); T.placeBall(20.5, 0, 3, 0); T.setDrag(0, 1); let minVs = 99; run(60 * 6, 1/60, () => { minVs = Math.min(minVs, T.getState().vs); }); r.uphillHold = { minVs: +minVs.toFixed(3) };
    // camera pitch follows slope: time for camera pitch to make 63% of its change after the ball enters a 20% downhill
    T.loadCustomLevel(slopeLvl(-0.2, 80)); T.placeBall(8, 0, 10, 0); T.setDrag(0, 0.6); let p0 = null, tEnter = null, tt2 = 0; const pitches = [];
    run(60 * 4, 1/60, () => { const s = T.getState(); tt2 += 1/60; const c = T.getCamera(); if (s.s < 9) p0 = c.pitch; if (s.s < 20) {} if (s.s >= 20) { if (tEnter === null) tEnter = tt2; pitches.push([tt2 - tEnter, c.pitch]); } else if (s.s >= 9) pitches.push([null, c.pitch]); if (s.s > 90) return false; });
    const pEnd = pitches.length ? pitches[pitches.length - 1][1] : null; let t63 = null; if (pEnd != null && p0 != null) for (const [tt, p] of pitches) if (Math.abs(p - p0) >= 0.63 * Math.abs(pEnd - p0)) { t63 = tt === null ? 0 : +tt.toFixed(3); break; }
    r.camPitch = { p0: p0 && +p0.toFixed(3), pEnd: pEnd && +pEnd.toFixed(3), t63 };

    // G3 hammer: period, sweep, knock
    const hamLvl = (guard) => ({ name: 'hammer', pieces: [{ len: 120, guard: guard || 'none' }], obstacles: [{ type: 'hammer', s: 40, period: 2.6, phase: 0 }], checkpoints: [], hints: [{ s: 0, r: 0, throttle: 1 }] });
    T.loadCustomLevel(hamLvl('both')); T.placeBall(2, 0, 0, 0); const hr = []; let ht = 0;
    for (let i = 0; i < 60 * 7; i++) { T.clearDrag(); T.tick(1/60); ht += 1/60; const hm = T.getObstacles().find(o => o.type === 'hammer'); if (hm) hr.push([ht, hm.r, hm.vr || 0]); }
    const cross = []; for (let i = 1; i < hr.length; i++) if (hr[i - 1][1] < 0 && hr[i][1] >= 0) cross.push(hr[i][0]);
    const half = T.getTrackInfo(40, 0).half;
    r.hammer = { period: cross.length > 1 ? +((cross[cross.length - 1] - cross[0]) / (cross.length - 1)).toFixed(3) : null, minR: +Math.min(...hr.map(x => x[1])).toFixed(2), maxR: +Math.max(...hr.map(x => x[1])).toFixed(2), half };
    const hits = [];
    for (let k = 0; k < 8; k++) { T.loadCustomLevel(hamLvl('both')); T.placeBall(40 - 9 - k * 0.37, 0, 9, 0); let prev = T.getState(); let hit = null; let frozen = false;
      for (let i = 0; i < 120; i++) { T.setDrag(0, T.getState().vs < 9 ? 1 : 0); T.tick(1/120 * 2); const s = T.getState(); if (s.status === 'playing' && Math.abs(s.vr - prev.vr) > 2.5 && !hit) hit = { dvr: +(s.vr - prev.vr).toFixed(2), vr: +s.vr.toFixed(2), vyUp: +Math.max(0, s.ball.vy - prev.ball.vy).toFixed(2), vsAfter: +s.vs.toFixed(2) }; if (hit && s.vs < 0.5 && s.status === 'playing') frozen = true; prev = s; if (s.s > 46) break; }
      if (hit) hits.push(Object.assign(hit, { frozen })); }
    r.hammerHits = hits;
    // knocked off an unguarded deck
    let offs = 0, tries = 0; for (let k = 0; k < 8; k++) { T.loadCustomLevel(hamLvl('none')); T.placeBall(40 - 9 - k * 0.37, 0, 9, 0); let hitSeen = false, prevVr = 0; tries++;
      for (let i = 0; i < 240; i++) { T.setDrag(0, T.getState().vs < 9 ? 1 : 0); T.tick(1/60); const s = T.getState(); if (Math.abs(s.vr - prevVr) > 2.5) hitSeen = true; prevVr = s.vr; if (s.fallenCount > 0) { if (hitSeen) offs++; break; } } if (!hitSeen) tries--; }
    r.hammerKnockOff = { hits: tries, fellAfterHit: offs };
    // G4 rolling balls
    const rbLvl = (mode) => ({ name: 'rb', pieces: [{ len: 140, guard: 'both' }], obstacles: [mode === 'down' ? { type: 'rollball', mode: 'down', s0: 30, s1: 90, r: 0, diameter: 2, speed: 6 } : { type: 'rollball', mode: 'across', s0: 50, r: 0, diameter: 2, speed: 6 }], checkpoints: [], hints: [{ s: 0, r: 0, throttle: 1 }] });
    r.rollball = {};
    for (const mode of ['down', 'across']) { T.loadCustomLevel(rbLvl(mode)); T.placeBall(2, 0, 0, 0); const samp = []; for (let i = 0; i < 60 * 3; i++) { T.clearDrag(); T.tick(1/60); const b = T.getObstacles().find(o => o.type === 'rollball'); if (b) samp.push([b.s, b.r, b.w || b.d]); }
      let sp = []; for (let i = 10; i < samp.length; i++) { const d = Math.hypot(samp[i][0] - samp[i - 1][0], samp[i][1] - samp[i - 1][1]) * 60; if (d < 20) sp.push(d); }
      sp.sort((a, b) => a - b); const dia = samp.length ? samp[0][2] : null;
      const hitsB = []; for (let k = 0; k < 6; k++) { T.loadCustomLevel(rbLvl(mode)); T.placeBall(mode === 'down' ? 20 : 38, (k - 2.5) * 0.3, 8, 0); let prev = T.getState(), hit = null;
        for (let i = 0; i < 300; i++) { T.setDrag(0, 0.7); T.tick(1/60); const s = T.getState(); if (s.status === 'playing' && Math.abs(s.vr - prev.vr) > 2.5 && !hit) hit = { dvr: +(s.vr - prev.vr).toFixed(2), vr: +s.vr.toFixed(2), vyUp: +Math.max(0, s.ball.vy - prev.ball.vy).toFixed(2), vs: +s.vs.toFixed(2) }; prev = s; if (hit && i > 20 + (hit.i || 0)) break; }
        if (hit) hitsB.push(hit); }
      r.rollball[mode] = { diameter: dia, speedMedian: sp.length ? +sp[Math.floor(sp.length / 2)].toFixed(2) : null, hits: hitsB }; }
    // G5 jump pad
    T.loadCustomLevel({ name: 'pad', pieces: [{ len: 120 }], obstacles: [{ type: 'jump', s: 30, r: 0 }], checkpoints: [], hints: [{ s: 0, r: 0, throttle: 1 }] });
    T.placeBall(20, 0, 10, 0); let air = [], launched = false, landed = false, tA = 0, vy0 = null, bounceMax = 0, tLand = null, ttp = 0, groundY = null;
    for (let i = 0; i < 60 * 4; i++) { T.setDrag(0, 0.5); T.tick(1/120 * 2); ttp += 1/60; const s = T.getState();
      if (!launched && !s.grounded && s.ball.vy > 3) { launched = true; vy0 = s.ball.vy; tA = ttp; groundY = T.getTrackInfo(s.s, s.r).y; }
      if (launched && !landed) { const prevVy = air.length ? air[air.length - 1][2] : vy0; if (s.grounded || s.ball.vy > prevVy + 0.5) { landed = true; tLand = ttp; } else air.push([ttp - tA, s.ball.y, s.ball.vy]); }
      if (landed) { const gy = T.getTrackInfo(s.s, s.r).y; bounceMax = Math.max(bounceMax, s.ball.y - 0.45 - gy); if (ttp - tLand > 1) break; } }
    let R2 = null; if (air.length > 10) { const n = air.length; let S = [0, 0, 0, 0, 0], Sy = [0, 0, 0]; for (const [x, y] of air) { S[0]++; S[1] += x; S[2] += x * x; S[3] += x ** 3; S[4] += x ** 4; Sy[0] += y; Sy[1] += x * y; Sy[2] += x * x * y; }
      const M = [[S[0], S[1], S[2]], [S[1], S[2], S[3]], [S[2], S[3], S[4]]]; const det = m => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
      const D = det(M); const co = [0, 1, 2].map(j => det(M.map((row, i) => row.map((v, k) => k === j ? Sy[i] : v))) / D); const mean = Sy[0] / n; let ssr = 0, sst = 0; for (const [x, y] of air) { const f = co[0] + co[1] * x + co[2] * x * x; ssr += (y - f) ** 2; sst += (y - mean) ** 2; } R2 = 1 - ssr / sst; }
    r.jumpPad = { vy0: vy0 && +vy0.toFixed(2), airtime: tLand && +(tLand - tA).toFixed(3), R2: R2 && +R2.toFixed(5), bounce: +bounceMax.toFixed(3) };
    // G6 side boost
    r.side = [];
    for (const dir of [1, -1]) { T.loadCustomLevel({ name: 'side', pieces: [{ len: 120, width: 5 }], obstacles: [{ type: 'side', s: 30, r: 0, dir }], checkpoints: [], hints: [{ s: 0, r: 0, throttle: 1 }] });
      T.placeBall(24, 0, 9, 0); let t0 = null, r0 = null, tt = 0, d03 = null;
      for (let i = 0; i < 240; i++) { T.setDrag(0, 0.7); T.tick(1/120); tt += 1/120; const s = T.getState(); if (t0 === null && Math.abs(s.vr) > 2) { t0 = tt - 1/120; r0 = 0; } if (t0 !== null && d03 === null && tt - t0 >= 0.3) d03 = s.r - r0; }
      r.side.push({ dir, disp03: d03 == null ? null : +d03.toFixed(3) }); }
    // G7 sliding bars
    T.loadCustomLevel({ name: 'bars', pieces: [{ len: 20 }, { kind: 'bars', len: 20, bars: [{ s: 2.5, len: 4, w: 2, amp: 1.6, period: 2, phase: 0 }, { s: 7, len: 4, w: 2, amp: 1.6, period: 2, phase: 1 }, { s: 11.5, len: 4, w: 2, amp: 1.6, period: 2.2, phase: 2 }, { s: 16, len: 4, w: 2, amp: 1.6, period: 1.8, phase: 3 }] }, { len: 40 }], obstacles: [], checkpoints: [], hints: [{ s: 0, r: 0, throttle: 1 }] });
    let bars = T.getObstacles().filter(o => o.type === 'bar'); const b0 = bars[0];
    const brs = []; let bt = 0; for (let i = 0; i < 60 * 5; i++) { T.tick(1/60); bt += 1/60; const b = T.getObstacles().filter(o => o.type === 'bar')[0]; brs.push([bt, b.r]); }
    const bc = []; for (let i = 1; i < brs.length; i++) if (brs[i - 1][1] < 0 && brs[i][1] >= 0) bc.push(brs[i][0]);
    const barPeriod = bc.length > 1 ? +((bc[bc.length - 1] - bc[0]) / (bc.length - 1)).toFixed(3) : null;
    // carried: stand on bar 1 still
    const b1 = T.getObstacles().filter(o => o.type === 'bar')[0]; T.placeBall(b1.s, b1.r, 0, 0); T.clearDrag(); let maxRel = 0, carriedSpan = 0, rmin = 99, rmax = -99, onAll = true;
    for (let i = 0; i < 60 * 1.5; i++) { T.tick(1/60); const s = T.getState(); const b = T.getObstacles().filter(o => o.type === 'bar')[0]; if (s.status !== 'playing') { onAll = false; break; } maxRel = Math.max(maxRel, Math.abs(s.r - b.r)); rmin = Math.min(rmin, s.r); rmax = Math.max(rmax, s.r); }
    // miss: put the ball in the void between bar positions
    const bb = T.getObstacles().filter(o => o.type === 'bar')[0]; T.placeBall(bb.s, bb.r > 0 ? bb.r - 2.6 : bb.r + 2.6, 0, 0); T.clearDrag(); let fellMiss = false; for (let i = 0; i < 60 * 3; i++) { T.tick(1/60); if (T.getState().fallenCount > 0) { fellMiss = true; break; } }
    r.bars = { period: barPeriod, carried: onAll, maxRelToBar: +maxRel.toFixed(3), carriedSpan: +(rmax - rmin).toFixed(2), fellWhenMissed: fellMiss };
    // G8 thin rails: width and drag sensitivity at 12 m/s (screen 1180 wide; joystick radius as the game computes)
    const W = 1180, H = 820; const Rj = Math.max(70, Math.min(140, 0.16 * Math.min(W, H))); const dz = n => Math.abs(n) <= 0.08 ? 0 : Math.sign(n) * (Math.abs(n) - 0.08) / 0.92;
    const railLvl = { name: 'rails', pieces: [{ len: 30 }, { kind: 'rails', len: 80, width: 0.5, rails: [0], guard: 'none' }, { len: 30 }], obstacles: [], checkpoints: [], hints: [{ s: 0, r: 0, throttle: 1 }] };
    const railTry = (frac, hold) => { T.loadCustomLevel(railLvl); T.placeBall(34, 0, 12, 0); const nx = dz(Math.min(1, frac * W / Rj)); let tt = 0, fell = false;
      for (let i = 0; i < 240; i++) { const s0 = T.getState(); T.setDrag(tt < hold ? nx : 0, 0); T.setVelocity(12, s0.vr, s0.vy); T.tick(1/120); tt += 1/120; if (T.getState().fallenCount > 0) { fell = true; break; } }
      return { frac, nx: +nx.toFixed(3), hold, fell }; };
    T.loadCustomLevel(railLvl); const railW = T.getPieces()[1].width;
    r.rails = { width: railW, small: railTry(0.03, 0.15), big: railTry(0.15, 0.25), sweep: [0.02, 0.04, 0.06, 0.08, 0.10, 0.12, 0.15].map(f => railTry(f, 0.2)) };
    // G9 checkpoint + respawn
    const cpLvl = { name: 'cp', pieces: [{ len: 60 }, { len: 60, guard: 'none' }], obstacles: [], checkpoints: [40], hints: [{ s: 0, r: 0, throttle: 1 }] };
    const fallTest = (useCp) => { T.loadCustomLevel(cpLvl); if (useCp) { T.setDrag(0, 1); for (let i = 0; i < 900 && T.getState().checkpointIndex < 0; i++) T.tick(1/60); }
      T.placeBall(useCp ? 70 : 62, 0, 6, 0); const camY0 = T.getCamera().y; T.setDrag(1, 0.3); let t = 0, tf = null, tr = null, minCamY = 99;
      for (let i = 0; i < 900; i++) { T.tick(1/60); t += 1/60; const s = T.getState(); if (tf === null && s.status !== 'playing') { tf = t; T.clearDrag(); }
        if (tf !== null && s.status !== 'playing') minCamY = Math.min(minCamY, T.getCamera().y);
        if (tf !== null && s.status === 'playing') { tr = t; break; } }
      const s = T.getState(); return { cpIndex: s.checkpointIndex, respawnSec: tr && +(tr - tf).toFixed(3), respawnS: +s.s.toFixed(2), respawnR: +s.r.toFixed(2), speedAfter: +s.speed.toFixed(3), camDrop: +(camY0 - minCamY).toFixed(2) }; };
    r.respawnStart = fallTest(false); r.respawnCP = fallTest(true);
    // timestep independence on a curvy level
    const fr = dt => { T.startLevel(2); T.setDrag(0.2, 1); const n = Math.round(4 / dt), half = Math.round(2 / dt); for (let i = 0; i < n; i++) { if (i === half) T.setDrag(-0.2, 1); T.tick(dt); } const s = T.getState(); return [+s.s.toFixed(3), +s.r.toFixed(3)]; };
    r.timestep = { hz30: fr(1/30), hz60: fr(1/60), hz120: fr(1/120) };
    // camera smoothness on a curvy level with the nominal bot
    T.startLevel(9); let prev = null, maxJerk = 0, maxStep = 0;
    for (let i = 0; i < 60 * 25; i++) { const st = T.getState(); const h = T.getBotHint(st.s); T.setDrag(Math.max(-1, Math.min(1, (h.r - st.r) * 1.6 - st.vr * 0.12)), h.brakeTo != null && st.vs > h.brakeTo + 0.3 ? -0.6 : h.throttle); T.tick(1/60);
      const c = T.getCamera(); if (T.getState().status !== 'playing') { prev = null; continue; }
      if (prev) { const v = [c.x - prev.c.x, c.y - prev.c.y, c.z - prev.c.z]; if (prev.v) maxJerk = Math.max(maxJerk, Math.hypot(v[0] - prev.v[0], v[1] - prev.v[1], v[2] - prev.v[2])); maxStep = Math.max(maxStep, Math.hypot(...v)); prev = { c, v }; } else prev = { c }; }
    r.camera = { maxFrameDeltaVel: +maxJerk.toFixed(4), maxStepPerFrame: +maxStep.toFixed(3) };
    // level content audit
    r.levels = []; for (let L = 1; L <= T.getLevelCount(); L++) { T.startLevel(L); const P = T.getPieces(); const O = T.getObstacles();
      r.levels.push({ L, name: T.getLevelName(L), len: +T.getTrackLength().toFixed(0), turns: P.filter(p => p.turn).map(p => [p.turn, +(p.len / (Math.abs(p.turn) * Math.PI / 180)).toFixed(1), p.bank || 0]), grades: P.filter(p => p.grade).map(p => p.grade), rails: P.filter(p => p.kind === 'rails').map(p => p.width), bars: P.filter(p => p.kind === 'bars').length, gaps: P.filter(p => p.kind === 'gap').length,
        types: [...new Set(O.map(o => o.type))] }); }
    return r;
  });
  fs.writeFileSync(path.join(__dirname, 'metrics-slice3.json'), JSON.stringify(m, null, 2));
  const C = m.cfg;
  check('speed', `top speed ~16 m/s (Eric, Nov 9; was 12) reached, 0-90% in 0.7-1.6 s`, C.MAX_SPEED >= 15 && C.MAX_SPEED <= 17 && Math.abs(m.accel.vAt4s - C.MAX_SPEED) < 0.5 && m.accel.t90 >= 0.7 && m.accel.t90 <= 1.6, Object.assign({ MAX_SPEED: C.MAX_SPEED }, m.accel));
  check('speed', 'coast keeps 25-80% after 2 s', m.coast.vAfter2s > 0.25 * m.coast.v0 && m.coast.vAfter2s < 0.8 * m.coast.v0, m.coast);
  check('speed', 'brake stops < 1.2 s, never reverses', m.brake.stopSec && m.brake.stopSec < 1.2 && m.brake.minVs >= -0.01, m.brake);
  check('steer', 'lateral 90% in < 0.35 s; release drift < 0.6 m', m.lateral.t90 !== null && m.lateral.t90 < 0.35 && m.lateral.releaseDrift < 0.6, m.lateral);
  check('rails', 'guard rail holds at pad speed with full steer and bounces', !m.rail.fell && m.rail.maxAbsR <= m.rail.half && m.rail.bounced, m.rail);
  // G1
  const cv = m.curve; const banked = cv.slice(0, 4);
  const g1a = check('G1', 'curves 45-90 deg R8-15 bank20-35: no-steer ball rides 0.5-1.5 m outward at 10-12 m/s', banked.every(c => !c.left && c.maxOutward >= 0.5 && c.maxOutward <= 1.5), banked);
  const g1b = check('G1', 'curve at top speed with no steering: stays on the track', !cv[4].left, cv[4]);
  const g1c = check('G1', 'camera re-centres behind the ball within 0.5 s after a turn', cv.every(c => c.recenterSec !== null && c.recenterSec <= 0.5), cv.map(c => c.recenterSec));
  gapRow('1 Curves + banking', 'no-steer ride-up 0.5-1.5 m at >=10 m/s, never leaves', banked.map(c => `${c.deg}°/R${c.R}/${c.bank}°@${c.v}: ${c.maxOutward} m`).join('; ') + `; ${cv[4].v} m/s: ${cv[4].left ? 'LEFT TRACK' : 'stays on (' + cv[4].maxOutward + ' m)'}`, g1a && g1b);
  gapRow('1 Curves + banking', 'camera re-centres <= 0.5 s', cv.map(c => c.recenterSec + ' s').join(', '), g1c);
  const lvTurns = m.levels.flatMap(l => l.turns); const okTurns = lvTurns.filter(([d, R, b]) => Math.abs(d) >= 45 && Math.abs(d) <= 90 && R >= 8 && R <= 15 && b >= 20 && b <= 35);
  check('G1', 'levels use 45-90 deg / R 8-15 / bank 20-35 turns', okTurns.length >= 10, { total: lvTurns.length, inSpec: okTurns.length });
  // G2
  const g2a = check('G2', 'downhill 15%, no input, from 8 m/s: +2..+4 m/s in 3 s', m.downhill15.gain >= 2 && m.downhill15.gain <= 4, m.downhill15);
  const g2b = check('G2', 'downhill 25% capped at DOWNHILL_CAP (top speed + 3; spec said 15 before the 16 m/s change)', m.downhill25.vmax <= C.DOWNHILL_CAP + 0.05 && m.downhill25.vmax >= C.DOWNHILL_CAP - 0.5, m.downhill25);
  const g2c = check('G2', 'uphill 20% holding forward from top speed: loses 30-60% in 2 s', m.uphill20.lossPct >= 30 && m.uphill20.lossPct <= 60, m.uphill20);
  const g2d = check('G2', 'never rolls backward while holding forward on 25%', m.uphillHold.minVs >= -0.01, m.uphillHold);
  const g2e = check('G2', 'camera pitches with the slope within 0.3 s (63%)', m.camPitch.t63 !== null && m.camPitch.t63 <= 0.3 && Math.abs(m.camPitch.pEnd - m.camPitch.p0) > 0.05, m.camPitch);
  gapRow('2 Slopes', 'downhill +2..4 m/s / 3 s', `+${m.downhill15.gain} m/s (15%, from 8)`, g2a);
  gapRow('2 Slopes', `cap (15 m/s in spec; now ${C.DOWNHILL_CAP} with 16 m/s top speed)`, `max ${m.downhill25.vmax} m/s on 25%`, g2b);
  gapRow('2 Slopes', 'uphill 20% loses 30-60%', `${m.uphill20.lossPct}% in 2 s`, g2c);
  gapRow('2 Slopes', 'camera pitch <= 0.3 s', `${m.camPitch.t63} s to 63%`, g2e);
  // G3
  const hm = m.hammer; const hh = m.hammerHits;
  const g3a = check('G3', 'hammer period 2.0-3.0 s', hm.period >= 2 && hm.period <= 3, hm);
  const g3b = check('G3', 'hammer sweeps full deck width', hm.minR <= -(hm.half - 0.3) && hm.maxR >= hm.half - 0.3, hm);
  const g3c = check('G3', 'hammer hit: 4-8 m/s sideways, <= 2 m/s up, never freezes', hh.length >= 3 && hh.every(x => Math.abs(x.vr) >= 4 && Math.abs(x.vr) <= 8 && x.vyUp <= 2 && !x.frozen), hh);
  const g3d = check('G3', 'hammer hit on an open edge knocks the ball off', m.hammerKnockOff.hits > 0 && m.hammerKnockOff.fellAfterHit >= Math.ceil(m.hammerKnockOff.hits * 0.5), m.hammerKnockOff);
  gapRow('3 Hammers', 'period 2-3 s, full width', `${hm.period} s, head r ${hm.minR}..${hm.maxR} (half ${hm.half})`, g3a && g3b);
  gapRow('3 Hammers', 'hit 4-8 m/s side, <=2 up, no freeze', `${hh.length} hits, |vr| ${hh.map(x => Math.abs(x.vr)).join('/')}, up max ${Math.max(0, ...hh.map(x => x.vyUp))}`, g3c);
  // G4
  const rb = m.rollball;
  const rbAll = [...(rb.down?.hits || []), ...(rb.across?.hits || [])];
  const g4a = check('G4', 'rolling balls 1.5-2.5 m, 4-8 m/s', ['down', 'across'].every(k => rb[k] && rb[k].diameter >= 1.5 && rb[k].diameter <= 2.5 && rb[k].speedMedian >= 4 && rb[k].speedMedian <= 8), rb);
  const g4b = check('G4', 'rolling ball hit: 4-8 m/s sideways, <= 2 up', rbAll.length >= 3 && rbAll.every(x => Math.abs(x.vr) >= 4 && Math.abs(x.vr) <= 8 && x.vyUp <= 2), rbAll);
  gapRow('4 Rolling balls', '1.5-2.5 m, 4-8 m/s', `down ${rb.down?.diameter} m @ ${rb.down?.speedMedian} m/s; across ${rb.across?.diameter} m @ ${rb.across?.speedMedian} m/s`, g4a);
  gapRow('4 Rolling balls', 'knock like hammers', `${rbAll.length} hits, |vr| ${rbAll.map(x => Math.abs(x.vr)).join('/')}`, g4b);
  // G5
  const jp = m.jumpPad;
  const g5 = check('G5', 'jump pad vy 8-10, airtime 0.9-1.2 s, R2 > 0.98, bounce < 0.1 m', jp.vy0 >= 8 && jp.vy0 <= 10.6 && jp.airtime >= 0.9 && jp.airtime <= 1.2 && jp.R2 > 0.98 && jp.bounce < 0.1, jp);
  gapRow('5 Jump pads', 'vy 8-10, air 0.9-1.2 s, R²>0.98, bounce<0.1', `vy ${jp.vy0}, air ${jp.airtime} s, R² ${jp.R2}, bounce ${jp.bounce} m`, g5);
  // G6
  const g6 = check('G6', 'side boost shoves one lane (1.35-1.65 m) within 0.3 s, both ways', m.side.every(x => x.disp03 != null && Math.abs(Math.abs(x.disp03) - 1.5) <= 0.15 && Math.sign(x.disp03) === x.dir), m.side);
  gapRow('6 Side-boost panels', '1.5 m in 0.3 s', m.side.map(x => `${x.dir > 0 ? 'right' : 'left'} ${x.disp03} m`).join(', '), g6);
  // G7
  const br = m.bars;
  const g7 = check('G7', 'sliding bars: period 1.5-2.5 s, carry a still ball, fall when missed', br.period >= 1.5 && br.period <= 2.5 && br.carried && br.maxRelToBar < 0.3 && br.carriedSpan > 1 && br.fellWhenMissed, br);
  gapRow('7 Sliding floor bars', 'period 1.5-2.5 s, carried, miss = fall', `${br.period} s, carried ${br.carried} (rel ${br.maxRelToBar} m, moved ${br.carriedSpan} m), miss falls ${br.fellWhenMissed}`, g7);
  // G8
  const rl = m.rails;
  const g8 = check('G8', 'thin rails 0.4-0.6 m; small (3%) drag stays on, big (15%) drag falls at 12 m/s', rl.width >= 0.4 && rl.width <= 0.6 && !rl.small.fell && rl.big.fell, rl);
  const thr = rl.sweep.filter(x => !x.fell).map(x => x.frac); 
  gapRow('8 Thin rails', '0.4-0.6 m; drags > ~1/10 width fall', `${rl.width} m; largest 0.2 s drag that stays on: ${thr.length ? Math.max(...thr) * 100 + '%' : 'none'} of width`, g8);
  // G9
  const rs = m.respawnStart, rc = m.respawnCP;
  const g9 = check('G9', 'respawn 2.0 s at rest at last checkpoint (else start)', rs.respawnSec >= 1.95 && rs.respawnSec <= 2.06 && rs.respawnS < 1 && rs.speedAfter < 0.01 && rc.cpIndex >= 0 && rc.respawnSec >= 1.95 && rc.respawnSec <= 2.06 && Math.abs(rc.respawnS - 40) < 1 && rc.speedAfter < 0.01, { rs, rc });
  check('camera', 'camera holds during a fall (drops < 1.5 m)', rs.camDrop < 1.5 && rc.camDrop < 1.5, { rs: rs.camDrop, rc: rc.camDrop });
  gapRow('9 Checkpoint rings', 'respawn 2.0 s at rest at checkpoint', `${rc.respawnSec} s at s=${rc.respawnS} (cp 40), speed ${rc.speedAfter}; no-cp ${rs.respawnSec} s at s=${rs.respawnS}`, g9);
  const [a, b, c] = [m.timestep.hz30, m.timestep.hz60, m.timestep.hz120];
  check('timestep', 'same input at 30/60/120 Hz ends within 5 cm (curvy L2)', Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.05 && Math.hypot(c[0] - b[0], c[1] - b[1]) < 0.05, m.timestep);
  check('camera', 'camera smooth on curvy L9 (frame dv < 0.06 m, step < 0.4 m)', m.camera.maxFrameDeltaVel < 0.06 && m.camera.maxStepPerFrame < 0.4, m.camera);
  // order of mechanics
  const first = t => { const i = m.levels.findIndex(l => t(l)); return i < 0 ? 99 : i + 1; };
  const order = { rails: first(l => l.rails.length), hammer: first(l => l.types.includes('hammer')), padsGaps: first(l => l.types.includes('jump') && l.gaps), hammerBalls: first(l => l.types.includes('hammer') && l.types.includes('rollball')), bars: first(l => l.bars) };
  const okOrder = m.levels.length === 10 && order.rails < order.hammer && order.hammer < order.padsGaps && order.padsGaps < order.hammerBalls && order.hammerBalls < order.bars && order.bars <= 10;
  check('levels', '10 levels; mechanics appear in the video order (rails > hammer > pads/gaps > hammers+balls > bars)', okOrder, { order, levels: m.levels.map(l => [l.L, l.name, l.len]) });
  gapRow('11 Levels', '10 levels in video order', `${m.levels.length} levels; first rails L${order.rails}, hammer L${order.hammer}, pads+gaps L${order.padsGaps}, hammers+balls L${order.hammerBalls}, bars L${order.bars}`, okOrder);
  check('physics', 'no errors', o.errors.length === 0, o.errors.slice(0, 3));
  await o.ctx.close();
}

// ---------- 5. Levels: nominal bot (0 falls, 10-40 s) at 30/60/120 Hz + seeded noisy runs (~90%)
const perLevel = {};
if (want('levels')) {
  const o = await open(); const { page } = o;
  const N = await page.evaluate(() => window.__test.getLevelCount());
  let tot = 0, done = 0;
  for (let L = 1; L <= N; L++) {
    const nominal = await page.evaluate(L => window.__bot(L, 1, { noise: 0 }), L);
    check('levels', `L${L} nominal bot: 0 falls, 10-40 s`, nominal.done && nominal.falls === 0 && nominal.t >= 10 && nominal.t <= 40, nominal);
    const runs = await page.evaluate(([L, n]) => { const out = []; for (let s = 1; s <= n; s++) out.push(window.__bot(L, 1000 + s * 31, { noise: 0.35, maxT: 120 })); return out; }, [L, SEEDS]);
    const ok = runs.filter(r => r.done && r.falls === 0); const finished = runs.filter(r => r.done);
    const tt = finished.map(r => r.t).sort((x, y) => x - y);
    perLevel[L] = { nominalSec: nominal.t, nominalDone: nominal.done, runs: runs.length, cleanRuns: ok.length, finishedEventually: finished.length, medianSec: tt[Math.floor(tt.length / 2)], fallsAt: runs.flatMap(r => r.fallAt).slice(0, 12) };
    tot += runs.length; done += ok.length;
  }
  const rate = done / tot;
  check('levels', `seeded noisy bot clean-finish rate overall ~90% (85-99%)`, rate >= 0.85 && rate <= 0.99, { rate: +rate.toFixed(3), perLevel: Object.fromEntries(Object.entries(perLevel).map(([k, v]) => [k, `${v.cleanRuns}/${v.runs}`])) });
  gapRow('global', 'noisy bot finishes ~90% (not 100%)', `${done}/${tot} = ${(rate * 100).toFixed(1)}% clean runs (noise 0.35, ${SEEDS} seeds x ${N} levels)`, rate >= 0.85 && rate <= 0.99);
  gapRow('11 Levels', 'each 10-40 s', Object.entries(perLevel).map(([k, v]) => `L${k} ${v.nominalSec}s`).join(', '), Object.values(perLevel).every(v => v.nominalDone && v.nominalSec >= 10 && v.nominalSec <= 40));
  for (const dt of [1 / 30, 1 / 120]) {
    const rs = await page.evaluate(([dt, N]) => Array.from({ length: N }, (_, i) => window.__bot(i + 1, 1, { noise: 0, dt })), [dt, N]);
    check('levels', `all levels complete with 0 falls at ${Math.round(1 / dt)} Hz`, rs.every(r => r.done && r.falls === 0), rs.map(r => [r.level, r.done, r.t, r.falls]));
  }
  await page.evaluate(n => { window.__test.startLevel(n); window.__test.finishNow(); }, N);
  await page.click('#continue-button'); const lvl = await page.evaluate(() => window.__test.getState().level);
  check('levels', `Continue after level ${N} loops to level 1`, lvl === 1, { level: lvl });
  check('levels', 'no page errors during level runs', o.errors.length === 0, o.errors.slice(0, 3));
  await o.ctx.close();
}

server.close();
const pass = results.filter(r => r.pass === true).length, fail = results.filter(r => r.pass === false).length, skip = results.filter(r => r.pass === null).length;
const out = { root: ROOT, when: new Date().toString(), seedsPerLevel: SEEDS, pass, fail, skip, perLevel, gap, results };
fs.writeFileSync(path.join(__dirname, 'accept3-results.json'), JSON.stringify(out, null, 2));
console.log(`\nTOTAL pass ${pass} fail ${fail} skip ${skip}`);
process.exit(fail ? 1 : 0);
