(function () {
  'use strict';

  // TOP_SPEED is the one speed knob (Eric, Nov 9: "higher top speed", 12 -> 16 m/s).
  // Everything speed-dependent below is derived from it so retuning stays one edit.
  const TOP_SPEED = 16;
  const C = {
    BALL_R: 0.45, GRAVITY: 22, MAX_SPEED: TOP_SPEED,
    ACCEL: TOP_SPEED, // 0 -> 90% of top speed in ~1.4 s at any top speed
    BRAKE: Math.round(TOP_SPEED * 1.3125), /* 9cea556: 21 at 16 m/s */ // full pull-back stops from top speed in ~0.65 s
    ROLL_DRAG: 0.15, COAST_DRAG: 0.55, DOWNHILL_CAP: TOP_SPEED + 4,
    PAD_SPEED: TOP_SPEED + 5, PAD_DURATION: 1.2, PAD_VY: 10.5,
    FAST_SPEED: 10, // FOV widening + edge streaks from here (VISUAL_GAPS 12)
    LAT_MAX: TOP_SPEED * 8.5 / 16, /* 9cea556: ~0.53x cruise */ LAT_RESPONSE: 14, AIR_RESPONSE: 2.5,
    SLOPE_G: 10, LAT_G: 22, DOWNHILL_DRAG: 0.05, UPHILL_DRIVE_CUT: 0.85, KNOCK_T: 0.6, BANK_DAMP: 4, RESPAWN_S: 2, INPUT_GRACE: 0.4,
    SIDE_T: 0.25, FIXED_DT: 1 / 120, CAMERA_BEHIND: 8.5,
    CAMERA_ABOVE: 2.3, LOOK_AHEAD: 10, LOOK_HEIGHT: 2.1, CAMERA_LATERAL: 0.6, FOV: 60, FAST_FOV: 64,
    CAMERA_TAU: 0.11, /* 9cea556: cruise lead ~1.8 m at 16 m/s */ FOV_TAU: 0.25, GUARD_HEIGHT: 0.35,
    RAIL_RESTITUTION: 0.35
  };
  const $ = id => document.getElementById(id);
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const mix = (a, b, t) => a + (b - a) * t;
  const damp = (dt, tau) => 1 - Math.exp(-dt / tau);
  const rad = d => d * Math.PI / 180;
  const ss = x => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
  const vec = () => new THREE.Vector3();
  const palette = [0xFF8FB1, 0x9AF0FF, 0xB6F36A, 0xFFD23F];
  const names = ['First Roll', 'Smash Bend', 'Thin Rails', 'Slide Gate',
    'Hammer Time', 'Pads & Gaps', 'Side Step', 'Rolling Thunder', 'Big Bowl', 'Sliding Bars'];
  const state = {
    level: 1, progress: 0, coins: 0, status: 'playing', s: 0, r: 0, h: 0,
    vs: 0, vr: 0, vb: 0, vy: 0, grounded: true, onBar: -1, checkpointIndex: -1,
    fallenCount: 0, simTime: 0, respawnAt: null, fallAt: null,
    ball: { x: 0, y: C.BALL_R, z: 0, vx: 0, vy: 0, vz: 0 }
  };
  const drag = { nx: 0, ny: 0, active: false };
  const keys = new Set();
  const origin = { x: 0, y: 0 };
  let lastStreak = '', pointer = null, scene, camera, renderer, root, ball, planet, hills, keyLight;
  let pieces = [], obstacles = [], checkpoints = [], coins = [], debris = [], hints = [];
  let finishS = 150, lowest = 0, accumulator = 0, lastFrame = null;
  let grace = 0, boost = -1, sideTime = 0, sideDir = 0, camYaw = 0, knockUntil = -1;
  let width = 1, height = 1, serial = 0, rng = 12345;
  const look = vec(), frozen = vec(), angular = vec(), axis = vec(), temp = vec();
  const quat = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  let mats;

  function random() {
    rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
    return rng / 4294967296;
  }
  function mat(color, extra) {
    return new THREE.MeshStandardMaterial({ color, roughness: 0.72, ...extra });
  }
  function emissive(color) {
    return mat(color, { emissive: color, emissiveIntensity: 0.6 });
  }
  function srgb(texture) {
    if ('colorSpace' in texture) texture.colorSpace = THREE.SRGBColorSpace;
    else texture.encoding = THREE.sRGBEncoding;
    return texture;
  }
  function box(w, h, d, material, parent = root) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    parent.add(m);
    return m;
  }
  function sphere(radius, material, parent = root, detail = 16) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(radius, detail, 12), material);
    parent.add(m);
    return m;
  }

  // Constant-curvature frames are evaluated analytically, not accumulated per frame.
  function frameAt(s) {
    let p = pieces[pieces.length - 1];
    for (const q of pieces) {
      if (s < q.s1) { p = q; break; }
    }
    const u = s - p.s0, a = p.psi + p.k * u;
    let x, z;
    if (Math.abs(p.k) < 1e-9) {
      x = p.x + Math.sin(p.psi) * u;
      z = p.z + Math.cos(p.psi) * u;
    } else {
      x = p.x + (Math.cos(p.psi) - Math.cos(a)) / p.k;
      z = p.z + (Math.sin(a) - Math.sin(p.psi)) / p.k;
    }
    let y = p.y0 + p.g * u, grade = p.g;
    if (p.ease > 0 && u >= 0 && u < p.ease) {
      const t = u / p.ease, dg = p.g - p.prevGrade;
      grade = p.prevGrade + dg * ss(t);
      y = p.y0 + p.prevGrade * u + dg * p.ease * (t * t * t - t * t * t * t / 2);
    } else if (p.ease > 0 && u >= p.ease) {
      y -= (p.g - p.prevGrade) * p.ease / 2;
    }
    return { p, x, z, y, grade, a, u };
  }
  function bankAt(f, r) {
    const p = f.p;
    if (!p.turn || !p.bank) return { y: 0, slope: 0, bank: 0 };
    const fade = ss(f.u / Math.min(4, p.len / 2)) *
      ss((p.len - f.u) / Math.min(4, p.len / 2));
    const B = rad(p.bank) * fade, sign = Math.sign(p.turn), half = p.width / 2;
    const q = -r * sign; // outward offset (outer side is opposite the turn)
    // Integral of tan(phi). Keeping the analytic primitive makes the rendered
    // cross section and the lateral force use exactly the same surface.
    // Bowl: slope angle B*(0.55 + 0.45*q) for outward offset q (m): flat-ish inside, steep outside,
    // so a no-steer ball settles 0.5-1.5 m up the outer side at 10-12 m/s.
    const a = B * 0.55, b = B * 0.45;
    if (Math.abs(b) < 1e-8) return { y: 0, slope: 0, bank: 0 };
    const phi = clamp(a + b * q, -1.25, 1.25);
    const y = (Math.log(Math.cos(a)) - Math.log(Math.cos(phi))) / b;
    return { y, slope: -sign * Math.tan(phi), bank: p.bank * fade };
  }
  function barMotion(o, time) {
    const a = time * Math.PI * 2 / o.period + o.phase;
    return { r: o.amp * Math.sin(a), vr: o.amp * Math.PI * 2 / o.period * Math.cos(a) };
  }
  function sampleTrack(s, r = 0) {
    const f = frameAt(s), p = f.p, b = bankAt(f, r);
    let center = 0, half = p.width / 2, onBar = -1;
    let deck = p.kind !== 'gap' && p.kind !== 'bars';
    if (p.kind === 'rails') {
      const rails = p.rails || [0];
      center = rails.reduce((a, v) => Math.abs(v - r) < Math.abs(a - r) ? v : a, rails[0]);
    }
    if (p.kind === 'bars') {
      let distance = Infinity;
      for (const o of obstacles) {
        if (o.type !== 'bar' || o.pieceIndex !== p.index) continue;
        const m = barMotion(o, state.simTime);
        const ds = Math.max(0, Math.abs(s - o.s) - o.d / 2);
        const dr = Math.max(0, Math.abs(r - m.r) - o.w / 2);
        if (ds * ds + dr * dr < distance) {
          distance = ds * ds + dr * dr; center = m.r; half = o.w / 2;
        }
        if (Math.abs(s - o.s) <= o.d / 2 && Math.abs(r - m.r) <= o.w / 2) {
          center = m.r; half = o.w / 2; onBar = o.id; deck = true; break;
        }
      }
    }
    return {
      y: f.y + b.y, yc: f.y, grade: f.grade, bank: b.bank,
      surfaceSlopeLat: b.slope, heading: f.a, kappa: p.k,
      half, center, over: deck && Math.abs(r - center) <= half &&
        s >= -8 && s <= pieces[pieces.length - 1].s1 + 8,
      guard: p.kind === 'rails' || p.kind === 'bars' || p.kind === 'gap' ? 'none' : p.guard,
      kind: p.kind, piece: p, pieceIndex: p.index, onBar
    };
  }
  function worldAt(s, r = 0, h = 0) {
    const f = frameAt(s), b = bankAt(f, r);
    return { x: f.x - Math.cos(f.a) * r, y: f.y + b.y + h,
      z: f.z + Math.sin(f.a) * r };
  }
  function setObject(o, s, r, lift) {
    const w = worldAt(s, r, lift);
    o.position.set(w.x, w.y, w.z);
    o.rotation.y = frameAt(s).a;
  }
  function surfaceRate(s, r, vs, vr) {
    const e = 0.015;
    return (sampleTrack(s + e, r).y - sampleTrack(s - e, r).y) / (2 * e) * vs +
      sampleTrack(s, r).surfaceSlopeLat * vr;
  }

  function levelDef(n) {
    const d = {
      name: names[n - 1],
      pieces: [],
      obstacles: [],
      checkpoints: [],
      hints: []
    };
    let distance = 0;

    const add = (len, extra = {}) => {
      const s = distance;
      d.pieces.push({ len, ...extra });
      distance += len;
      return s;
    };
    const run = (len, grade, extra = {}) =>
      add(len, { grade, ease: 4, ...extra });
    const ob = (type, s, extra = {}) =>
      d.obstacles.push({ type, s, ...extra });
    const lane = (s, r) => d.hints.push({ s, r, throttle: 1 });
    const bend = (turn, grade = 0.14, radius = 10, bank = 28) =>
      run(radius * Math.abs(turn) * Math.PI / 180, grade, {
        turn, bank
      });
    const candy = (len, grade, extra = {}) => {
      const s = run(len, grade, extra);
      ob('pile', s + len / 2);
      return s;
    };
    const hazard = (type, grade, extra = {}, len = 28) => {
      const s = run(len, grade);
      ob(type, s + len / 2, extra);
      return s;
    };
    const rail = (turn) => {
      run(18, 0.14);
      add(26, {
        kind: 'rails',
        width: 0.5,
        rails: [0],
        turn,
        grade: 0,
        ease: 4
      });
      run(18, -0.14);
    };
    const twin = () => {
      run(18, 0.14);
      const s = add(24, {
        kind: 'rails',
        width: 0.5,
        rails: [-1, 1],
        grade: 0,
        ease: 4
      });
      lane(s - 12, 0);
      lane(s - 2, 1);
      lane(s + 26, 1);
      lane(s + 38, 0);
      run(18, -0.14);
    };
    const split = (dir) => {
      run(18, 0.14);
      const r = dir * 1.5;
      const s = add(24, {
        kind: 'rails',
        width: 1.35,
        rails: [0, r],
        grade: 0,
        ease: 4
      });
      ob('side', s - 1, { dir, r: 0 });
      lane(s - 12, 0);
      lane(s - 1, 0);
      lane(s + 4, r);
      lane(s + 26, r);
      lane(s + 38, 0);
      run(18, -0.14);
    };
    const floorBars = (count, grade, amp = 1) => {
      const len = count * 4;
      return run(len, grade, {
        kind: 'bars',
        bars: Array.from({ length: count }, (_, i) => ({
          s: i * 4 + 2,
          len: 3.6,
          w: 2.2,
          amp,
          period: 3,
          phase: i * 0.22
        }))
      });
    };
    const jumpDrop = (approachLen = 18) => {
      const s = run(approachLen, 0.16);
      ob('jump', s + approachLen - 2);
      add(6, { kind: 'gap', gapDy: -3 });
      run(36, -0.12);
    };

    run(20, 0.14);

    if (n === 1) {
      // Basics: rolling crests, guarded S-bends, two candy piles, one uphill open-edge straight.
      candy(24, -0.18);
      bend(45, 0.14, 11, 24);
      run(24, 0.16);
      run(24, -0.22);
      bend(-45, 0.14, 11, 24);
      run(24, 0.16, { guard: 'right' });
      run(24, -0.25);
      bend(-45, 0.14, 11, 24);
      candy(24, 0.16);
      run(24, -0.22);
      bend(45, 0.14, 11, 24);
      run(24, 0.14);
      run(22, -0.18);
    } else if (n === 2) {
      // Candy rhythm: repeated smash-and-crest beats, tight alternating S-bends, descending chutes.
      candy(24, -0.18);
      bend(45, 0.14, 10, 28);
      candy(24, 0.16);
      candy(24, -0.24);
      bend(-45, 0.14, 10, 28);
      candy(24, 0.16, { guard: 'left' });
      run(24, -0.25);
      bend(-45, 0.14, 10, 28);
      candy(24, 0.18);
      candy(24, -0.22);
      bend(45, 0.14, 10, 28);
      candy(24, 0.16);
      run(22, -0.18);
    } else if (n === 3) {
      // Rail introduction: candy dip, lane-hinted twin rails, rolling S-bend, one forgiving 10-degree precision rail.
      candy(24, -0.18);
      bend(45, 0.14);
      twin();
      run(24, 0.18);
      candy(24, -0.24);
      bend(-45, 0.14);
      rail(10);
      candy(24, 0.16);
      run(24, -0.24);
      run(22, 0.12);
    } else if (n === 4) {
      // Sliding walls: isolated wall-and-candy pairs over hills, guarded S-bend, 10-degree rail cooldown.
      hazard('sliding', -0.16, { phase: 0 });
      candy(28, 0.16);
      bend(45, 0.14);
      hazard('sliding', -0.22, { phase: 1.5 });
      candy(28, 0.16);
      bend(-45, 0.14);
      hazard('sliding', -0.25, { phase: 0.7 }, 24);
      run(24, 0.18);
      rail(10);
      candy(24, 0.16);
      run(22, -0.22);
    } else if (n === 5) {
      // Hammer introduction: separated pendulum decisions, candy recovery hills, short chutes, one 11-degree rail.
      hazard('hammer', -0.16, { period: 2.8 });
      candy(28, 0.16);
      bend(45, 0.14, 10, 30);
      hazard('hammer', -0.22, { period: 2.8, phase: 1.4 });
      candy(28, 0.16);
      bend(-45, 0.14, 10, 30);
      hazard('hammer', -0.25, { period: 2.7, phase: 0.6 }, 24);
      run(24, 0.18);
      rail(11);
      candy(24, 0.16);
      run(22, -0.22);
    } else if (n === 6) {
      // Flight: punchy pad drop, uphill speed-pad gap, second pad landing, candy recovery and an 11-degree rail.
      jumpDrop(18);
      bend(45, 0.14, 10, 30);
      const s = run(24, 0.20);
      ob('speed', s + 8);
      add(6, { kind: 'gap', gapDy: -3 });
      run(30, -0.25);
      bend(-45, 0.16, 10, 30);
      jumpDrop(20);
      rail(11);
      candy(24, 0.16);
      run(22, -0.20);
    } else if (n === 7) {
      // Split-platform transfers: right panel, rolling left bend, left panel, return bend and one 12-degree rail.
      candy(24, -0.18);
      lane(0, 0);
      split(1);
      run(24, 0.16);
      bend(-45, 0.14, 10, 30);
      candy(24, -0.24);
      split(-1);
      run(24, 0.16);
      bend(45, 0.14, 10, 30);
      rail(12);
      candy(24, 0.16);
      run(22, -0.22);
    } else if (n === 8) {
      // Mixed traffic: hammer, downhill rolling ball, hammer reprise, 12-degree rail, then an isolated crossing ball.
      hazard('hammer', -0.16, { period: 2.8 });
      candy(28, 0.16);
      bend(45, 0.14, 10, 30);
      let s = run(36, -0.20);
      ob('rollball', s + 16, {
        s0: s + 6,
        s1: s + 28,
        r: -0.8,
        mode: 'down',
        diameter: 2,
        speed: 5
      });
      run(24, 0.18);
      bend(-45, 0.14, 10, 30);
      hazard('hammer', -0.22, { period: 2.8, phase: 1 });
      candy(28, 0.16);
      rail(12);
      hazard('rollball', 0.14, {
        mode: 'across',
        diameter: 2,
        speed: 4
      });
      candy(24, 0.16);
      run(22, -0.24);
    } else if (n === 9) {
      // Banked bowls: four compact opposing banked turns, crest-hidden hammers, candy hills and one 12-degree rail.
      candy(24, -0.18);
      bend(45, 0.18, 8.5, 35);
      run(24, -0.25);
      hazard('hammer', 0.16, { period: 2.8 });
      bend(-45, 0.14, 8.5, 35);
      candy(24, -0.22);
      rail(12);
      bend(-45, 0.16, 8.5, 35);
      run(24, -0.25);
      hazard('hammer', 0.16, { period: 2.8, phase: 0.4 });
      bend(45, 0.14, 8.5, 35);
      candy(24, -0.22);
      run(24, 0.16);
      run(22, -0.22);
    } else {
      // Finale: three sliding-floor phrases, separated hammer and rolling-ball decisions, descending S-bend and 12-degree rail.
      candy(24, -0.18);
      floorBars(5, 0.14, 0.95);
      run(24, -0.24);
      bend(45, 0.16, 10, 30);
      hazard('hammer', -0.18, { period: 2.8, phase: 0.5 });
      run(24, 0.16);
      floorBars(5, -0.14, 1);
      run(24, 0.16);
      bend(-45, 0.14, 10, 30);
      hazard('rollball', -0.22, {
        mode: 'across',
        diameter: 2,
        speed: 4
      });
      run(24, 0.18);
      floorBars(7, -0.14, 1.1);
      run(24, 0.16);
      rail(12);
      candy(24, 0.16);
      run(22, -0.22);
    }

    if (n >= 3) {
      const spans = [];
      let s = 0;
      for (const p of d.pieces) {
        if ((!p.kind || p.kind === 'deck') && !p.turn && p.len >= 14) {
          spans.push({ lo: s + 6, hi: s + p.len - 6 });
        }
        s += p.len;
      }

      for (let target = 100; target < distance - 25; target += 100) {
        let best = null;
        let bestScore = Infinity;
        for (const span of spans) {
          const center = Math.max(span.lo, Math.min(span.hi, target));
          const candidates = [center, span.lo, span.hi];
          for (let c = Math.ceil(span.lo); c <= span.hi; c += 2) {
            candidates.push(c);
          }
          for (const c of candidates) {
            if (Math.abs(c - target) > 30) continue;
            if (d.checkpoints.some(previous => c - previous < 65)) continue;
            const clear = d.obstacles.every(o => {
              if (o.type === 'rollball' && o.mode === 'down') {
                return c < o.s0 - 8 || c > o.s1 + 8;
              }
              return Math.abs(o.s - c) >= (o.type === 'pile' ? 5 : 10);
            });
            if (!clear) continue;
            const score = Math.abs(c - target);
            if (score < bestScore) {
              bestScore = score;
              best = c;
            }
          }
        }
        if (best !== null) d.checkpoints.push(best);
      }
    }

    d.hints.sort((a, b) => a.s - b.s);
    return d;
  }

  function disposeRoot() {
    if (!root) return;
    const gs = new Set(), ms = new Set(), ts = new Set();
    root.traverse(o => {
      if (o.geometry) gs.add(o.geometry);
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => ms.add(m));
    });
    ms.forEach(m => { if (m.map) ts.add(m.map); m.dispose(); });
    gs.forEach(g => g.dispose()); ts.forEach(t => t.dispose()); scene.remove(root);
  }
  function build(def, number) {
    clearInput(); disposeRoot();
    root = new THREE.Group(); scene.add(root);
    mats = {
      top: mat(0x2C2F86), navy: mat(0x1B1F55), mint: emissive(0x3EE6B0),
      yellow: emissive(0xFFD23F), seam: mat(0x3A3FA3),
      coral: mat(0xFF6F7D), white: emissive(0xFFFFFF)
    };
    obstacles = []; checkpoints = []; coins = []; debris = []; pieces = [];
    hints = (def.hints && def.hints.length ? def.hints : [{ s: 0, r: 0, throttle: 1 }])
      .map(h => ({ throttle: 1, r: 0, ...h })).sort((a, b) => a.s - b.s);
    serial = 0; rng = 12345 + number; lowest = 0;
    let s = 0, x = 0, z = 0, y = 0, psi = 0, prevGrade = 0;
    for (const source of def.pieces) {
      const p = { width: 4.6, guard: 'both', kind: 'deck', turn: 0, bank: 0,
        grade: 0, ease: 0, ...source };
      p.len = Math.max(0.1, p.len); p.s0 = s; p.s1 = s + p.len;
      p.index = pieces.length; p.k = -rad(p.turn) / p.len; /* + turn bends to screen-right */ p.psi = psi;
      p.g = p.kind === 'gap' ? (p.gapDy || 0) / p.len : p.grade;
      p.ease = clamp(p.ease, 0, p.len); p.prevGrade = prevGrade;
      p.x = x; p.z = z; p.y0 = y + (p.stepUp || 0);
      pieces.push(p);
      const f = frameAt(p.s1);
      x = f.x; z = f.z; y = f.y; psi = f.a; s = p.s1; prevGrade = p.g;
      lowest = Math.min(lowest, p.y0, y);
    }
    finishS = Math.max(1, s - 6);
    for (const p of pieces) if (p.kind === 'bars') {
      for (const b of p.bars || []) addObstacle({
        type: 'bar', s: p.s0 + b.s, d: b.len || 3.6, w: b.w || 2,
        amp: b.amp || 1.2, period: b.period || 2, phase: b.phase || 0, pieceIndex: p.index
      });
    }
    buildRibbons();
    buildGround();
    for (const o of def.obstacles || []) {
      if (o.type === 'checkpoint') addCheckpoint(o.s);
      else if (o.type === 'pile') {
        for (let i = 0; i < 9; i++) addObstacle({
          type: 'candy', s: o.s + Math.floor(i / 3) * 0.55,
          r: (i % 3 - 1) * 0.55, color: palette[i % 3], pile: o.s
        });
      } else addObstacle(o);
    }
    (def.checkpoints || []).forEach(s0 => addCheckpoint(typeof s0 === 'number' ? s0 : s0.s));
    checkpoints.sort((a, b) => a.s - b.s);
    for (let s0 = 7; s0 < finishS - 3; s0 += 12) {
      for (let i = 0; i < 6 && s0 + i * 1.5 < finishS - 2; i++) {
        const cs = s0 + i * 1.5, h = authoredHint(cs);
        if (sampleTrack(cs, h.r).over) addCoin(cs, h.r);
      }
    }
    addFinish();
    Object.assign(state, {
      level: number, progress: 0, coins: 0, status: 'playing', checkpointIndex: -1,
      fallenCount: 0, simTime: 0, respawnAt: null, fallAt: null
    });
    accumulator = 0; lastFrame = null; test.paused = false;
    if ($('pause-button')) $('pause-button').classList.remove('paused');
    $('level-complete').style.display = 'none';
    $('level-title').textContent = 'Level ' + number + ' · ' + (def.name || 'Workshop');
    resetBall(0, 0); hud();
  }

  // Geometry is batched by material. All stripes are actual curved ribbons.
  function buildRibbons() {
    const batches = {};
    function quad(name, a, b, c, d) {
      const arr = batches[name] || (batches[name] = []);
      for (const p of [a, b, c, a, c, d]) arr.push(p.x, p.y, p.z);
    }
    function strip(name, s0, s1, r0, r1, lift = 0) {
      quad(name, worldAt(s0, r0, lift), worldAt(s0, r1, lift),
        worldAt(s1, r1, lift), worldAt(s1, r0, lift));
    }
    for (const p of pieces) {
      if (p.kind === 'gap' || p.kind === 'bars') continue;
      const centers = p.kind === 'rails' ? (p.rails || [0]) : [0];
      const count = Math.ceil(p.len / (p.turn ? 0.25 : 0.5));
      for (let i = 0; i < count; i++) {
        const a = p.s0 + p.len * i / count, b = p.s0 + p.len * (i + 1) / count;
        // Evaluate endpoints just inside their own piece at discontinuous ledges.
        const aa = a + 1e-6, bb = b - 1e-6;
        for (const center of centers) {
          const lo = center - p.width / 2, hi = center + p.width / 2;
          for (let j = 0; j < 10; j++) strip('top', aa, bb,
            mix(lo, hi, j / 10), mix(lo, hi, (j + 1) / 10));
          strip('navy', aa, bb, lo, hi, -0.4);
          for (const sign of [-1, 1]) {
            const edge = sign < 0 ? lo : hi;
            quad('navy', worldAt(aa, edge), worldAt(bb, edge),
              worldAt(bb, edge, -0.4), worldAt(aa, edge, -0.4));
            const bands = p.width < 0.8
              ? [[0, 0.055, 'navy'], [0.055, 0.12, 'yellow'], [0.14, 0.21, 'mint']]
              : [[0, 0.05, 'navy'], [0.05, 0.15, 'yellow'],
                [0.15, 0.2, 'navy'], [0.2, 0.35, 'mint']];
            for (const [l, h, material] of bands)
              strip(material, aa, bb, edge - sign * l, edge - sign * h, 0.012);
            const side = sign > 0 ? 'right' : 'left';
            if (p.kind !== 'rails' && (p.guard === 'both' || p.guard === side)) {
              quad('navy', worldAt(aa, edge, 0), worldAt(bb, edge, 0),
                worldAt(bb, edge, 0.35), worldAt(aa, edge, 0.35));
              strip('mint', aa, bb, edge - 0.055, edge + 0.055, 0.35);
            }
          }
          if (Math.floor(a / 4) !== Math.floor(b / 4))
            strip('seam', Math.max(aa, b - 0.045), bb, lo + 0.36, hi - 0.36, 0.016);
        }
      }
    }
    for (const name of Object.keys(batches)) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(batches[name], 3));
      g.computeVertexNormals();
      const material = mats[name]; material.side = THREE.DoubleSide;
      const mesh = new THREE.Mesh(g, material); mesh.name = 'track-' + name; root.add(mesh);
    }
  }
  function buildGround() {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#35205B'; ctx.fillRect(0, 0, 128, 128);
    ctx.strokeStyle = 'rgba(124,63,196,.25)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(128, 0);
    ctx.moveTo(0, 0); ctx.lineTo(0, 128); ctx.stroke();
    const texture = srgb(new THREE.CanvasTexture(c));
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.repeat.set(300, 300);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(1200, 1200),
      mat(0xFFFFFF, { map: texture }));
    ground.name = 'ground'; ground.rotation.x = -Math.PI / 2; ground.position.y = lowest - 25; root.add(ground);
  }

  function addObstacle(source) {
    const o = {
      id: serial++, r: 0, phase: 0, period: 2.6, amp: 1.1, speed: 5,
      w: 1.6, h: 1.5, d: 0.4, cooldown: -1, used: false, dead: false,
      ...source
    };
    if (o.s === undefined) o.s = o.s0 || 0;
    o.baseS = o.s; o.baseR = o.r; o.vr = 0; o.vs = 0;
    const g = new THREE.Group(); root.add(g); o.mesh = g; g.name = o.type;
    if (o.type === 'hammer') {
      o.w = 2; o.h = 1.2; o.d = 1.2;
      const half = sampleTrack(o.s, 0).half;
      o.length = 4.85;
      o.amplitude = Math.asin(clamp((half - 0.25) / o.length, 0.2, 0.9));
      const support = new THREE.Group(); root.add(support); o.support = support;
      setObject(support, o.s, 0, 0);
      const post = box(0.3, 6, 0.3, mats.navy, support);
      post.position.set(half + 0.2, 3, 0);
      const beam = box(half + 0.5, 0.25, 0.3, mats.navy, support);
      beam.position.set(half / 2, 5.6, 0);
      const arm = box(0.15, o.length, 0.15, mats.navy, support);
      o.arm = arm;
      box(2, 1.2, 1.2, mats.navy, g);
      for (const x of [-0.65, 0, 0.65]) {
        const stripe = box(0.18, 1.22, 1.22, mats.coral, g); stripe.position.x = x;
      }
    } else if (o.type === 'rollball') {
      o.diameter = o.diameter || 2; o.w = o.h = o.d = o.diameter;
      const body = sphere(o.diameter / 2, mats.coral, g, 24); o.body = body;
      for (const a of [0, Math.PI / 2]) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(o.diameter * 0.495, 0.055, 6, 32), mats.navy);
        ring.rotation.y = a; body.add(ring);
      }
      o.mode = o.mode || 'down'; o.s0 = o.s0 === undefined ? o.s : o.s0;
      o.s1 = o.s1 === undefined ? o.s0 + 20 : o.s1;
    } else if (['jump', 'speed', 'side'].includes(o.type)) {
      o.w = o.type === 'side' ? 1.4 : 3.6; o.d = o.type === 'side' ? 1.4 : 0.7; o.h = 0.05;
      box(o.w, o.h, o.d, o.type === 'jump' ? mats.yellow : mats.mint, g);
      for (let i = -1; i <= 1; i++) {
        const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.3, 3), mats.white);
        arrow.rotation.x = Math.PI / 2;
        if (o.type === 'side') arrow.rotation.z = (o.dir || 1) * Math.PI / 2;
        arrow.position.set(i * o.w / 4, 0.05, 0); g.add(arrow);
      }
      if (o.type === 'side') {
        const plate = box(0.12, 1.1, 1.4, mats.mint);
        setObject(plate, o.s, (o.dir || 1) * sampleTrack(o.s, 0).half, 0.55);
      }
    } else if (o.type === 'candy') {
      o.w = o.h = o.d = 0.5;
      o.color = o.color || palette[o.id % palette.length];
      box(o.w, o.h, o.d, mat(o.color), g);
    } else {
      if (o.type === 'bar') o.h = 0.4;
      box(o.w, o.h, o.d, mats.navy, g);
      const edge = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(o.w + 0.005, o.h + 0.005, o.d + 0.005)),
        new THREE.LineBasicMaterial({ color: o.type === 'bar' ? 0x3EE6B0 : 0xFFFFFF }));
      g.add(edge);
      if (o.type === 'bar') {
        for (const x of [-1, 1]) {
          const stripe = box(0.12, 0.025, o.d, mats.mint, g);
          stripe.position.set(x * (o.w / 2 - 0.13), o.h / 2, 0);
        }
      }
    }
    obstacles.push(o); updateObstacle(o, 0);
    return o;
  }
  function hammerMotion(o, time) {
    const a = time * Math.PI * 2 / o.period + o.phase;
    const theta = o.amplitude * Math.sin(a);
    const omega = o.amplitude * Math.PI * 2 / o.period * Math.cos(a);
    return { theta, r: o.length * Math.sin(theta),
      lift: 5.6 - o.length * Math.cos(theta),
      vr: o.length * Math.cos(theta) * omega };
  }
  function acrossMotion(o, time) {
    const range = Math.max(0.5, sampleTrack(o.s0, 0).half - o.diameter / 2);
    const u = (time * o.speed + o.phase) / (2 * range);
    const f = ((u % 2) + 2) % 2;
    return { r: -range + (f <= 1 ? f : 2 - f) * 2 * range, vr: (f <= 1 ? 1 : -1) * o.speed };
  }
  function updateObstacle(o, dt) {
    let lift = o.h / 2;
    if (o.type === 'sliding' || o.type === 'wall' || o.type === 'bar') {
      const m = barMotion(o, state.simTime);
      o.r = m.r; o.vr = m.vr;
      if (o.type === 'bar') lift = -o.h / 2;
    } else if (o.type === 'hammer') {
      const m = hammerMotion(o, state.simTime);
      o.r = m.r; o.vr = m.vr; o.theta = m.theta; lift = m.lift;
      o.arm.position.set(-o.r / 2, 5.6 - o.length * Math.cos(m.theta) / 2, 0);
      o.arm.rotation.z = -m.theta;
    } else if (o.type === 'rollball') {
      if (o.mode === 'across') {
        const m = acrossMotion(o, state.simTime);
        o.r = m.r; o.vr = m.vr; o.s = o.s0; o.vs = 0;
      } else {
        const length = Math.max(1, o.s1 - o.s0);
        o.s = o.s1 - ((state.simTime * o.speed + o.phase) % length);
        o.vs = -o.speed; o.r = o.baseR;
      }
      lift = o.diameter / 2;
      if (dt) {
        const f = frameAt(o.s);
        axis.set(Math.cos(f.a) * o.vs + Math.sin(f.a) * o.vr, 0,
          -Math.sin(f.a) * o.vs + Math.cos(f.a) * o.vr).normalize();
        quat.setFromAxisAngle(axis, Math.hypot(o.vs, o.vr) * dt / (o.diameter / 2));
        o.body.quaternion.premultiply(quat);
      }
    } else if (['jump', 'speed', 'side'].includes(o.type)) lift = 0.035;
    setObject(o.mesh, o.s, o.r, lift);
    if (o.type === 'hammer') o.mesh.rotation.z = -o.theta;
    o.y = o.mesh.position.y;
  }

  function arrowTexture() {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#FFFFFF';
    ctx.beginPath(); ctx.moveTo(50, 110); ctx.lineTo(78, 110); ctx.lineTo(78, 56);
    ctx.lineTo(110, 56); ctx.lineTo(64, 10); ctx.lineTo(18, 56);
    ctx.lineTo(50, 56); ctx.closePath(); ctx.fill();
    return srgb(new THREE.CanvasTexture(c));
  }
  function addCheckpoint(s) {
    const g = new THREE.Group(); root.add(g); setObject(g, s, 0, 0);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.18, 40),
      emissive(0xFFD23F)); ring.material.side = THREE.DoubleSide;
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.02; g.add(ring);
    const arrow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: arrowTexture(), transparent: true, side: THREE.DoubleSide }));
    arrow.rotation.x = -Math.PI / 2; arrow.rotation.z = Math.PI;
    arrow.position.y = 0.025; g.add(arrow);
    const half = sampleTrack(s, 0).half;
    for (const sign of [-1, 1]) {
      const post = box(0.18, 4, 0.18, mats.navy, g);
      post.position.set(sign * half, 2, 0);
      const light = box(0.04, 3.8, 0.2, mats.mint, g);
      light.position.set(sign * (half - 0.1), 2, 0);
    }
    const top = box(half * 2 + 0.2, 0.18, 0.18, mats.navy, g); top.position.y = 4; g.name = 'checkpoint';
    checkpoints.push({ s, mesh: ring, passed: false });
  }
  function addCoin(s, r) {
    const g = new THREE.Group(); root.add(g); setObject(g, s, r, 0.7);
    const face = new THREE.Mesh(new THREE.CylinderGeometry(0.265, 0.265, 0.07, 16),
      // Art Director (Nov 9): unlit, flat #FFD23F over the whole face, so it never reads mustard.
      new THREE.MeshBasicMaterial({ color: 0xFFD23F, fog: false }));
    face.name = 'coin-face';
    face.rotation.x = Math.PI / 2; g.add(face); g.name = 'coin';
    g.add(new THREE.Mesh(new THREE.TorusGeometry(0.276, 0.022, 6, 20), mat(0xE0A800)));
    coins.push({ s, r, mesh: g, collected: false });
  }
  function addFinish() {
    const g = new THREE.Group(); root.add(g); setObject(g, finishS, 0, 2.5); g.name = 'finish';
    g.add(new THREE.Mesh(new THREE.TorusGeometry(2.5, 0.075, 8, 64), emissive(0x9AF0FF))); /* 5 m ring (VISUAL_GAPS 7) */
    for (let i = 0; i < 16; i++) {
      const bulb = sphere(0.12, mats.white, g, 8), a = i * Math.PI / 8;
      bulb.position.set(2.5 * Math.cos(a), 2.5 * Math.sin(a), 0);
    }
    const points = [];
    for (let i = 0; i < 100; i++) {
      const t = i / 99, a = t * Math.PI * 7, radius = t * 1.9;
      points.push(new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius, 0));
    }
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({ color: 0x9AF0FF, transparent: true, opacity: 0.8 })));
  }

  function burst(position, color, count, sparks = 0, kind = 'chunk') {
    for (let i = 0; i < count + sparks; i++) {
      const size = i >= count ? 0.045 : 0.12 + random() * 0.09;
      const m = box(size, size, size, mat(color || palette[i % 4], { transparent: true }));
      m.name = i >= count ? 'spark' : kind;
      m.position.copy(position);
      debris.push({ mesh: m, age: 0, vx: (random() - 0.5) * 8,
        vy: 3 + random() * 6, vz: (random() - 0.5) * 8 });
    }
  }
  function updateProps(dt) {
    obstacles.forEach(o => { if (!o.dead) updateObstacle(o, dt); });
    coins.forEach(c => { if (!c.collected) c.mesh.rotation.y += Math.PI * dt; });
    checkpoints.forEach(c => c.mesh.scale.setScalar(1.04 + 0.04 * Math.sin(state.simTime * Math.PI * 2)));
    for (let i = debris.length - 1; i >= 0; i--) {
      const d = debris[i]; d.age += dt;
      if (d.age >= 1.4) { // smash debris gone within 1.5 s (VISUAL_GAPS 8)
        root.remove(d.mesh); d.mesh.geometry.dispose(); d.mesh.material.dispose();
        debris.splice(i, 1); continue;
      }
      d.vy -= C.GRAVITY * dt;
      d.mesh.position.addScaledVector(new THREE.Vector3(d.vx, d.vy, d.vz), dt);
      d.mesh.rotation.x += dt * 5; d.mesh.rotation.z += dt * 3;
      d.mesh.material.opacity = clamp((1.4 - d.age) / 0.4, 0, 1);
    }
  }

  function authoredHint(s) {
    if (s <= hints[0].s) return { r: hints[0].r, throttle: hints[0].throttle };
    for (let i = 1; i < hints.length; i++) {
      const a = hints[i - 1], b = hints[i];
      if (s > b.s) continue;
      const t = clamp((s - a.s) / Math.max(0.001, b.s - a.s), 0, 1);
      return { r: mix(a.r, b.r, t), throttle: mix(a.throttle, b.throttle, t) };
    }
    const h = hints[hints.length - 1]; return { r: h.r, throttle: h.throttle };
  }
  function getBotHint(s = state.s) {
    const hint = authoredHint(s), speed = Math.max(4, state.vs);
    const p = frameAt(s).p;
    if (p.kind === 'rails') {
      const rails = p.rails || [0];
      hint.r = rails.reduce((a, r) => Math.abs(r - hint.r) < Math.abs(a - hint.r) ? r : a, rails[0]);
    }
    for (const next of pieces) {
      if (next.kind !== 'rails' || next.s0 < s || next.s0 - s > 10) continue;
      const rails = next.rails || [0];
      const target = rails.reduce((a, r) => Math.abs(r - hint.r) < Math.abs(a - hint.r) ? r : a, rails[0]);
      hint.r = mix(hint.r, target, ss((10 - (next.s0 - s)) / 7));
    }
    let nearestBar = null, barDistance = Infinity;
    for (const o of obstacles) {
      if (o.dead) continue;
      const ds = o.s - s, arrival = state.simTime + Math.max(0, ds) / speed;
      if (o.type === 'bar' && ds >= -o.d / 2 && ds < barDistance && ds < 12) {
        nearestBar = o; barDistance = ds; continue;
      }
      if (ds < -2 || ds > 18) continue;
      const blend = ss((18 - ds) / 10), half = sampleTrack(o.s, 0).half;
      if (o.type === 'sliding' || o.type === 'wall') {
        const m = barMotion(o, arrival), target = m.r >= 0 ? -half + 0.65 : half - 0.65;
        hint.r = mix(hint.r, target, blend);
      } else if (o.type === 'hammer' || (o.type === 'rollball' && o.mode === 'across')) {
        // Plan a lane: the head must stay > 1.4 m from the lane for the whole time the ball is
        // within 1 m of the pivot; the lane must be reachable in time. Brake if no lane works.
        const lanes = [-half + 0.65, 0, half - 0.65].sort((x, y) => Math.abs(x - state.r) - Math.abs(y - state.r));
        const clear = (lane, v) => {
          for (let k = -1.2; k <= 1.2; k += 0.2) {
            const tt = state.simTime + Math.max(0, ds + k) / Math.max(v, 2);
            const or = o.type === 'hammer' ? hammerMotion(o, tt).r : acrossMotion(o, tt).r;
            if (Math.abs(or - lane) < (o.type === 'hammer' ? 1.4 : o.diameter / 2 + 0.75)) return false;
          }
          return true;
        };
        const reach = (lane, v) => Math.abs(lane - state.r) / (C.LAT_MAX * 0.75) + 0.15 <= Math.max(0, ds - 1) / Math.max(v, 2);
        let pick = null;
        for (const v of [speed, speed * 0.8, speed * 0.6, speed * 0.4]) {
          pick = lanes.find(l => (reach(l, v) || Math.abs(l - state.r) < 0.3) && clear(l, v));
          if (pick != null) { if (v < speed - 0.5 && ds < 12) { hint.throttle = 0; hint.brakeTo = v; } break; }
        }
        if (pick == null) pick = lanes[0];
        hint.r = mix(hint.r, pick, ds < 12 ? 1 : blend);
      } else if (o.type === 'rollball') {
        const target = o.r >= 0 ? -half + 0.6 : half - 0.6;
        hint.r = mix(hint.r, target, blend);
      } else if (o.type === 'side' && !o.used) {
        hint.r = mix(hint.r, o.baseR, blend);
      }
    }
    if (nearestBar) {
      const time = state.simTime + Math.max(0, nearestBar.s - s) / speed;
      hint.r = barMotion(nearestBar, time).r;
    }
    return hint;
  }

  function clearInput() {
    const old = pointer; pointer = null; keys.clear();
    drag.nx = drag.ny = 0; drag.active = false;
    if (old !== null && renderer && renderer.domElement.hasPointerCapture(old))
      renderer.domElement.releasePointerCapture(old);
  }
  function deadzone(v) { return Math.abs(v) <= 0.08 ? 0 : Math.sign(v) * (Math.abs(v) - 0.08) / 0.92; }
  function controls() {
    const has = (...k) => k.some(v => keys.has(v)) ? 1 : 0;
    return {
      nx: state.simTime < grace ? 0 : clamp(drag.nx + has('d', 'arrowright') - has('a', 'arrowleft'), -1, 1),
      ny: state.simTime < grace ? 0 : clamp(drag.ny + has('w', 'arrowup') - has('s', 'arrowdown'), -1, 1)
    };
  }
  function syncWorld(old, dt) {
    const w = worldAt(state.s, state.r, 0);
    state.ball.x = w.x; state.ball.z = w.z;
    state.ball.vy = state.vy;
    if (old && dt) {
      state.ball.vx = (w.x - old.x) / dt; state.ball.vz = (w.z - old.z) / dt;
    } else {
      const f = frameAt(state.s);
      state.ball.vx = Math.sin(f.a) * state.vs - Math.cos(f.a) * state.vr;
      state.ball.vz = Math.cos(f.a) * state.vs + Math.sin(f.a) * state.vr;
    }
    state.h = state.ball.y - C.BALL_R - sampleTrack(state.s, state.r).y;
    ball.position.set(state.ball.x, state.ball.y, state.ball.z);
  }
  function placeBall(s, r, vs = 0, vr = 0) {
    Object.assign(state, { s, r, vs, vr, vb: 0, vy: 0, h: 0, grounded: true, onBar: -1 });
    state.ball.y = sampleTrack(s, r).y + C.BALL_R;
    angular.set(0, 0, 0); ball.quaternion.identity(); syncWorld(); snapCamera();
  }
  function resetBall(s, r) {
    boost = -1; sideTime = 0; knockUntil = -1;
    obstacles.forEach(o => { o.used = false; o.cooldown = -1; });
    placeBall(s, r); clearInput(); grace = state.simTime + C.INPUT_GRACE;
  }
  function beginFall() {
    if (state.status !== 'playing') return;
    state.status = 'falling'; state.grounded = false;
    state.fallAt = state.simTime; state.respawnAt = state.fallAt + C.RESPAWN_S;
    state.fallenCount++; frozen.copy(camera.position);
  }
  function respawn() {
    const cp = checkpoints[state.checkpointIndex];
    state.status = 'respawning'; resetBall(cp ? cp.s : 0, 0); state.status = 'playing';
  }
  function completeLevel() {
    if (state.status === 'complete') return;
    state.status = 'complete'; state.progress = 1; clearInput();
    burst(ball.position, null, 40, 0, 'confetti');
    $('coins-collected').textContent = 'Coins: ' + state.coins;
    $('level-complete').style.display = 'block';
    const flash = document.createElement('div');
    flash.style.cssText = 'position:absolute;inset:0;background:white;pointer-events:none;opacity:.7;transition:opacity .3s;z-index:19';
    $('game').appendChild(flash);
    requestAnimationFrame(() => { flash.style.opacity = '0'; });
    setTimeout(() => flash.remove(), 350);
  }
  function guards() {
    const t = sampleTrack(state.s, state.r), bottom = state.ball.y - C.BALL_R;
    if (bottom > t.y + C.GUARD_HEIGHT || bottom < t.y - 0.5) return;
    for (const sign of [-1, 1]) {
      const side = sign > 0 ? 'right' : 'left';
      if (t.guard !== 'both' && t.guard !== side) continue;
      const distance = (state.r - t.center) * sign;
      if (distance + C.BALL_R <= t.half || distance - C.BALL_R > t.half + 0.2) continue;
      state.r = t.center + sign * Math.max(0, t.half - C.BALL_R);
      if (state.vb * sign > 0) state.vb = 0;
      if (state.vr * sign > 0) {
        if (state.vr * sign > 1) state.vs *= 0.97;
        state.vr *= -C.RAIL_RESTITUTION;
      }
    }
  }
  function spin(dx, dy, dz, grounded, dt) {
    if (grounded) {
      const h = Math.hypot(dx, dz);
      if (h < 1e-9) { angular.set(0, 0, 0); return; }
      axis.set(dz, 0, -dx).normalize();
      const angle = Math.hypot(dx, dy, dz) / C.BALL_R;
      quat.setFromAxisAngle(axis, angle); ball.quaternion.premultiply(quat).normalize();
      angular.copy(axis).multiplyScalar(angle / dt);
    } else {
      const speed = angular.length(), decay = Math.exp(-0.5 * dt);
      if (speed > 1e-8) {
        axis.copy(angular).divideScalar(speed);
        quat.setFromAxisAngle(axis, speed * (1 - decay) / 0.5);
        ball.quaternion.premultiply(quat).normalize(); angular.multiplyScalar(decay);
      }
    }
  }

  function collide() {
    for (const o of obstacles) {
      if (o.dead || o.type === 'bar') continue;
      const ds = state.s - o.s, dr = state.r - o.r;
      if (Math.abs(ds) > o.d / 2 + C.BALL_R + 0.15) continue;
      if (['jump', 'speed', 'side'].includes(o.type)) {
        const inside = Math.abs(ds) < o.d / 2 + 0.06 && Math.abs(dr) < o.w / 2;
        if (!inside) { if (Math.abs(ds) > 2) o.used = false; continue; }
        if (o.used || !state.grounded) continue;
        o.used = true;
        if (o.type === 'jump') {
          state.vy = C.PAD_VY; state.grounded = false; state.ball.y += 0.002;
        } else if (o.type === 'speed') {
          state.vs = Math.max(state.vs, C.PAD_SPEED); boost = state.simTime + C.PAD_DURATION;
        } else {
          sideTime = C.SIDE_T; sideDir = o.dir || 1; state.vr = sideDir * 1.5 / C.SIDE_T;
        }
        continue;
      }
      const dy = state.ball.y - o.y;
      let lr = dr, ly = dy;
      if (o.type === 'hammer') {
        const c = Math.cos(o.theta), sn = Math.sin(o.theta);
        lr = c * dr + sn * dy;
        ly = -sn * dr + c * dy;
      }
      let hit;
      if (o.type === 'rollball') {
        hit = ds * ds + dr * dr + dy * dy <= (C.BALL_R + o.diameter / 2) ** 2;
      } else {
        const er = Math.max(0, Math.abs(lr) - o.w / 2);
        const ey = Math.max(0, Math.abs(ly) - o.h / 2);
        const es = Math.max(0, Math.abs(ds) - o.d / 2);
        hit = er * er + ey * ey + es * es <= C.BALL_R ** 2;
      }
      if (!hit) continue;
      if (o.type === 'candy') {
        o.dead = true; o.mesh.visible = false;
        burst(o.mesh.position, o.color, 7, 12);
        state.vs *= 0.97;
        continue;
      }
      if (o.type === 'hammer' || o.type === 'rollball') {
        if (state.simTime < o.cooldown) continue;
        o.cooldown = state.simTime + 0.35;
        const direction = o.type === 'hammer'
          ? (Math.abs(o.vr) > 0.1 ? Math.sign(o.vr) : Math.sign(dr) || 1)
          : Math.sign(dr) || (o.id % 2 ? 1 : -1);
        state.vr = direction * clamp(Math.abs(o.vr || o.speed) * 0.9, 4.6, 7.5);
        knockUntil = state.simTime + C.KNOCK_T; // steering can't cancel a knock straight away
        state.vs *= 0.85;
        if (o.type === 'rollball' && o.mode === 'down') {
          state.vs = Math.max(-2, Math.min(state.vs, 2));
          state.s = Math.min(state.s, o.s - o.diameter / 2 - C.BALL_R - 0.01);
        }
        state.vy = Math.max(state.vy, 0) + 2;
        state.grounded = false;
        state.ball.y += 0.015;
        const extent = o.type === 'rollball'
          ? Math.sqrt(Math.max(0, (C.BALL_R + o.diameter / 2) ** 2 - ds * ds - dy * dy))
          : o.w / 2 + C.BALL_R;
        state.r = o.r + direction * (extent + 0.015);
      } else {
        const pr = o.w / 2 + C.BALL_R - Math.abs(dr);
        const ps = o.d / 2 + C.BALL_R - Math.abs(ds);
        if (pr < ps) {
          const sign = Math.sign(dr) || 1;
          state.r = o.r + sign * (o.w / 2 + C.BALL_R + 0.005);
          if ((state.vr - o.vr) * sign < 0)
            state.vr = o.vr - 0.3 * (state.vr - o.vr);
        } else {
          const sign = Math.sign(ds) || -1;
          state.s = o.s + sign * (o.d / 2 + C.BALL_R + 0.005);
          if (state.vs * sign < 0) state.vs *= -0.2;
        }
      }
    }
  }

  function simulate(dt) {
    state.simTime += dt;
    updateProps(dt);
    const old = { ...state.ball }, oldS = state.s, oldR = state.r;
    if (state.status === 'falling' || state.status === 'respawning') {
      state.vy -= C.GRAVITY * dt;
      state.ball.x += state.ball.vx * dt;
      state.ball.z += state.ball.vz * dt;
      state.ball.y += state.vy * dt;
      state.ball.vy = state.vy;
      state.s += state.vs * dt; state.r += state.vr * dt;
      state.h = state.ball.y - C.BALL_R - sampleTrack(state.s, state.r).y;
      spin(0, 0, 0, false, dt);
      ball.position.set(state.ball.x, state.ball.y, state.ball.z);
      if (state.simTime + 1e-9 >= state.respawnAt) respawn();
      return;
    }
    if (state.status === 'complete') {
      state.vs *= Math.exp(-3 * dt); state.vr *= Math.exp(-3 * dt);
      state.s += state.vs * dt; state.r += state.vr * dt;
      const t = sampleTrack(state.s, state.r);
      if (t.over) state.ball.y = t.y + C.BALL_R;
      else { state.vy -= C.GRAVITY * dt; state.ball.y += state.vy * dt; }
      syncWorld(old, dt);
      spin(state.ball.x - old.x, state.ball.y - old.y, state.ball.z - old.z, t.over, dt);
      return;
    }
    const t0 = sampleTrack(state.s, state.r);
    let grounded = state.grounded && t0.over &&
      Math.abs(state.ball.y - C.BALL_R - t0.y) < 0.065;
    const input = controls();
    let carry = 0;
    if (grounded && t0.onBar >= 0) {
      const bar = obstacles.find(o => o.id === t0.onBar);
      if (bar) carry = bar.vr;
    }
    const shoving = sideTime > 1e-9;
    if (shoving) {
      state.vr = sideDir * 1.5 / C.SIDE_T;
    } else {
      const response = state.simTime < knockUntil ? 0.3 : grounded ? C.LAT_RESPONSE : C.AIR_RESPONSE;
      state.vr += (input.nx * C.LAT_MAX - state.vr) * (1 - Math.exp(-response * dt));
    }
    if (grounded) {
      // Half-pipe ride: outward v^2*kappa vs the bowl's slope; its own velocity so the
      // steering damping doesn't cancel it (the ball settles up the outer bank).
      state.vb += (state.vs * state.vs * t0.kappa - C.LAT_G * t0.surfaceSlopeLat) * dt;
      state.vb *= Math.exp(-C.BANK_DAMP * dt);
    } else state.vb *= Math.exp(-2 * dt);
    if (input.ny > 0 && state.vs < C.MAX_SPEED) {
      // Above cruise speed the motor contributes nothing; on steep climbs its
      // available drive falls with speed rather than cancelling gravity.
      const drive = grounded && t0.grade > 0
        ? clamp(1 - state.vs / C.MAX_SPEED, 0, 1) * (1 - clamp(t0.grade / 0.25, 0, 1) * C.UPHILL_DRIVE_CUT) : 1;
      state.vs = Math.min(C.MAX_SPEED, state.vs + C.ACCEL * input.ny * drive * dt);
    } else if (input.ny < 0 && state.vs > 0) {
      state.vs = Math.max(0, state.vs - C.BRAKE * -input.ny * dt);
    }
    const dragRate = grounded && t0.grade < -0.02
      ? C.DOWNHILL_DRAG : input.ny > 0 ? C.ROLL_DRAG : C.COAST_DRAG;
    state.vs *= Math.exp(-dragRate * dt);
    if (grounded) {
      state.vs -= C.SLOPE_G * t0.grade / Math.sqrt(1 + t0.grade * t0.grade) * dt;
      if (input.ny > 0.2) state.vs = Math.max(0, state.vs);
      if (t0.grade < 0 && state.simTime > boost)
        state.vs = Math.min(C.DOWNHILL_CAP, state.vs);
    }
    if (state.simTime > boost && state.vs > C.DOWNHILL_CAP)
      state.vs = C.DOWNHILL_CAP + (state.vs - C.DOWNHILL_CAP) * Math.exp(-dt / 0.45);
    if (state.simTime <= boost) state.vs = Math.min(C.PAD_SPEED, state.vs);

    const moveDt = shoving ? Math.min(dt, sideTime) : dt;
    state.s += state.vs * dt;
    state.r += state.vr * moveDt + (carry + state.vb) * dt;
    if (shoving) {
      sideTime = Math.max(0, sideTime - dt);
      if (sideTime <= 1e-9) state.vr = 0;
    }
    const previousBottom = old.y - C.BALL_R;
    const oldRate = grounded ? surfaceRate(oldS, oldR, state.vs, state.vr + carry) : state.vy;
    const t1 = sampleTrack(state.s, state.r);
    const newRate = surfaceRate(state.s, state.r, state.vs, state.vr + carry);
    const continuous = t0.pieceIndex === t1.pieceIndex ||
      Math.abs(t1.piece.y0 - (t0.yc + t0.grade * (state.s - oldS))) < 0.08;
    const convex = grounded && t1.over && continuous && oldRate > newRate + 0.5;
    if (grounded && t1.over && continuous && !convex) {
      state.ball.y = t1.y + C.BALL_R;
      state.vy = newRate;
    } else {
      if (grounded) state.vy = oldRate;
      state.vy -= C.GRAVITY * dt;
      state.ball.y += state.vy * dt;
      grounded = false;
      const bottom = state.ball.y - C.BALL_R;
      const rel = state.vy - newRate;
      if (t1.over && bottom <= t1.y + 0.001 && previousBottom >= t1.y - 0.2 && rel <= 0) {
        state.ball.y = t1.y + C.BALL_R;
        if (Math.abs(rel) > 6) {
          state.vy = newRate + Math.min(1.8, -rel * 0.12);
        } else {
          state.vy = newRate; grounded = true;
        }
      } else if (t1.over && previousBottom < t1.y - 0.2 &&
        state.ball.y + C.BALL_R > t1.y - 0.4 && bottom < t1.y) {
        if (t0.pieceIndex !== t1.pieceIndex) {
          state.s = t1.piece.s0 - C.BALL_R - 0.005;
          state.vs = -0.2 * Math.abs(state.vs);
        } else if (!t0.over) {
          state.r = oldR; state.vr *= -0.3;
        }
      }
    }
    state.grounded = grounded;
    state.onBar = grounded ? sampleTrack(state.s, state.r).onBar : -1;
    // Roll only the integrated displacement, never collision push-outs.
    const rolled = worldAt(state.s, state.r);
    const prior = worldAt(oldS, oldR);
    spin(rolled.x - prior.x, grounded ? state.ball.y - old.y : 0,
      rolled.z - prior.z, grounded, dt);
    guards();
    collide();
    guards();
    const support = sampleTrack(state.s, state.r);
    if (!support.over) state.grounded = false;
    syncWorld(old, dt);
    if (state.ball.y - C.BALL_R < support.y - 1.5 || state.ball.y < lowest - 12) {
      beginFall(); return;
    }
    for (const c of coins) {
      if (!c.collected && Math.hypot(state.ball.x - c.mesh.position.x,
        state.ball.y - c.mesh.position.y, state.ball.z - c.mesh.position.z) <= 0.75) {
        c.collected = true; c.mesh.visible = false; state.coins++;
      }
    }
    checkpoints.forEach((cp, i) => {
      if (!cp.passed && oldS < cp.s && state.s >= cp.s &&
        state.grounded && sampleTrack(cp.s, state.r).over) {
        cp.passed = true; state.checkpointIndex = i;
        cp.mesh.material.color.setHex(0x3EE6B0);
        cp.mesh.material.emissive.setHex(0x3EE6B0);
      }
    });
    if (oldS < finishS && state.s >= finishS && sampleTrack(finishS, state.r).over)
      completeLevel();
    if (state.status !== 'complete') state.progress = clamp(state.s / finishS, 0, 1);
  }
  function advance(dt) {
    if (test.paused) return;
    accumulator += Math.max(0, dt);
    while (accumulator + 1e-10 >= C.FIXED_DT) {
      simulate(C.FIXED_DT); accumulator -= C.FIXED_DT;
    }
    accumulator = Math.max(0, accumulator);
  }

  // VISUAL_GAPS v1 framing: the camera rides the track 8.5 m BEHIND the ball (so it follows curves
  // and pitches with slopes), 2.3 m above the ball, tilted ~2 deg down: horizon ~47% down the screen,
  // ball ~70% down and ~8.5% of the screen height.
  let camLead = 0;
  function cameraAim() {
    const lr = state.r * C.CAMERA_LATERAL;
    const p = worldAt(state.s + C.LOOK_AHEAD + camLead, lr, C.BALL_R + C.LOOK_HEIGHT - C.CAMERA_ABOVE);
    p.y += C.CAMERA_ABOVE - C.BALL_R; // keep the same tilt as the deck under the camera
    if (!state.grounded) {
      const surface = sampleTrack(state.s, state.r).y + C.BALL_R;
      p.y += Math.max(0, state.ball.y - surface) * 0.45;
    }
    return new THREE.Vector3(p.x, p.y, p.z);
  }
  function cameraSeat() {
    const sb = state.s - C.CAMERA_BEHIND + camLead;
    const w = worldAt(sb, state.r * C.CAMERA_LATERAL, C.BALL_R + C.CAMERA_ABOVE);
    if (!state.grounded) {
      const surface = sampleTrack(state.s, state.r).y + C.BALL_R;
      w.y += Math.max(0, state.ball.y - surface) * 0.6; // jumps: keep height and frame the landing
    }
    return temp.set(w.x, w.y, w.z);
  }
  function placePlanet() {
    if (!planet) return;
    const h = 320 * Math.tan(rad(camera.fov / 2)), w = h * camera.aspect;
    planet.position.set(-0.31 * w, 0.31 * h, -160);
    planet.scale.setScalar(h * 0.08 * Math.min(width, height) / height);
  }
  function snapCamera() {
    camLead = Math.max(0, state.vs) * C.CAMERA_TAU;
    camera.position.copy(cameraSeat());
    look.copy(cameraAim()); camera.fov = C.FOV;
    camera.lookAt(look); camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
    camYaw = frameAt(state.s).a;
    frozen.copy(camera.position); placePlanet();
  }
  function updateCamera(dt) {
    if (state.status === 'falling' || state.status === 'respawning') {
      // Hold still where the fall began and watch the ball drop.
      camera.position.copy(frozen);
      const distance = Math.hypot(state.ball.x - frozen.x, state.ball.z - frozen.z);
      look.set(state.ball.x, Math.max(state.ball.y, frozen.y - distance * Math.tan(rad(60))), state.ball.z);
    } else {
      // The 0.15 s follow trails a moving seat by v*tau; lead it by the same (eased) amount.
      camLead += (Math.max(0, state.vs) * C.CAMERA_TAU - camLead) * damp(dt, 0.3);
      camera.position.lerp(cameraSeat(), damp(dt, C.CAMERA_TAU));
      look.lerp(cameraAim(), damp(dt, C.CAMERA_TAU));
      camYaw = Math.atan2(look.x - camera.position.x, look.z - camera.position.z);
    }
    camera.lookAt(look);
    const fast = state.status === 'playing' && state.vs >= C.FAST_SPEED;
    camera.fov += ((fast ? C.FAST_FOV : C.FOV) - camera.fov) * damp(dt, C.FOV_TAU);
    camera.updateProjectionMatrix(); camera.updateMatrixWorld(true); placePlanet();
    hills.position.set(camera.position.x, camera.position.y, camera.position.z);
    keyLight.position.set(state.ball.x + 8, state.ball.y + 16, state.ball.z - 3);
    keyLight.target.position.set(state.ball.x, state.ball.y, state.ball.z);
    const streak = fast ? '1' : '0';
    if (streak !== lastStreak) {
      lastStreak = streak;
      document.querySelectorAll('.left-streak,.right-streak').forEach(el => { el.style.opacity = streak; });
    }
  }
  function hud() {
    $('coin-counter').textContent = 'Coins: ' + state.coins;
    $('progress-bar').style.width = (state.progress * 100).toFixed(1) + '%';
    $('progress-container').setAttribute('aria-valuenow', String(Math.round(state.progress * 100)));
  }
  function draw(dt) {
    ball.position.set(state.ball.x, state.ball.y, state.ball.z);
    updateCamera(dt); hud();
    if (test.render) renderer.render(scene, camera);
  }
  function projectPoint(x, y, z) {
    camera.updateMatrixWorld(true);
    temp.set(x, y, z).project(camera);
    const rect = renderer.domElement.getBoundingClientRect();
    return { sx: rect.left + (temp.x + 1) * rect.width / 2,
      sy: rect.top + (1 - temp.y) * rect.height / 2 };
  }
  function getPlanetScreen() {
    placePlanet(); camera.updateMatrixWorld(true);
    let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
    planet.traverse(o => {
      if (!o.isMesh) return;
      const a = o.geometry.attributes.position;
      for (let i = 0; i < a.count; i++) {
        const v = new THREE.Vector3().fromBufferAttribute(a, i).applyMatrix4(o.matrixWorld);
        const p = projectPoint(v.x, v.y, v.z);
        left = Math.min(left, p.sx); right = Math.max(right, p.sx);
        top = Math.min(top, p.sy); bottom = Math.max(bottom, p.sy);
      }
    });
    return { left, right, top, bottom };
  }
  function resize() {
    const r = $('game').getBoundingClientRect();
    width = Math.max(1, r.width); height = Math.max(1, r.height);
    camera.aspect = width / height; camera.updateProjectionMatrix();
    renderer.setSize(width, height); placePlanet();
  }
  function bindInput() {
    const el = renderer.domElement;
    $('game').addEventListener('pointerdown', e => {
      if (e.target.closest('#pause-button,#level-complete')) return;
      e.preventDefault();
      if (pointer !== null || test.paused || state.status === 'complete') return;
      clearInput();
      try { el.setPointerCapture(e.pointerId); } catch (_) { return; }
      pointer = e.pointerId; origin.x = e.clientX; origin.y = e.clientY; drag.active = true;
    }, { passive: false });
    el.addEventListener('pointermove', e => {
      if (e.pointerId !== pointer) return;
      e.preventDefault();
      // Joystick radius is a fixed share of the shorter screen side (no px floor/cap), so the
      // same drag (as a share of the screen) gives the same steer at every viewport (844x390 included).
      const radius = 0.16 * Math.max(1, Math.min(width, height));
      let dx = e.clientX - origin.x, dy = e.clientY - origin.y;
      const length = Math.hypot(dx, dy);
      if (length > radius) {
        origin.x = e.clientX - dx * radius / length;
        origin.y = e.clientY - dy * radius / length;
        dx = e.clientX - origin.x; dy = e.clientY - origin.y;
      }
      drag.nx = deadzone(clamp(dx / radius, -1, 1));
      drag.ny = deadzone(clamp(-dy / radius, -1, 1));
    }, { passive: false });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(name =>
      el.addEventListener(name, e => { if (pointer === e.pointerId) clearInput(); }));
    const accepted = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);
    window.addEventListener('keydown', e => {
      const k = e.key.toLowerCase();
      if (!accepted.has(k)) return;
      e.preventDefault(); if (!test.paused) keys.add(k);
    });
    window.addEventListener('keyup', e => {
      const k = e.key.toLowerCase(); if (accepted.has(k)) { e.preventDefault(); keys.delete(k); }
    });
    window.addEventListener('blur', () => { clearInput(); lastFrame = null; accumulator = 0; });
    document.addEventListener('visibilitychange', () => { clearInput(); lastFrame = null; accumulator = 0; });
    document.addEventListener('gesturestart', e => e.preventDefault(), { passive: false });
    window.addEventListener('resize', resize);
    $('pause-button').addEventListener('click', () => {
      test.paused = !test.paused; clearInput(); accumulator = 0; lastFrame = null;
      $('pause-button').classList.toggle('paused', test.paused);
      $('pause-button').setAttribute('aria-label', test.paused ? 'Resume' : 'Pause');
    });
    $('continue-button').addEventListener('click', () => startLevel(state.level % 10 + 1));
  }
  function buildSky() {
    const c = document.createElement('canvas'); c.width = 8; c.height = 512;
    const ctx = c.getContext('2d'), gradient = ctx.createLinearGradient(0, 0, 0, 512);
    // Horizon sits ~47% down the screen (VISUAL_GAPS 1): violet top, coral, orange band at the horizon.
    gradient.addColorStop(0, '#3A1D7A'); gradient.addColorStop(0.24, '#3A1D7A');
    gradient.addColorStop(0.40, '#FF6F7D'); gradient.addColorStop(0.48, '#FFB36B');
    gradient.addColorStop(1, '#2A145C'); ctx.fillStyle = gradient; ctx.fillRect(0, 0, 8, 512);
    scene.background = srgb(new THREE.CanvasTexture(c));
    hills = new THREE.Group(); scene.add(hills);
    const hc = document.createElement('canvas'); hc.width = 1; hc.height = 128;
    const hctx = hc.getContext('2d'), hg = hctx.createLinearGradient(0, 0, 0, 128);
    hg.addColorStop(0, 'rgba(255,255,255,1)'); hg.addColorStop(0.7, 'rgba(255,255,255,1)');
    hg.addColorStop(1, 'rgba(255,255,255,0)'); hctx.fillStyle = hg; hctx.fillRect(0, 0, 1, 128);
    const fade = new THREE.CanvasTexture(hc);
    for (let layer = 0; layer < 2; layer++) {
      const positions = [], uv = [], count = 96, radius = 260 + layer * 40; /* far silhouettes only: the track floats over the void (review Nov 9) */
      for (let i = 0; i < count; i++) {
        const a = i / count * Math.PI * 2, b = (i + 1) / count * Math.PI * 2;
        const ya = 9 + 6 * Math.sin(i * 0.8 + layer) + 3 * Math.cos(i * 1.7);
        const yb = 9 + 6 * Math.sin((i + 1) * 0.8 + layer) + 3 * Math.cos((i + 1) * 1.7);
        const vertices = [
          [Math.sin(a) * radius, -4, Math.cos(a) * radius, 0, 0],
          [Math.sin(b) * radius, -4, Math.cos(b) * radius, 1, 0],
          [Math.sin(b) * radius, yb, Math.cos(b) * radius, 1, 1],
          [Math.sin(a) * radius, -4, Math.cos(a) * radius, 0, 0],
          [Math.sin(b) * radius, yb, Math.cos(b) * radius, 1, 1],
          [Math.sin(a) * radius, ya, Math.cos(a) * radius, 0, 1]
        ];
        vertices.forEach(v => { positions.push(v[0], v[1], v[2]); uv.push(v[3], v[4]); });
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      hills.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({
        color: layer ? 0x5B2E9E : 0x7C3FC4, map: fade, transparent: true,
        side: THREE.DoubleSide, depthWrite: false, fog: false
      })));
    }
    planet = new THREE.Group(); camera.add(planet);
    sphere(0.53, mat(0xFFD08A, { emissive: 0xFFD08A, emissiveIntensity: 0.3, fog: false }), planet, 24);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.7, 1, 48),
      new THREE.MeshBasicMaterial({ color: 0xFF8FB1, transparent: true, opacity: 0.7,
        side: THREE.DoubleSide, depthWrite: false, fog: false }));
    ring.rotation.set(0.55, -0.18, -0.3); planet.add(ring);
  }
  function buildBall() {
    const c = document.createElement('canvas'); c.width = 256; c.height = 128;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#F4F2FF'; ctx.fillRect(0, 0, 256, 128);
    ctx.fillStyle = '#FF6F7D'; ctx.fillRect(0, 56, 256, 16);
    const g = new THREE.SphereGeometry(C.BALL_R, 32, 24); g.rotateZ(Math.PI / 6);
    ball = new THREE.Mesh(g, mat(0xFFFFFF, {
      map: srgb(new THREE.CanvasTexture(c)), roughness: 0.25, metalness: 0.05
    }));
    scene.add(ball);
  }
  function startLevel(n) {
    n = clamp(Math.floor(Number(n) || 1), 1, 10); build(levelDef(n), n);
  }
  function frame(time) {
    if (lastFrame === null) lastFrame = time;
    const dt = clamp((time - lastFrame) / 1000, 0, 0.1); lastFrame = time;
    if (!test.manual && !test.paused && !document.hidden) { advance(dt); draw(dt); }
    requestAnimationFrame(frame);
  }

  const test = {
    paused: false, render: true, manual: false,
    getState: () => ({ ...state, ball: { ...state.ball },
      speed: Math.hypot(state.vs, state.vr), pieceKind: sampleTrack(state.s, state.r).kind }),
    setDrag(nx, ny) {
      clearInput();
      drag.nx = deadzone(clamp(Number(nx) || 0, -1, 1));
      drag.ny = deadzone(clamp(Number(ny) || 0, -1, 1)); drag.active = true;
    },
    clearDrag: clearInput, getDrag: () => ({ ...drag }), startLevel,
    getLevelCount: () => 10,
    getLevelName: n => names[clamp(Math.floor(n) - 1, 0, 9)],
    getTrackLength: () => finishS, getTrackEnd: () => finishS,
    loadCustomLevel: def => build(def, 1),
    placeBall(s, r, vs, vr) { placeBall(s, r, vs, vr); grace = 0; knockUntil = -1; sideTime = 0; },
    setVelocity(vs, vr, vy = 0) {
      state.vs = Number(vs) || 0; state.vr = Number(vr) || 0; state.vy = Number(vy) || 0;
      if (state.vy > 0.5) state.grounded = false;
      syncWorld();
    },
    tick(dt) { dt = Math.max(0, Number(dt) || 0); advance(dt); draw(dt); },
    finishNow: completeLevel, getBotHint,
    getObstacles: () => obstacles.filter(o => !o.dead).map(o => ({
      id: o.id, type: o.type, s: o.s, r: o.r, y: o.y,
      w: o.w, d: o.d, h: o.h, vr: o.vr, vs: o.vs,
      extra: { period: o.period, phase: o.phase, theta: o.theta || 0,
        mode: o.mode, s0: o.s0, s1: o.s1, diameter: o.diameter, used: o.used,
        amp: o.amp, pieceIndex: o.pieceIndex, dir: o.dir }
    })),
    getTrackInfo(s, r = 0) {
      const t = sampleTrack(s, r); const result = { ...t }; delete result.piece; return result;
    },
    getPieces: () => pieces.map(p => ({ ...p,
      rails: p.rails ? p.rails.slice() : undefined,
      bars: p.bars ? p.bars.map(b => ({ ...b })) : undefined })),
    worldAt, getBallQuaternion: () => ball.quaternion.toArray(),
    projectBall: () => projectPoint(state.ball.x, state.ball.y, state.ball.z),
    projectPoint,
    getBallScreenSize() {
      const a = projectPoint(state.ball.x, state.ball.y + C.BALL_R, state.ball.z);
      const b = projectPoint(state.ball.x, state.ball.y - C.BALL_R, state.ball.z);
      return Math.hypot(a.sx - b.sx, a.sy - b.sy);
    },
    getCamera() {
      const dx = look.x - camera.position.x, dy = look.y - camera.position.y;
      const dz = look.z - camera.position.z;
      return { x: camera.position.x, y: camera.position.y, z: camera.position.z,
        fov: camera.fov, yaw: Math.atan2(dx, dz),
        pitch: Math.atan2(dy, Math.hypot(dx, dz)),
        lookX: look.x, lookY: look.y, lookZ: look.z };
    },
    getConfig: () => ({ ...C }), getPlanetScreen,
    getScene: () => scene, getDebrisCount: () => debris.length,
    // Screen y (0..1 from top) of the true horizon: a far point level with the camera, straight ahead.
    getHorizon() {
      const dx = look.x - camera.position.x, dz = look.z - camera.position.z, l = Math.hypot(dx, dz) || 1;
      const p = projectPoint(camera.position.x + dx / l * 5000, camera.position.y, camera.position.z + dz / l * 5000);
      return p.sy / Math.max(1, height);
    },
    // Share of screen width the track deck fills at the bottom screen edge (searches back from the ball).
    getNearTrackWidth() {
      for (let s = state.s; s > state.s - 30; s -= 0.05) {
        const t = sampleTrack(s, 0), c = worldAt(s, 0, 0), pc = projectPoint(c.x, c.y, c.z);
        if (pc.sy >= height) {
          const a = worldAt(s, t.center - t.half, 0), b = worldAt(s, t.center + t.half, 0);
          return { s, frac: Math.abs(projectPoint(b.x, b.y, b.z).sx - projectPoint(a.x, a.y, a.z).sx) / Math.max(1, width) };
        }
      }
      return null;
    }
  };
  window.__test = test;

  function init() {
    scene = new THREE.Scene(); scene.fog = new THREE.Fog(0x2A145C, 45, 160);
    camera = new THREE.PerspectiveCamera(C.FOV, 1, 0.1, 450); scene.add(camera);
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    if ('outputColorSpace' in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;
    else renderer.outputEncoding = THREE.sRGBEncoding;
    $('game').appendChild(renderer.domElement);
    keyLight = new THREE.DirectionalLight(0xFFE2C4, 1.55);
    scene.add(keyLight); scene.add(keyLight.target);
    const fill = new THREE.DirectionalLight(0x8E7CFF, 0.62);
    fill.position.set(-8, 7, -1); scene.add(fill);
    scene.add(new THREE.AmbientLight(0xB8B0E8, 0.55));
    scene.add(new THREE.HemisphereLight(0xFFB36B, 0x2A145C, 0.4));
    buildSky(); buildBall(); bindInput(); resize(); startLevel(1); draw(0);
    requestAnimationFrame(frame);
  }
  if (document.readyState === 'complete') init();
  else window.addEventListener('load', init, { once: true });
})();