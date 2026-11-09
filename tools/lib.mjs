// Shared harness helpers: static server for a game dir, in-page measurement snippets.
import http from 'http';
import fs from 'fs';
import path from 'path';
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png' };
export async function serve(root) {
  const server = http.createServer((req, res) => {
    let url = decodeURIComponent(req.url.split('?')[0]);
    if (url === '/') url = '/index.html';
    const fp = path.join(root, url.replace(/^\//, ''));
    if (!fp.startsWith(root) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); res.end('no'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(fp).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}/` };
}
// Installed into the page: measures rolling spin vs actual travel each tick.
export const SPIN_PROBE = `
window.__spinProbe = function (frames, dt, onFrame) {
  const T = window.__test; const out = { n: 0, good: 0, bad: 0, ratioSum: 0, worstDot: 1, samples: [] };
  for (let i = 0; i < frames; i++) {
    if (onFrame) onFrame(i);
    const s0 = T.getState(); const q0 = new THREE.Quaternion().fromArray(T.getBallQuaternion());
    T.tick(dt);
    const s1 = T.getState(); const q1 = new THREE.Quaternion().fromArray(T.getBallQuaternion());
    if (s0.status !== 'playing' || s1.status !== 'playing' || !s1.grounded && s1.grounded !== undefined) continue;
    // Frames where a sliding wall shoved the ball are excluded by design: spin follows rolling, not push-outs.
    if (T.getObstacles().some(o => o.type === 'sliding' && Math.abs(s1.ball.z - o.z) < o.d / 2 + 0.6 && Math.abs(s1.ball.x - o.x) < o.w / 2 + 0.6)) { out.wallFrames = (out.wallFrames || 0) + 1; continue; }
    const dx = s1.ball.x - s0.ball.x, dz = s1.ball.z - s0.ball.z, dist = Math.hypot(dx, dz);
    if (dist < 0.02) continue;
    const dq = q1.clone().multiply(q0.clone().invert()); if (dq.w < 0) { dq.x=-dq.x; dq.y=-dq.y; dq.z=-dq.z; dq.w=-dq.w; }
    const ang = 2 * Math.acos(Math.min(1, dq.w)); const sn = Math.sqrt(Math.max(1e-12, 1 - dq.w * dq.w));
    const ax = [dq.x / sn, dq.y / sn, dq.z / sn];
    const ex = [dz / dist, 0, -dx / dist];
    const dot = ax[0] * ex[0] + ax[1] * ex[1] + ax[2] * ex[2];
    const ratio = ang / (dist / 0.45);
    out.n++; out.ratioSum += ratio; out.worstDot = Math.min(out.worstDot, dot);
    if (dot > 0.9 && ratio > 0.85 && ratio < 1.15) out.good++; else out.bad++;
    if (!(dot > 0.9 && ratio > 0.85 && ratio < 1.15) && out.samples.length < 8) out.samples.push({ z: +s1.ball.z.toFixed(2), x: +s1.ball.x.toFixed(2), dx: +dx.toFixed(3), dz: +dz.toFixed(3), dot: +dot.toFixed(3), ratio: +ratio.toFixed(3) });
  }
  out.meanRatio = out.n ? +(out.ratioSum / out.n).toFixed(3) : null; delete out.ratioSum; out.worstDot = +out.worstDot.toFixed(3);
  return out;
};`;
