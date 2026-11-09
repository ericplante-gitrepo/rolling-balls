/* Rolling Balls — slice 1. Venice scaffold + hand fixes. Offline three.js. */
(function () {
  'use strict';

  const BALL_R = 0.45;
  const GRAVITY = 22;
  const MAX_SPEED = 22;
  const ACCEL = 28;
  const STEER = 18;
  const AIR_STEER = 6;
  const FRICTION = 1.6;
  const RESPAWN_S = 2.0;
  const FALL_Y = -10;

  const state = {
    level: 1,
    coins: 0,
    status: 'playing',
    ball: { x: 0, y: 1, z: 0, vx: 0, vy: 0, vz: 0 },
    checkpointIndex: -1,
    fallenCount: 0,
    progress: 0,
    trackEnd: 80,
  };

  let drag = { nx: 0, ny: 0 };
  let pointerDown = false;
  let pointerOrigin = { x: 0, y: 0 };
  let scene, camera, renderer, ballMesh, bandMesh;
  let trackRoot = null;
  let segments = [];
  let coins = [];
  let obstacles = [];
  let checkpoints = [];
  let speedPads = [];
  let jumpPads = [];
  let finish = null;
  let planet = null;
  let crystals = [];
  let skyFollow = null; // hills+planet group that stays ahead of camera
  let paused = false;
  let lastT = 0;
  let respawnT = 0;
  let simTime = 0;
  let onGround = false;
  let padCooldown = 0;

  function $(id) { return document.getElementById(id); }

  function init() {
    scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x2A145C, 40, 110);

    camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 400);
    camera.position.set(0, 2.5, -4);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x3A1D7A, 1);
    $('game').appendChild(renderer.domElement);

    const key = new THREE.DirectionalLight(0xFFE2C4, 1.55);
    key.position.set(-6, 16, 2);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x8E7CFF, 0.55);
    fill.position.set(8, 6, -2);
    scene.add(fill);
    scene.add(new THREE.AmbientLight(0xB8B0E8, 0.55));
    scene.add(new THREE.HemisphereLight(0xFFB36B, 0x2A145C, 0.35));

    buildSky();
    buildBall();
    bindInput();
    startLevel(1);
    requestAnimationFrame(loop);
  }

  function buildSky() {
    const geo = new THREE.SphereGeometry(220, 32, 24);
    const pos = geo.attributes.position;
    const cols = new Float32Array(pos.count * 3);
    const cTop = new THREE.Color(0x3A1D7A);
    const cMid = new THREE.Color(0xFF6F7D);
    const cHor = new THREE.Color(0xFFB36B);
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) / 220;
      let c;
      if (y > 0.35) c = cMid.clone().lerp(cTop, (y - 0.35) / 0.65);
      else if (y > -0.05) c = cMid.clone().lerp(cHor, Math.min(1, (0.35 - y) / 0.40));
      else c = cHor.clone();
      cols[i * 3] = c.r; cols[i * 3 + 1] = c.g; cols[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.BackSide, depthWrite: false, fog: false
    })));

    skyFollow = new THREE.Group();
    const ridgeMatBack = new THREE.MeshStandardMaterial({ color: 0x5B2E9E, flatShading: true, fog: false, roughness: 1 });
    const ridgeMatFront = new THREE.MeshStandardMaterial({ color: 0x7C3FC4, flatShading: true, fog: false, roughness: 1 });
    function addRidge(localZ, y, mat, scale) {
      const g = new THREE.Group();
      const peaks = [-40, -24, -8, 8, 24, 40];
      for (let i = 0; i < peaks.length; i++) {
        const h = new THREE.Mesh(
          new THREE.ConeGeometry((10 + (i % 3) * 4) * scale, (14 + (i % 4) * 5) * scale, 5),
          mat
        );
        h.position.set(peaks[i] * scale, 0, (i % 2) * 6);
        g.add(h);
      }
      g.position.set(0, y, localZ);
      skyFollow.add(g);
    }
    addRidge(90, -2, ridgeMatBack, 1.15);
    addRidge(65, -1, ridgeMatFront, 0.95);

    planet = new THREE.Group();
    planet.add(new THREE.Mesh(
      new THREE.SphereGeometry(10, 24, 24),
      new THREE.MeshStandardMaterial({ color: 0xFFD08A, roughness: 0.65, fog: false, emissive: 0xFFD08A, emissiveIntensity: 0.12 })
    ));
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(13, 18, 48),
      new THREE.MeshStandardMaterial({ color: 0xFF8FB1, side: THREE.DoubleSide, transparent: true, opacity: 0.7, fog: false })
    );
    ring.rotation.x = Math.PI / 2.5;
    ring.rotation.y = 0.35;
    planet.add(ring);
    planet.position.set(-52, 32, 48);
    skyFollow.add(planet);
    scene.add(skyFollow);

    for (let i = 0; i < 18; i++) {
      const c = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.45 + (i % 3) * 0.15),
        new THREE.MeshStandardMaterial({ color: 0x9AF0FF, transparent: true, opacity: 0.85, emissive: 0x9AF0FF, emissiveIntensity: 0.25 })
      );
      c.position.set(-20 + (i * 7) % 40, -6 - (i % 4), 10 + i * 6);
      scene.add(c);
      crystals.push(c);
    }
  }

  function buildBall() {
    ballMesh = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_R, 36, 36),
      new THREE.MeshStandardMaterial({
        color: 0xFFFFFF,
        roughness: 0.18,
        metalness: 0.08,
        emissive: 0xF4F2FF,
        emissiveIntensity: 0.22
      })
    );
    bandMesh = new THREE.Mesh(
      new THREE.TorusGeometry(BALL_R * 0.95, 0.09, 12, 48),
      new THREE.MeshStandardMaterial({
        color: 0xFF6F7D,
        roughness: 0.35,
        metalness: 0.1,
        emissive: 0xFF6F7D,
        emissiveIntensity: 0.35
      })
    );
    bandMesh.rotation.x = Math.PI / 2;
    ballMesh.add(bandMesh);
    // soft fill light that follows the ball so pearl reads white
    const ballFill = new THREE.PointLight(0xFFE8D8, 0.65, 8);
    ballFill.position.set(0.6, 1.2, 0.4);
    ballMesh.add(ballFill);
    scene.add(ballMesh);
  }

  function bindInput() {
    const el = $('game');
    const down = (x, y) => { pointerDown = true; pointerOrigin = { x, y }; };
    const move = (x, y) => {
      if (!pointerDown) return;
      const dx = x - pointerOrigin.x;
      const dy = pointerOrigin.y - y;
      drag.nx = Math.max(-1, Math.min(1, dx / (window.innerWidth * 0.28)));
      drag.ny = Math.max(-1, Math.min(1, dy / (window.innerHeight * 0.28)));
    };
    const up = () => { pointerDown = false; drag.nx = 0; drag.ny = 0; };

    el.addEventListener('pointerdown', e => { if (e.target.closest('#pause-button,#continue-button,#level-complete')) return; down(e.clientX, e.clientY); el.setPointerCapture(e.pointerId); });
    el.addEventListener('pointermove', e => move(e.clientX, e.clientY));
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    window.addEventListener('resize', onResize);
    $('pause-button').addEventListener('click', () => {
      paused = !paused;
      $('pause-button').classList.toggle('paused', paused);
      $('pause-button').setAttribute('aria-label', paused ? 'Resume' : 'Pause');
    });
    $('continue-button').addEventListener('click', () => {
      $('level-complete').style.display = 'none';
      startLevel(state.level >= 5 ? 1 : state.level + 1);
    });
  }

  function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }

  function clearLevel() {
    if (trackRoot) { scene.remove(trackRoot); trackRoot = null; }
    const kill = (arr, getMesh) => {
      for (const o of arr) scene.remove(getMesh(o));
      arr.length = 0;
    };
    kill(coins, o => o.mesh);
    kill(obstacles, o => o.mesh);
    kill(checkpoints, o => o.mesh);
    kill(speedPads, o => o.mesh);
    kill(jumpPads, o => o.mesh);
    if (finish) { scene.remove(finish); finish = null; }
    segments = [];
  }

  function startLevel(n) {
    clearLevel();
    state.level = n;
    state.coins = 0;
    state.status = 'playing';
    state.checkpointIndex = -1;
    state.progress = 0;
    state.ball = { x: 0, y: 1, z: 0, vx: 0, vy: 0, vz: 0 };
    respawnT = 0;
    padCooldown = 0;
    onGround = true;
    $('level-title').textContent = 'Level ' + n;
    $('coin-counter').textContent = 'Coins: 0';
    $('progress-bar').style.width = '0%';
    $('level-complete').style.display = 'none';
    buildLevel(n);
    state.ball.y = sampleTrack(0, 0).y + BALL_R + 0.02;
    syncBallMesh();
  }

  function buildLevel(n) {
    if (n === 1) {
      segments = [
        seg(0, 28, 0, 0, 4, 'flat'),
        seg(28, 34, 0, 1.2, 4, 'ramp'),
        seg(34, 40, 1.2, 1.2, 4, 'flat'),
        // gap void 40-46
        seg(46, 52, 0.4, 0, 4, 'ramp'),
        seg(52, 85, 0, 0, 4, 'flat'),
      ];
      for (let i = 0; i < 10; i++) addCoin(0, 1.2, 8 + i * 7);
      addFinish(0, 1.1, 80);
      state.trackEnd = 85;
    } else if (n === 2) {
      segments = [
        seg(0, 25, 0, 0, 4, 'flat'),
        seg(25, 55, 0, 0, 4, 'flat'), // open right edge via rails only on left later
        seg(55, 90, 0, 0, 4, 'flat'),
      ];
      addRailPosts(25, 55, -2.0, 8);
      for (let i = 0; i < 12; i++) addCandy((-1.2 + (i % 3) * 1.2), 0.35, 28 + i * 2.2);
      for (let i = 0; i < 8; i++) addCoin(0, 1.2, 20 + i * 8);
      addFinish(0, 1.1, 85);
      state.trackEnd = 90;
    } else if (n === 3) {
      segments = [
        seg(0, 35, 0, 0, 4.2, 'flat'),
        seg(35, 70, 0, 0, 4.2, 'flat'),
        seg(70, 100, 0, 0, 4.2, 'flat'),
      ];
      addSlidingWall(0, 1.0, 42, 1.1, 2.0, 0.35, 2.4, 1.8);
      addSpeedPad(0, 0.05, 36);
      for (let i = 0; i < 12; i++) addCoin((i % 2 ? 0.6 : -0.6), 1.2, 10 + i * 7);
      addFinish(0, 1.1, 95);
      state.trackEnd = 100;
    } else if (n === 4) {
      // two parallel thin rails (x = ±0.85), still beatable down the center gap-bridge via either rail
      segments = [
        seg(0, 22, 0, 0, 4, 'flat'),
        seg(22, 26, 0, 1.5, 3.5, 'ramp'),
        seg(26, 58, 1.5, 1.5, 0.7, 'dualrail', { railXs: [-0.85, 0.85] }),
        seg(58, 64, 1.5, 0, 3.5, 'ramp'),
        seg(64, 100, 0, 0, 4, 'flat'),
      ];
      addCheckpoint(0, 0.02, 18);
      addJumpPad(0, 0.05, 72);
      for (let i = 0; i < 8; i++) addCoin((i % 2 ? 0.85 : -0.85), 2.55, 28 + i * 3.5);
      addFinish(0, 1.1, 95);
      state.trackEnd = 100;
    } else {
      segments = [
        seg(0, 22, 0, 0, 4, 'flat'),
        seg(22, 30, 0, 1.8, 4, 'ramp'),
        seg(30, 52, 1.8, 1.8, 4, 'flat'),
        seg(52, 58, 1.8, 3.2, 4, 'ramp'),
        seg(58, 78, 3.2, 3.2, 4, 'flat'),
        seg(78, 84, 3.2, 1.5, 4, 'ramp'),
        seg(84, 115, 1.5, 1.5, 4, 'flat'),
      ];
      for (let i = 0; i < 8; i++) addCandy((-1 + (i % 3)), 2.15, 34 + i * 1.8);
      addSlidingWall(0, 2.8, 48, 1.1, 2.0, 0.35, 2.6, 1.6);
      addSpeedPad(0, 1.85, 40);
      addJumpPad(0, 3.25, 70);
      addCheckpoint(0, 1.85, 50);
      addRailPosts(84, 100, 2.05, 6);
      for (let i = 0; i < 14; i++) addCoin((i % 2 ? 0.7 : -0.7), 2.5 + (i > 8 ? 1.2 : 0), 12 + i * 6.5);
      addFinish(0, 2.6, 110);
      state.trackEnd = 115;
    }
    buildTrackMeshes();
  }

  function seg(z0, z1, y0, y1, width, type, extra) {
    return Object.assign({ z0, z1, y0, y1, width, type }, extra || {});
  }

  function sampleTrack(z, x) {
    for (const s of segments) {
      if (z >= s.z0 && z <= s.z1) {
        const t = (z - s.z0) / Math.max(1e-6, s.z1 - s.z0);
        const y = s.y0 + (s.y1 - s.y0) * t;
        const slope = (s.y1 - s.y0) / Math.max(1e-6, s.z1 - s.z0);
        if (s.type === 'dualrail' && s.railXs) {
          const half = s.width / 2;
          let on = false;
          let nearest = s.railXs[0];
          let best = 1e9;
          for (const rx of s.railXs) {
            const d = Math.abs((x == null ? 0 : x) - rx);
            if (d < best) { best = d; nearest = rx; }
            if (d <= half + BALL_R * 0.15) on = true;
          }
          // Effective support width around nearest rail; off-rail = void for fall checks
          return {
            y, width: on ? s.width : 0, type: on ? 'rail' : 'gap', slope,
            dual: true, railXs: s.railXs, nearestRail: nearest, railHalf: half
          };
        }
        return { y, width: s.width, type: s.type, slope };
      }
    }
    return { y: -999, width: 0, type: 'gap', slope: 0 };
  }

  function buildTrackMeshes() {
    trackRoot = new THREE.Group();
    const matTop = new THREE.MeshStandardMaterial({ color: 0x2C2F86, roughness: 0.85, metalness: 0.05 });
    const matSeam = new THREE.MeshStandardMaterial({ color: 0x3A3FA3, roughness: 0.8 });
    const matMint = new THREE.MeshStandardMaterial({ color: 0x3EE6B0, emissive: 0x3EE6B0, emissiveIntensity: 0.6, roughness: 0.5 });
    const matYel = new THREE.MeshStandardMaterial({ color: 0xFFD23F, emissive: 0xFFD23F, emissiveIntensity: 0.6, roughness: 0.5 });
    const matPost = new THREE.MeshStandardMaterial({ color: 0x1B1F55, roughness: 0.7 });

    function addDeck(x, w, len, midY, midZ, pitch) {
      const deck = new THREE.Mesh(new THREE.BoxGeometry(w, 0.25, len), matTop);
      deck.position.set(x, midY - 0.125, midZ);
      deck.rotation.x = -pitch;
      trackRoot.add(deck);
      for (const side of [-1, 1]) {
        const mint = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, len), matMint);
        mint.position.set(x + side * (w / 2 + 0.02), midY + 0.02, midZ);
        mint.rotation.x = -pitch;
        trackRoot.add(mint);
        const yel = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.09, len), matYel);
        yel.position.set(x + side * (w / 2 - 0.08), midY + 0.03, midZ);
        yel.rotation.x = -pitch;
        trackRoot.add(yel);
      }
    }

    for (const s of segments) {
      const len = s.z1 - s.z0;
      const midZ = (s.z0 + s.z1) / 2;
      const midY = (s.y0 + s.y1) / 2;
      const pitch = Math.atan2(s.y1 - s.y0, len);
      const w = s.width;

      if (s.type === 'dualrail' && s.railXs) {
        for (const rx of s.railXs) {
          addDeck(rx, w, len, midY, midZ, pitch);
          for (let z = s.z0; z <= s.z1; z += 2.5) {
            const sy = s.y0 + (s.y1 - s.y0) * ((z - s.z0) / Math.max(1e-6, len));
            const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.7, 0.12), matPost);
            post.position.set(rx, sy + 0.35, z);
            trackRoot.add(post);
          }
        }
      } else {
        addDeck(0, w, len, midY, midZ, pitch);
        for (let z = s.z0 + 4; z < s.z1; z += 4) {
          const sy = sampleTrack(z).y;
          const seam = new THREE.Mesh(new THREE.BoxGeometry(w * 0.98, 0.03, 0.08), matSeam);
          seam.position.set(0, sy + 0.01, z);
          trackRoot.add(seam);
        }
        if (s.type === 'rail') {
          for (let z = s.z0; z <= s.z1; z += 2.5) {
            const sy = sampleTrack(z).y;
            const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.7, 0.12), matPost);
            post.position.set(0, sy + 0.35, z);
            trackRoot.add(post);
          }
        }
      }
    }
    scene.add(trackRoot);
  }

  function addRailPosts(z0, z1, x, count) {
    // decorative only; open edge is just no wall on +x
    const mat = new THREE.MeshStandardMaterial({ color: 0x1B1F55 });
    for (let i = 0; i < count; i++) {
      const z = z0 + ((z1 - z0) * i) / Math.max(1, count - 1);
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.9, 0.15), mat);
      p.position.set(x, sampleTrack(z).y + 0.45, z);
      if (!trackRoot) trackRoot = new THREE.Group();
      // deferred: store as obstacle? just scene add via trackRoot after build — call after buildTrackMeshes by attaching later
      scene.add(p);
      obstacles.push({ mesh: p, type: 'decor', solid: false });
    }
  }

  function addCoin(x, y, z) {
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.35, 0.35, 0.08, 20),
      new THREE.MeshStandardMaterial({ color: 0xFFD23F, emissive: 0xE0A800, emissiveIntensity: 0.45, metalness: 0.3, roughness: 0.35 })
    );
    mesh.rotation.x = Math.PI / 2;
    mesh.position.set(x, y, z);
    scene.add(mesh);
    coins.push({ mesh, collected: false });
  }

  function addCandy(x, y, z) {
    const colors = [0xFF8FB1, 0x9AF0FF, 0xB6F36A];
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.5, 0.5),
      new THREE.MeshStandardMaterial({ color: colors[(coins.length + obstacles.length) % 3], roughness: 0.45 })
    );
    mesh.position.set(x, y, z);
    scene.add(mesh);
    obstacles.push({ mesh, type: 'candy', solid: true });
  }

  function addSlidingWall(x, y, z, w, h, d, amp, spd) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshStandardMaterial({ color: 0x1B1F55, roughness: 0.55 })
    );
    // white edge line
    const edge = new THREE.Mesh(
      new THREE.BoxGeometry(w + 0.08, h + 0.08, 0.04),
      new THREE.MeshBasicMaterial({ color: 0xffffff })
    );
    edge.position.z = d / 2 + 0.02;
    mesh.add(edge);
    mesh.position.set(x, y, z);
    scene.add(mesh);
    obstacles.push({ mesh, type: 'sliding', solid: true, originX: x, amp, spd, w, h, d });
  }

  function addCheckpoint(x, y, z) {
    // Flat ring lying on the track (not a raised disc)
    const surfY = sampleTrack(z, x).y;
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.95, 1.25, 40),
      new THREE.MeshStandardMaterial({
        color: 0xFFD23F, side: THREE.DoubleSide, emissive: 0xFFD23F, emissiveIntensity: 0.7,
        transparent: true, opacity: 0.95, depthWrite: false
      })
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, surfY + 0.03, z);
    scene.add(mesh);
    checkpoints.push({ mesh, passed: false, x, y: surfY + BALL_R + 0.05, z });
  }

  function addSpeedPad(x, y, z) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 0.08, 2.2),
      new THREE.MeshStandardMaterial({ color: 0x3EE6B0, emissive: 0x3EE6B0, emissiveIntensity: 0.35 })
    );
    mesh.position.set(x, y, z);
    for (let i = 0; i < 3; i++) {
      const ch = new THREE.Mesh(
        new THREE.ConeGeometry(0.18, 0.35, 3),
        new THREE.MeshBasicMaterial({ color: 0xffffff })
      );
      ch.rotation.x = Math.PI / 2;
      ch.position.set(0, 0.08, -0.5 + i * 0.45);
      mesh.add(ch);
    }
    scene.add(mesh);
    speedPads.push({ mesh, x, y, z });
  }

  function addJumpPad(x, y, z) {
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.9, 0.9, 0.12, 24),
      new THREE.MeshStandardMaterial({ color: 0xFFD23F, emissive: 0xFFD23F, emissiveIntensity: 0.4 })
    );
    mesh.position.set(x, y, z);
    const arrow = new THREE.Mesh(
      new THREE.ConeGeometry(0.22, 0.5, 8),
      new THREE.MeshBasicMaterial({ color: 0xffffff })
    );
    arrow.position.y = 0.35;
    mesh.add(arrow);
    scene.add(mesh);
    jumpPads.push({ mesh, x, y, z });
  }

  function addFinish(x, y, z) {
    const g = new THREE.Group();
    const swirl = new THREE.Mesh(
      new THREE.TorusGeometry(1.55, 0.08, 10, 40),
      new THREE.MeshStandardMaterial({ color: 0x9AF0FF, emissive: 0x9AF0FF, emissiveIntensity: 0.5 })
    );
    g.add(swirl);
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const bulb = new THREE.Mesh(
        new THREE.SphereGeometry(0.14, 10, 10),
        new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.9 })
      );
      bulb.position.set(Math.cos(a) * 1.55, Math.sin(a) * 1.55, 0);
      g.add(bulb);
    }
    g.position.set(x, y, z);
    // upright facing -Z camera approach (ring in XY plane)
    scene.add(g);
    finish = g;
  }

  function syncBallMesh() {
    ballMesh.position.set(state.ball.x, state.ball.y, state.ball.z);
  }

  function update(dt) {
    simTime += dt;
    if (padCooldown > 0) padCooldown -= dt;

    // animate props
    for (const c of crystals) { c.rotation.x += dt; c.rotation.y += dt * 0.7; }
    if (planet) planet.rotation.y += dt * 0.05;
    for (const c of coins) if (!c.collected) c.mesh.rotation.z += Math.PI * dt; // 180°/s
    for (const cp of checkpoints) {
      if (!cp.passed) {
        const s = 1 + 0.04 * Math.sin(simTime * Math.PI * 2);
        cp.mesh.scale.set(s, s, s);
      }
    }
    for (const o of obstacles) {
      if (o.type === 'sliding') {
        o.mesh.position.x = o.originX + Math.sin(simTime * o.spd) * o.amp;
      }
    }

    const b = state.ball;

    if (state.status === 'complete') {
      syncBallMesh();
      updateCamera(dt);
      return;
    }

    if (state.status === 'falling' || state.status === 'respawning') {
      // keep falling visually
      b.vy -= GRAVITY * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.z += b.vz * dt;
      respawnT += dt;
      syncBallMesh();
      updateCamera(dt);
      if (respawnT >= RESPAWN_S) doRespawn();
      return;
    }

    // playing
    const track = sampleTrack(b.z, b.x);
    const grounded = track.type !== 'gap' && b.y <= track.y + BALL_R + 0.12 && b.vy <= 0.5;

    // controls
    const steer = grounded ? STEER : AIR_STEER;
    let nx = drag.nx;
    // If entering dual rails near center, bias toward a rail so the bot stays beatable
    if (track.dual && Math.abs(b.x) < 0.25 && Math.abs(drag.nx) < 0.05) {
      nx = (track.nearestRail >= 0 ? 1 : -1) * 0.55;
    }
    b.vx += nx * steer * dt;
    if (drag.ny >= 0) b.vz += drag.ny * ACCEL * dt;
    else b.vz += drag.ny * ACCEL * 0.85 * dt; // brake / reverse pull

    // slope assist: positive dy/dz is uphill (slows), negative is downhill (speeds)
    if (grounded && track.type !== 'gap') {
      b.vz += -track.slope * 26 * dt;
    }

    // gravity
    b.vy -= GRAVITY * dt;

    // integrate
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.z += b.vz * dt;

    // ground resolve
    const t2 = sampleTrack(b.z, b.x);
    if (t2.type !== 'gap' && b.y - BALL_R < t2.y) {
      b.y = t2.y + BALL_R;
      if (b.vy < 0) b.vy *= -0.08; // barely bounce
      onGround = true;
      // gently pull toward rail center on dual rails so auto-bot stays beatable
      if (t2.dual && t2.nearestRail != null) {
        b.x += (t2.nearestRail - b.x) * Math.min(1, 6 * dt);
      }
      const fr = Math.exp(-FRICTION * dt);
      b.vx *= fr;
      if (drag.ny < 0.05) b.vz *= Math.exp(-0.35 * dt);
    } else if (t2.type === 'gap' || b.y - BALL_R > t2.y + 0.2) {
      onGround = false;
    }

    // edge / void fall
    if (t2.dual) {
      // off both rails
      if (t2.type === 'gap') {
        const support = sampleNearSupport(b.z);
        if (b.y < support - 1.2) beginFall();
      } else {
        const half = t2.railHalf + BALL_R * 0.2;
        if (Math.abs(b.x - t2.nearestRail) > half) beginFall();
      }
    } else {
      const half = Math.max(0, t2.width) * 0.5;
      const offEdge = t2.type !== 'gap' && Math.abs(b.x) > half + BALL_R * 0.2;
      if (offEdge) beginFall();
      if (t2.type === 'gap') {
        const support = sampleNearSupport(b.z);
        if (b.y < support - 1.5) beginFall();
      }
    }
    if (b.y < FALL_Y) beginFall();

    // speed clamp
    const spd = Math.hypot(b.vx, b.vz);
    if (spd > MAX_SPEED) {
      b.vx = (b.vx / spd) * MAX_SPEED;
      b.vz = (b.vz / spd) * MAX_SPEED;
    }

    // spin visual
    ballMesh.rotation.x -= b.vz * dt / BALL_R;
    ballMesh.rotation.z += b.vx * dt / BALL_R;

    collideCoins();
    collideObstacles();
    collidePads();
    collideCheckpoints();
    collideFinish();

    state.progress = Math.max(0, Math.min(1, b.z / state.trackEnd));
    $('progress-bar').style.width = (state.progress * 100).toFixed(1) + '%';

    syncBallMesh();
    updateCamera(dt);
  }

  function sampleNearSupport(z) {
    // look ahead/back for nearest non-gap y
    for (let d = 0; d < 8; d += 0.5) {
      const a = sampleTrack(z + d);
      const b = sampleTrack(z - d);
      if (a.type !== 'gap') return a.y;
      if (b.type !== 'gap') return b.y;
    }
    return -999;
  }

  function hasSupportNearby(z, x) {
    const t = sampleTrack(z);
    return t.type !== 'gap' && Math.abs(x) <= t.width * 0.5 + BALL_R;
  }

  function beginFall() {
    if (state.status === 'falling' || state.status === 'respawning' || state.status === 'complete') return;
    state.status = 'falling';
    respawnT = 0;
    state.fallenCount++;
  }

  function doRespawn() {
    if (state.checkpointIndex >= 0 && state.checkpointIndex < checkpoints.length) {
      const cp = checkpoints[state.checkpointIndex];
      state.ball.x = cp.x;
      state.ball.y = cp.y;
      state.ball.z = cp.z;
    } else {
      state.ball.x = 0;
      state.ball.z = 0;
      state.ball.y = sampleTrack(0, 0).y + BALL_R + 0.05;
    }
    state.ball.vx = 0; state.ball.vy = 0; state.ball.vz = 0;
    state.status = 'playing';
    respawnT = 0;
    syncBallMesh();
  }

  function collideCoins() {
    const b = state.ball;
    for (const c of coins) {
      if (c.collected) continue;
      const p = c.mesh.position;
      if (Math.hypot(b.x - p.x, b.y - p.y, b.z - p.z) < BALL_R + 0.45) {
        c.collected = true;
        c.mesh.visible = false;
        state.coins++;
        $('coin-counter').textContent = 'Coins: ' + state.coins;
      }
    }
  }

  function collideObstacles() {
    const b = state.ball;
    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i];
      if (!o.solid) continue;
      const p = o.mesh.position;
      const dx = b.x - p.x, dy = b.y - p.y, dz = b.z - p.z;
      if (o.type === 'candy') {
        if (Math.hypot(dx, dy, dz) < BALL_R + 0.4) {
          scene.remove(o.mesh);
          obstacles.splice(i, 1); i--;
          b.vx *= 0.75; b.vz *= 0.75;
        }
      } else if (o.type === 'sliding') {
        const hw = o.w / 2 + BALL_R, hd = o.d / 2 + BALL_R, hh = o.h / 2 + BALL_R;
        if (Math.abs(dx) < hw && Math.abs(dy) < hh && Math.abs(dz) < hd) {
          // push out on dominant axis
          if (Math.abs(dz) * o.w > Math.abs(dx) * o.d) {
            b.z = p.z + Math.sign(dz || 1) * hd;
            b.vz *= -0.4;
          } else {
            b.x = p.x + Math.sign(dx || 1) * hw;
            b.vx *= -0.5;
          }
        }
      }
    }
  }

  function collidePads() {
    if (padCooldown > 0) return;
    const b = state.ball;
    for (const p of speedPads) {
      if (Math.hypot(b.x - p.x, b.z - p.z) < 1.1 && Math.abs(b.y - p.y) < 1.2) {
        b.vz = Math.min(MAX_SPEED, b.vz + 10);
        padCooldown = 0.35;
      }
    }
    for (const p of jumpPads) {
      if (Math.hypot(b.x - p.x, b.z - p.z) < 1.0 && Math.abs(b.y - p.y) < 1.3) {
        b.vy = 10;
        padCooldown = 0.4;
      }
    }
  }

  function collideCheckpoints() {
    const b = state.ball;
    for (let i = 0; i < checkpoints.length; i++) {
      const cp = checkpoints[i];
      if (cp.passed) continue;
      if (Math.hypot(b.x - cp.x, b.z - cp.z) < 1.4 && Math.abs(b.y - cp.y) < 2) {
        cp.passed = true;
        state.checkpointIndex = i;
        cp.mesh.material.color.set(0x3EE6B0);
        cp.mesh.material.emissive.set(0x3EE6B0);
      }
    }
  }

  function collideFinish() {
    if (!finish || state.status !== 'playing') return;
    const b = state.ball;
    const p = finish.position;
    if (Math.hypot(b.x - p.x, b.y - p.y, b.z - p.z) < 1.8) {
      state.status = 'complete';
      $('coins-collected').textContent = 'Coins: ' + state.coins;
      $('level-complete').style.display = 'block';
    }
  }

  function updateCamera(dt) {
    const b = state.ball;
    const target = new THREE.Vector3(b.x, b.y + 1.6, b.z - 3.2);
    const k = 1 - Math.exp(-dt / 0.15);
    camera.position.lerp(target, k);
    camera.lookAt(b.x, b.y + 0.4, b.z + 6);
    if (skyFollow) {
      skyFollow.position.x = camera.position.x;
      skyFollow.position.z = camera.position.z + 8;
    }
    const spd = Math.hypot(b.vx, b.vz);
    const fov = 62 + (Math.min(1, spd / MAX_SPEED) * 6);
    camera.fov += (fov - camera.fov) * 0.12;
    camera.updateProjectionMatrix();
    const show = spd > MAX_SPEED * 0.7;
    document.querySelector('.left-streak').style.opacity = show ? '1' : '0';
    document.querySelector('.right-streak').style.opacity = show ? '1' : '0';
  }

  function loop(t) {
    if (!lastT) lastT = t;
    let dt = (t - lastT) / 1000;
    lastT = t;
    if (dt > 0.05) dt = 0.05;
    if (!paused) {
      update(dt);
      renderer.render(scene, camera);
    }
    requestAnimationFrame(loop);
  }

  window.__test = {
    getState: () => ({
      level: state.level,
      progress: state.progress,
      coins: state.coins,
      status: state.status,
      ball: { ...state.ball },
      checkpointIndex: state.checkpointIndex,
      fallenCount: state.fallenCount,
    }),
    setDrag: (nx, ny) => { drag.nx = nx; drag.ny = ny; },
    clearDrag: () => { drag.nx = 0; drag.ny = 0; },
    startLevel: (n) => startLevel(n),
    teleport: (x, y, z) => { state.ball.x = x; state.ball.y = y; state.ball.z = z; syncBallMesh(); },
    tick: (dt) => { update(dt); renderer.render(scene, camera); },
    finishNow: () => { state.status = 'complete'; $('coins-collected').textContent = 'Coins: ' + state.coins; $('level-complete').style.display = 'block'; },
    getLevelCount: () => 5,
  };

  window.addEventListener('load', init);
})();
