/* Rolling Balls — offline, fixed-step Safari/touch edition. */
(function () {
  'use strict';

  const SCREEN_RIGHT_X = -1;
  const BALL_R = 0.45;
  const GRAVITY = 22;
  const MAX_SPEED = 12;
  const ACCEL = 12;
  const BRAKE = 16;
  const ROLL_DRAG = 0.15;
  const COAST_DRAG = 0.55;
  const DOWNHILL_CAP = 15;
  const PAD_SPEED = 16;
  const PAD_DURATION = 1.2;
  const LAT_MAX = 6.5;
  const LAT_RESPONSE = 12;
  const AIR_RESPONSE = 2.5;
  const RESPAWN_S = 2;
  const FIXED_DT = 1 / 120;
  const FALL_Y = -10;
  const INPUT_GRACE = 0.4;
  const CAMERA_TAU = 0.15;
  // LOOK_SPEC v1.1 camera (matches the reference video)
  const CAM_BEHIND = 8.5;
  const CAM_ABOVE = 4.0;
  const CAM_FOV = 60;
  const LOOK_AHEAD = 10;
  const COIN_MAX = 0.6;
  const FOV_TAU = 0.25;
  const EPS = 1e-8;

  const $ = id => document.getElementById(id);
  const setSRGB = t => { if ('colorSpace' in t) t.colorSpace = THREE.SRGBColorSpace; else t.encoding = THREE.sRGBEncoding; };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const smooth = (dt, tau) => 1 - Math.exp(-dt / tau);
  const screenX = (side, distance) =>
    (side === 'right' ? SCREEN_RIGHT_X : -SCREEN_RIGHT_X) * distance;

  const state = {
    level: 1,
    coins: 0,
    progress: 0,
    status: 'playing',
    ball: { x: 0, y: BALL_R, z: 0, vx: 0, vy: 0, vz: 0 },
    grounded: true,
    checkpointIndex: -1,
    fallenCount: 0,
    simTime: 0,
    respawnAt: null,
    fallAt: null
  };

  const drag = { nx: 0, ny: 0, active: false };
  const keys = new Set();
  const origin = { x: 0, y: 0 };
  let pointerId = null;
  let viewW = 1, viewH = 1, streaks = null, lastStreak = '';
  let scene, camera, renderer, ballMesh, planet, hills, levelRoot;
  let segments = [];
  let coins = [];
  let obstacles = [];
  let pads = [];
  let checkpoints = [];
  let chunks = [];
  let hints = [];
  let pileLoss = new Map();
  let trackEnd = 150;
  let accumulator = 0;
  let lastFrame = null;
  let hidden = document.hidden;
  let graceUntil = 0;
  let boostUntil = -Infinity;
  let boostCap = DOWNHILL_CAP;
  let takeoffY = BALL_R;
  let lookTarget;
  let frozenCamera;
  const angular = new THREE.Vector3();
  const spinAxis = new THREE.Vector3();
  const spinQ = new THREE.Quaternion();
  const temp = new THREE.Vector3();
  const aim = new THREE.Vector3();
  const titles = ['First Roll', 'Smash!', 'Slide Gate', 'Thin Rails', 'Grand Tour'];

  const test = {
    paused: false,
    getState: () => ({
      level: state.level,
      progress: state.progress,
      coins: state.coins,
      status: state.status,
      ball: { ...state.ball },
      speed: Math.hypot(state.ball.vx, state.ball.vz),
      grounded: state.grounded,
      checkpointIndex: state.checkpointIndex,
      fallenCount: state.fallenCount,
      simTime: state.simTime,
      respawnAt: state.respawnAt,
      fallAt: state.fallAt
    }),
    setDrag(nx, ny) {
      clearInput();
      drag.nx = deadzone(clamp(Number(nx) || 0, -1, 1));
      drag.ny = deadzone(clamp(Number(ny) || 0, -1, 1));
      drag.active = true;
    },
    clearDrag: clearInput,
    getDrag: () => ({ ...drag }),
    startLevel,
    teleport(x, y, z) {
      Object.assign(state.ball, { x, y, z, vx: 0, vy: 0, vz: 0 });
      angular.set(0, 0, 0);
      ballMesh.quaternion.identity();
      takeoffY = y;
      const t = sampleTrack(z, x);
      state.grounded = t.over && Math.abs(y - BALL_R - t.y) <= 0.06;
      syncBall();
    },
    setVelocity(vx, vy, vz) {
      Object.assign(state.ball, { vx, vy, vz });
    },
    render: true,
    manual: false, // tests: stop the real-time loop so only tick() advances the game
    tick(dt) {
      advance(Math.max(0, Number(dt) || 0));
      if (test.render) draw(Math.max(0, Number(dt) || 0));
      else { syncBall(); updateCamera(Math.max(0, Number(dt) || 0)); }
    },
    projectPoint(x, y, z) {
      camera.updateMatrixWorld(true);
      temp.set(x, y, z).project(camera);
      const r = renderer.domElement.getBoundingClientRect();
      return { sx: r.left + (temp.x + 1) * r.width / 2, sy: r.top + (1 - temp.y) * r.height / 2 };
    },
    finishNow: completeLevel,
    getLevelCount: () => 5,
    getTrackEnd: () => trackEnd,
    getBotHint,
    getObstacles: () => obstacles.filter(o => !o.dead).map(o => ({
      type: o.type,
      x: o.mesh.position.x,
      y: o.mesh.position.y,
      z: o.mesh.position.z,
      w: o.w,
      d: o.d
    })),
    getBallQuaternion: () => ballMesh.quaternion.toArray(),
    projectBall() {
      camera.updateMatrixWorld(true);
      temp.copy(ballMesh.position).project(camera);
      const r = renderer.domElement.getBoundingClientRect();
      return {
        sx: r.left + (temp.x + 1) * r.width / 2,
        sy: r.top + (1 - temp.y) * r.height / 2
      };
    },
    getCamera: () => ({
      x: camera.position.x,
      y: camera.position.y,
      z: camera.position.z,
      fov: camera.fov,
      lookY: lookTarget.y
    }),
    getConfig: () => ({
      SCREEN_RIGHT_X, BALL_R, GRAVITY, MAX_SPEED, ACCEL, BRAKE,
      ROLL_DRAG, COAST_DRAG, DOWNHILL_CAP, PAD_SPEED, PAD_DURATION,
      LAT_MAX, LAT_RESPONSE, AIR_RESPONSE, RESPAWN_S, FIXED_DT,
      FALL_Y, INPUT_GRACE, CAMERA_TAU, FOV_TAU,
      CAMERA_BEHIND: CAM_BEHIND, CAMERA_ABOVE: CAM_ABOVE, LOOK_AHEAD,
      FOV: CAM_FOV, GUARD_HEIGHT: 0.35,
      RAIL_RESTITUTION: 0.35, WALL_RESTITUTION: 0.3
    }),
    getPlanetScreen,
    getCoinSizes: () => coins.map(c => {
      const v = new THREE.Box3().setFromObject(c.mesh).getSize(new THREE.Vector3());
      return Math.max(v.x, v.y, v.z);
    }),
    ballScreen() {
      // on-screen centre and height of the ball (CSS px), from its projected top and bottom
      camera.updateMatrixWorld(true);
      const r = renderer.domElement.getBoundingClientRect();
      const toScreen = v => { temp.copy(v).project(camera); return { x: (temp.x + 1) * r.width / 2, y: (1 - temp.y) * r.height / 2 }; };
      const c = ballMesh.position;
      const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).multiplyScalar(BALL_R);
      const top = toScreen(c.clone().add(up)), bot = toScreen(c.clone().sub(up)), mid = toScreen(c);
      return { cx: mid.x / r.width, cy: mid.y / r.height, heightFrac: Math.abs(bot.y - top.y) / r.height, w: r.width, h: r.height };
    }
  };
  window.__test = test;

  function material(color, extra) {
    return new THREE.MeshStandardMaterial({
      color, roughness: 0.65, ...extra
    });
  }

  function meshBox(w, h, d, mat, x, y, z, parent = levelRoot) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  }

  function init() {
    scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x2A145C, 40, 110);
    camera = new THREE.PerspectiveCamera(CAM_FOV, 1, 0.1, 420);
    scene.add(camera);
    lookTarget = new THREE.Vector3();
    frozenCamera = new THREE.Vector3();

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    if ('outputColorSpace' in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;
    else renderer.outputEncoding = THREE.sRGBEncoding;
    $('game').appendChild(renderer.domElement);

    const key = new THREE.DirectionalLight(0xFFE2C4, 1.55);
    key.position.set(screenX('left', 8), 16, -3);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x8E7CFF, 1.55 * 0.4);
    fill.position.set(screenX('right', 8), 7, -1);
    scene.add(fill);
    scene.add(new THREE.AmbientLight(0xB8B0E8, 0.55));
    scene.add(new THREE.HemisphereLight(0xFFB36B, 0x2A145C, 0.4));

    buildSky();
    buildBall();
    bindInput();
    onResize();
    startLevel(1);
    draw(0);
    requestAnimationFrame(frame);
  }

  function buildSky() {
    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 1024;
    const ctx = canvas.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, 1024);
    g.addColorStop(0, '#3A1D7A');
    // Horizon band follows the v1.1 camera (horizon ~31% down the screen).
    g.addColorStop(0.2, '#3A1D7A');
    g.addColorStop(0.28, '#FF6F7D');
    g.addColorStop(0.33, '#FFB36B');
    g.addColorStop(1, '#2A145C');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 8, 1024);
    const sky = new THREE.CanvasTexture(canvas);
    setSRGB(sky);
    scene.background = sky;

    hills = new THREE.Group();
    scene.add(hills);
    addRidge(215, 0x5B2E9E, 0);
    addRidge(175, 0x7C3FC4, 1);

    planet = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.SphereGeometry(0.53, 32, 24),
      material(0xFFD08A, {
        fog: false, emissive: 0xFFD08A, emissiveIntensity: 0.3
      })
    );
    planet.add(body);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.7, 1, 64),
      new THREE.MeshBasicMaterial({
        color: 0xFF8FB1, opacity: 0.7, transparent: true,
        side: THREE.DoubleSide, fog: false, depthWrite: false
      })
    );
    ring.rotation.set(0.55, -0.18, -0.3);
    planet.add(ring);
    camera.add(planet);
  }

  function addRidge(z, color, phase) {
    // LOOK_SPEC v1.1: no hard bottom edge. Each ridge is a strip of columns; the bottom 30%
    // of every column fades from horizon haze #FF6F7D at 0% opacity up to the ridge colour.
    const base = -10;
    const ridge = new THREE.Color(color), haze = new THREE.Color(0xFF6F7D);
    const pos = [], col = [];
    const count = 24;
    const peak = i => 1 + 5 * Math.sin(i * 1.7 + phase) + 2 * Math.cos(i * 0.8);
    const vert = (x, y, c, a) => { pos.push(x, y, z); col.push(c.r, c.g, c.b, a); };
    for (let i = 0; i < count; i++) {
      const x0 = -300 + i * 25, x1 = x0 + 25;
      const t0 = peak(i), t1 = peak(i + 1);
      const m0 = base + 0.3 * (t0 - base), m1 = base + 0.3 * (t1 - base);
      // fade band (haze, alpha 0) -> (ridge, alpha 1)
      vert(x0, base, haze, 0); vert(x1, base, haze, 0); vert(x1, m1, ridge, 1);
      vert(x0, base, haze, 0); vert(x1, m1, ridge, 1); vert(x0, m0, ridge, 1);
      // solid upper 70%
      vert(x0, m0, ridge, 1); vert(x1, m1, ridge, 1); vert(x1, t1, ridge, 1);
      vert(x0, m0, ridge, 1); vert(x1, t1, ridge, 1); vert(x0, t0, ridge, 1);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false,
      side: THREE.DoubleSide, fog: false
    }));
    mesh.renderOrder = -z; // far ridge first
    hills.add(mesh);
  }


  function buildBall() {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#F4F2FF';
    ctx.fillRect(0, 0, 512, 256);
    ctx.fillStyle = '#FF6F7D';
    ctx.fillRect(0, 113, 512, 30);
    const texture = new THREE.CanvasTexture(canvas);
    setSRGB(texture);
    texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    const geometry = new THREE.SphereGeometry(BALL_R, 40, 28);
    // Bake the starting tilt into the artwork, leaving spin identity on reset.
    geometry.rotateZ(Math.PI / 6);
    ballMesh = new THREE.Mesh(geometry, material(0xFFFFFF, {
      map: texture, roughness: 0.25, metalness: 0.05
    }));
    scene.add(ballMesh);
  }

  function deadzone(n) {
    return Math.abs(n) <= 0.08 ? 0 :
      Math.sign(n) * (Math.abs(n) - 0.08) / 0.92;
  }

  function clearInput() {
    const captured = pointerId;
    pointerId = null;
    drag.nx = drag.ny = 0;
    drag.active = false;
    keys.clear();
    if (captured !== null && renderer) {
      const el = renderer.domElement;
      if (el.hasPointerCapture(captured)) el.releasePointerCapture(captured);
    }
  }

  function bindInput() {
    const el = renderer.domElement;
    $('game').addEventListener('pointerdown', e => {
      if (e.target.closest('#pause-button,#level-complete')) return;
      e.preventDefault(); // no double-tap zoom / selection even when the tap is ignored
      if (pointerId !== null || test.paused || state.status === 'complete') return;
      clearInput();
      // Capture first: if iOS already ended the touch this throws, and we must not keep a dead pointerId.
      try { el.setPointerCapture(e.pointerId); } catch (_) { clearInput(); return; }
      pointerId = e.pointerId;
      origin.x = e.clientX;
      origin.y = e.clientY;
      drag.active = true;
    }, { passive: false });

    el.addEventListener('pointermove', e => {
      if (e.pointerId !== pointerId) return;
      e.preventDefault();
      const r = clamp(0.16 * Math.min(innerWidth, innerHeight), 70, 140);
      let dx = e.clientX - origin.x;
      let dy = e.clientY - origin.y;
      const length = Math.hypot(dx, dy);
      if (length > r) {
        origin.x = e.clientX - dx * r / length;
        origin.y = e.clientY - dy * r / length;
        dx = e.clientX - origin.x;
        dy = e.clientY - origin.y;
      }
      drag.nx = deadzone(clamp(dx / r, -1, 1));
      drag.ny = deadzone(clamp(-dy / r, -1, 1));
    }, { passive: false });

    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      el.addEventListener(name, e => {
        if (e.pointerId === pointerId) clearInput();
      });
    }
    document.addEventListener('gesturestart', e => e.preventDefault(), { passive: false });

    const accepted = new Set([
      'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd'
    ]);
    window.addEventListener('keydown', e => {
      const k = e.key.toLowerCase();
      if (!accepted.has(k)) return;
      e.preventDefault();
      if (!test.paused) keys.add(k);
    });
    window.addEventListener('keyup', e => {
      const k = e.key.toLowerCase();
      if (accepted.has(k)) {
        e.preventDefault();
        keys.delete(k);
      }
    });
    window.addEventListener('blur', () => {
      clearInput();
      lastFrame = null;
      accumulator = 0;
    });
    document.addEventListener('visibilitychange', () => {
      hidden = document.hidden;
      clearInput();
      lastFrame = null;
      accumulator = 0;
    });
    window.addEventListener('resize', onResize);
    $('pause-button').addEventListener('click', () => {
      test.paused = !test.paused;
      clearInput();
      accumulator = 0;
      lastFrame = null;
      $('pause-button').classList.toggle('paused', test.paused);
      $('pause-button').setAttribute('aria-label', test.paused ? 'Resume' : 'Pause');
    });
    $('continue-button').addEventListener('click', () => {
      startLevel(state.level % 5 + 1);
    });
  }

  function onResize() {
    const r = $('game').getBoundingClientRect();
    camera.aspect = r.width / Math.max(1, r.height);
    camera.updateProjectionMatrix();
    viewW = r.width; viewH = Math.max(1, r.height);
    renderer.setSize(r.width, r.height);
    placePlanet();
    if (scene && camera) renderer.render(scene, camera); // setSize clears the canvas; repaint even when paused
  }

  function placePlanet() {
    const distance = 160;
    const height = 2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const width = height * camera.aspect;
    // Camera-local +X is screen-right, unlike the world +X convention.
    planet.position.set(SCREEN_RIGHT_X * 0.62 * width / 2, 0.62 * height / 2, -distance);
    planet.scale.setScalar(height * 0.08 * Math.min(viewW, viewH) / viewH);
  }

  function getPlanetScreen() {
    placePlanet();
    camera.updateMatrixWorld(true);
    const r = renderer.domElement.getBoundingClientRect();
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    planet.traverse(o => {
      if (!o.isMesh) return;
      const pos = o.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        temp.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).project(camera);
        const x = r.left + (temp.x + 1) * r.width / 2;
        const y = r.top + (1 - temp.y) * r.height / 2;
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    });
    return { left, top, right, bottom };
  }

  function disposeLevel() {
    if (!levelRoot) return;
    const geometries = new Set();
    const materials = new Set();
    levelRoot.traverse(o => {
      if (o.geometry) geometries.add(o.geometry);
      if (o.material) {
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          materials.add(m);
        }
      }
    });
    scene.remove(levelRoot);
    geometries.forEach(g => g.dispose());
    materials.forEach(m => {
      if (m.map) m.map.dispose();
      m.dispose();
    });
  }

  function segment(z0, z1, y0, y1, guard = 'both', width = 4, extra = {}) {
    return { z0, z1, y0, y1, guard, width, ...extra };
  }

  function startLevel(n) {
    n = clamp(Math.floor(Number(n) || 1), 1, 5);
    clearInput();
    disposeLevel();
    levelRoot = new THREE.Group();
    scene.add(levelRoot);
    segments = [];
    coins = [];
    obstacles = [];
    checkpoints = [];
    pads = [];
    chunks = [];
    hints = [];
    pileLoss = new Map();
    accumulator = 0;
    lastFrame = null;
    boostUntil = -Infinity;
    boostCap = DOWNHILL_CAP;
    Object.assign(state, {
      level: n, coins: 0, progress: 0, status: 'playing',
      checkpointIndex: -1, fallenCount: 0, simTime: 0,
      respawnAt: null, fallAt: null, grounded: true
    });
    test.paused = false;
    $('pause-button').classList.remove('paused');
    $('pause-button').setAttribute('aria-label', 'Pause');
    $('level-complete').style.display = 'none';
    $('level-title').textContent = 'Level ' + n + ' · ' + titles[n - 1];
    buildLevel(n);
    resetBall(0, 0);
    updateHUD();
  }

  function buildLevel(n) {
    if (n === 1) {
      trackEnd = 150;
      segments = [
        segment(-8, 60, 0, 0),
        segment(60, 90, 0, -0.6),
        segment(90, 95, -0.6, 0.9),
        segment(99, 162, 0.1, 0.1)
      ];
      hints = [{ z: 0, x: 0, throttle: 1 }, { z: 150, x: 0, throttle: 1 }];
    } else if (n === 2) {
      trackEnd = 170;
      segments = [
        segment(-8, 45, 0, 0),
        segment(45, 95, 0, 0, 'left'),
        segment(95, 115, 0, 0),
        segment(115, 130, 0, 0.9),
        segment(130, 148, 0.9, 0),
        segment(148, 182, 0, 0)
      ];
      hints = [{ z: 0, x: 0, throttle: 1 }, { z: 170, x: 0, throttle: 1 }];
    } else if (n === 3) {
      trackEnd = 180;
      segments = [segment(-8, 192, 0, 0)];
      hints = [{ z: 0, x: 0, throttle: 1 }, { z: 180, x: 0, throttle: 1 }];
    } else if (n === 4) {
      trackEnd = 200;
      segments = [
        segment(-8, 42, 0, 0),
        segment(42, 55, 0, 1.5, 'both', 4, { endWidth: 2.8 }),
        segment(55, 85, 1.5, 1.5, 'none', 0.8, {
          centers: [screenX('right', 1), screenX('left', 1)]
        }),
        segment(85, 145, 1.5, 1.5),
        segment(151, 212, 2, 2)
      ];
      hints = [
        { z: 0, x: 0, throttle: 1 },
        { z: 32, x: 0, throttle: 1 },
        { z: 44, x: screenX('right', 1), throttle: 1 },
        { z: 88, x: screenX('right', 1), throttle: 1 },
        { z: 100, x: 0, throttle: 1 },
        { z: 200, x: 0, throttle: 1 }
      ];
    } else {
      trackEnd = 240;
      segments = [
        segment(-8, 75, 0, 0),
        segment(75, 110, 0, 0, 'left'),
        segment(110, 150, 0, 0),
        segment(150, 170, 0, 0.8),
        segment(170, 185, 0.8, 0.8),
        segment(191, 252, 1.3, 1.3)
      ];
      hints = [
        { z: 0, x: 0, throttle: 1 },
        { z: 240, x: 0, throttle: 1 }
      ];
    }

    buildTrackMeshes();

    if (n === 2) {
      addPile(30, 0);
      addPile(75, 1);
      addPile(105, 2);
    }
    if (n === 3) {
      addWall(48, 0);
      addWall(112, Math.PI * 0.7);
      addPad('speed', 0, 58);
    }
    if (n === 4) {
      addCheckpoint(30);
      addPad('jump', 0, 144);
      addEntryArrow(39);
    }
    if (n === 5) {
      addPile(28, 0);
      addWall(62, 0.8);
      addCheckpoint(121);
      addPad('speed', 0, 136);
      addPad('jump', 0, 184);
      addPile(216, 1);
    }

    // Coin lines follow the authored bot route, including the correct thin rail.
    for (let z = 7; z < trackEnd - 4; z += 5) {
      const h = interpolateHint(z);
      const t = sampleTrack(z, h.x);
      if (t.over) addCoin(h.x, z);
    }
    for (const z of [18, 38, trackEnd - 20]) {
      const x = screenX('left', 1.15);
      if (sampleTrack(z, x).over) addCoin(x, z);
    }
    addFinish();
  }

  function sampleTrack(z, x = 0) {
    // Half-open segments make a lip/gap boundary unambiguous.
    for (const s of segments) {
      if (z < s.z0 || z >= s.z1) continue;
      const u = (z - s.z0) / (s.z1 - s.z0);
      const y = s.y0 + (s.y1 - s.y0) * u;
      const slope = (s.y1 - s.y0) / (s.z1 - s.z0);
      const width = s.width + ((s.endWidth || s.width) - s.width) * u;
      const centers = s.centers || [0];
      let center = centers[0];
      for (const c of centers) {
        if (Math.abs(x - c) < Math.abs(x - center)) center = c;
      }
      return {
        y, slope, s: slope, half: width / 2, center,
        over: Math.abs(x - center) <= width / 2,
        guard: s.guard, segment: s
      };
    }
    return {
      y: nearestSupportY(z, x), slope: 0, s: 0,
      half: 0, center: 0, over: false, guard: 'none', segment: null
    };
  }

  function nearestSupportY(z, x) {
    let best = Infinity;
    let y = 0;
    for (const s of segments) {
      const zz = clamp(z, s.z0, s.z1);
      const u = (zz - s.z0) / (s.z1 - s.z0);
      const width = s.width + ((s.endWidth || s.width) - s.width) * u;
      for (const c of s.centers || [0]) {
        const dx = Math.max(0, Math.abs(x - c) - width / 2);
        const distance = (z - zz) ** 2 + dx * dx;
        if (distance < best) {
          best = distance;
          y = s.y0 + (s.y1 - s.y0) * u;
        }
      }
    }
    return y;
  }

  function buildTrackMeshes() {
    const top = material(0x2C2F86, { roughness: 0.85 });
    const seam = material(0x3A3FA3);
    const navy = material(0x1B1F55);
    const mint = material(0x3EE6B0, {
      emissive: 0x3EE6B0, emissiveIntensity: 0.6
    });
    const yellow = material(0xFFD23F, {
      emissive: 0xFFD23F, emissiveIntensity: 0.6
    });

    for (const s of segments) {
      const dz = s.z1 - s.z0;
      const dy = s.y1 - s.y0;
      const length = Math.hypot(dz, dy);
      const pitch = -Math.atan2(dy, dz);
      const midZ = (s.z0 + s.z1) / 2;
      const midY = (s.y0 + s.y1) / 2;
      const endWidth = s.endWidth || s.width;

      for (const cx of s.centers || [0]) {
        // Top vertices are exact surface endpoints; thickness is vertical.
        const a = s.width / 2;
        const b = endWidth / 2;
        const vertices = new Float32Array([
          cx - a, s.y0, s.z0, cx + a, s.y0, s.z0,
          cx + b, s.y1, s.z1, cx - b, s.y1, s.z1,
          cx - a, s.y0 - 0.25, s.z0, cx + a, s.y0 - 0.25, s.z0,
          cx + b, s.y1 - 0.25, s.z1, cx - b, s.y1 - 0.25, s.z1
        ]);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
        geo.setIndex([
          0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
          0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2,
          0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5
        ]);
        geo.computeVertexNormals();
        levelRoot.add(new THREE.Mesh(geo, top));

        for (const side of ['left', 'right']) {
          const sign = screenX(side, 1);
          const edge0 = cx + sign * a;
          const edge1 = cx + sign * b;
          const edgeLength = Math.hypot(dz, dy, edge1 - edge0);
          const railDirection = new THREE.Vector3(edge1 - edge0, dy, dz).normalize();
          const rotation = new THREE.Quaternion().setFromUnitVectors(
            new THREE.Vector3(0, 0, 1), railDirection
          );
          const addEdge = (width, height, inset, lift, mat) => {
            const m = meshBox(
              width, height, edgeLength, mat,
              (edge0 + edge1) / 2 - sign * inset, midY + lift, midZ
            );
            m.quaternion.copy(rotation);
          };
          addEdge(0.12, 0.035, 0.06, 0.02, mint);
          addEdge(0.06, 0.04, 0.15, 0.025, yellow);
          if (s.guard === 'both' || s.guard === side) {
            addEdge(0.11, 0.28, -0.025, 0.14, navy);
            const cap = new THREE.Mesh(
              new THREE.CylinderGeometry(0.065, 0.065, edgeLength, 8), mint
            );
            cap.position.set((edge0 + edge1) / 2 + sign * 0.025, midY + 0.285, midZ);
            cap.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), railDirection);
            levelRoot.add(cap);
          }
        }

        for (let z = Math.ceil(s.z0 / 4) * 4; z < s.z1; z += 4) {
          const u = (z - s.z0) / dz;
          const width = s.width + (endWidth - s.width) * u;
          const m = meshBox(width - 0.36, 0.012, 0.055, seam,
            cx, s.y0 + dy * u + 0.008, z);
          m.rotation.x = pitch;
        }
        // Retain the exact sloped length for seams and edge meshes above.
        void length;
      }
    }
  }

  function addCoin(x, z) {
    const group = new THREE.Group();
    const face = new THREE.Mesh(
      new THREE.CylinderGeometry(0.265, 0.265, 0.075, 24),
      material(0xFFD23F, {
        emissive: 0xFFD23F, emissiveIntensity: 0.5,
        metalness: 0.25, roughness: 0.35
      })
    );
    face.rotation.x = Math.PI / 2;
    group.add(face);
    group.add(new THREE.Mesh(
      new THREE.TorusGeometry(0.277, 0.023, 8, 32),
      material(0xE0A800, { metalness: 0.3, roughness: 0.3 })
    ));
    // Hard 0.6 m size cap on every coin (face + rim), whatever its geometry.
    const size = new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3());
    const biggest = Math.max(size.x, size.y);
    if (biggest > COIN_MAX) group.scale.setScalar(COIN_MAX / biggest);
    group.position.set(x, sampleTrack(z, x).y + 0.7, z);
    levelRoot.add(group);
    coins.push({ mesh: group, collected: false });
  }

  function addPile(z, pile) {
    const colors = [0xFF8FB1, 0x9AF0FF, 0xB6F36A];
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        const x = (col - 1) * 0.55;
        const zz = z + row * 0.55;
        const color = colors[(row + col + pile) % colors.length];
        const mesh = meshBox(0.5, 0.5, 0.5, material(color, { roughness: 0.45 }),
          x, sampleTrack(zz, x).y + 0.25, zz);
        obstacles.push({
          type: 'candy', mesh, w: 0.5, h: 0.5, d: 0.5,
          pile, color, dead: false
        });
      }
    }
  }

  function addWall(z, phase) {
    const w = 1.6, h = 1.5, d = 0.4;
    const mesh = meshBox(w, h, d, material(0x1B1F55), 0,
      sampleTrack(z, 0).y + h / 2, z);
    meshBox(w, 0.055, d + 0.02,
      material(0x3EE6B0, { emissive: 0x3EE6B0, emissiveIntensity: 0.6 }),
      0, h / 2 - 0.03, 0, mesh);
    obstacles.push({
      type: 'sliding', mesh, w, h, d,
      amp: 1.1, spd: 2 * Math.PI / 3, phase, wallVx: 0, dead: false
    });
    updateWall(obstacles[obstacles.length - 1]);
  }

  function updateWall(o) {
    const phase = state.simTime * o.spd + o.phase;
    o.mesh.position.x = o.amp * Math.sin(phase);
    o.wallVx = o.amp * o.spd * Math.cos(phase);
  }

  function addPad(type, x, z) {
    const y = sampleTrack(z, x).y;
    const color = type === 'jump' ? 0xFFD23F : 0x3EE6B0;
    const mesh = meshBox(3.6, 0.045, 0.7,
      material(color, { emissive: color, emissiveIntensity: 0.5 }),
      x, y + 0.025, z);
    for (let i = -1; i <= 1; i++) {
      const arrow = new THREE.Mesh(
        new THREE.ConeGeometry(0.13, 0.24, 3),
        new THREE.MeshBasicMaterial({ color: 0xFFFFFF })
      );
      arrow.rotation.x = Math.PI / 2;
      arrow.position.set(i * 0.9, 0.04, 0);
      mesh.add(arrow);
    }
    pads.push({ type, x, y, z, mesh, inside: false, used: false });
  }

  function addCheckpoint(z) {
    const y = sampleTrack(z, 0).y;
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.95, 1.25, 48),
      material(0xFFD23F, {
        emissive: 0xFFD23F, emissiveIntensity: 0.7,
        side: THREE.DoubleSide
      })
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(0, y + 0.015, z);
    levelRoot.add(mesh);
    checkpoints.push({ x: 0, z, y: y + BALL_R, mesh, passed: false });
  }

  function addEntryArrow(z) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#FFD23F';
    ctx.beginPath();
    ctx.moveTo(30, 45);
    ctx.lineTo(150, 45);
    ctx.lineTo(150, 15);
    ctx.lineTo(230, 64);
    ctx.lineTo(150, 113);
    ctx.lineTo(150, 83);
    ctx.lineTo(30, 83);
    ctx.closePath();
    ctx.fill();
    const texture = new THREE.CanvasTexture(canvas);
    setSRGB(texture);
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(2.5, 1.25),
      new THREE.MeshBasicMaterial({
        map: texture, transparent: true, depthWrite: false, side: THREE.DoubleSide
      })
    );
    mesh.rotation.x = -Math.PI / 2;
    // Plane local +X maps to world -X, i.e. screen-right.
    mesh.rotation.z = Math.PI;
    mesh.position.set(0, sampleTrack(z, 0).y + 0.025, z);
    levelRoot.add(mesh);
  }

  function addFinish() {
    const y = sampleTrack(trackEnd, 0).y;
    const portal = new THREE.Group();
    const mat = material(0x9AF0FF, {
      emissive: 0x9AF0FF, emissiveIntensity: 0.65
    });
    portal.add(new THREE.Mesh(new THREE.TorusGeometry(1.7, 0.085, 10, 64), mat));
    const bulbMat = material(0xFFFFFF, {
      emissive: 0xFFFFFF, emissiveIntensity: 0.9
    });
    for (let i = 0; i < 16; i++) {
      const a = i * Math.PI / 8;
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 8), bulbMat);
      bulb.position.set(Math.cos(a) * 1.7, Math.sin(a) * 1.7, 0);
      portal.add(bulb);
    }
    portal.position.set(0, y + 1.7, trackEnd);
    levelRoot.add(portal);
  }

  function interpolateHint(z) {
    if (z <= hints[0].z) return { x: hints[0].x, throttle: hints[0].throttle };
    for (let i = 1; i < hints.length; i++) {
      if (z > hints[i].z) continue;
      const a = hints[i - 1], b = hints[i];
      const u = (z - a.z) / (b.z - a.z);
      return {
        x: a.x + (b.x - a.x) * u,
        throttle: a.throttle + (b.throttle - a.throttle) * u
      };
    }
    const last = hints[hints.length - 1];
    return { x: last.x, throttle: last.throttle };
  }

  function getBotHint(z) {
    const hint = interpolateHint(z);
    for (const o of obstacles) {
      if (o.type !== 'sliding') continue;
      const distance = o.mesh.position.z - z;
      if (distance < -1.5 || distance > 16) continue;
      const travel = Math.max(0, distance / Math.max(6, state.ball.vz));
      const predictedX = o.amp * Math.sin(
        (state.simTime + travel) * o.spd + o.phase
      );
      // Aim for the centre of the larger open lane at arrival time.
      const side = predictedX >= 0 ? 'right' : 'left';
      const target = screenX(side, 1.35);
      const blend = clamp((16 - distance) / 7, 0, 1);
      hint.x += (target - hint.x) * blend;
      break;
    }
    return hint;
  }

  function resetBall(x, z) {
    const y = sampleTrack(z, x).y + BALL_R;
    Object.assign(state.ball, { x, y, z, vx: 0, vy: 0, vz: 0 });
    state.grounded = true;
    angular.set(0, 0, 0);
    ballMesh.quaternion.identity();
    takeoffY = y;
    boostUntil = -Infinity;
    boostCap = DOWNHILL_CAP;
    for (const p of pads) {
      p.inside = false;
      p.used = false;
    }
    clearInput();
    graceUntil = state.simTime + INPUT_GRACE;
    syncBall();
    snapCamera();
  }

  function respawn() {
    const cp = checkpoints[state.checkpointIndex];
    state.status = 'respawning';
    resetBall(cp ? cp.x : 0, cp ? cp.z : 0);
    state.respawnAt = state.fallAt + RESPAWN_S;
    state.status = 'playing';
  }

  function beginFall() {
    if (state.status !== 'playing') return;
    state.status = 'falling';
    state.grounded = false;
    state.fallAt = state.simTime;
    state.fallenCount++;
    frozenCamera.copy(camera.position);
  }

  function completeLevel() {
    if (state.status === 'complete') return;
    state.status = 'complete';
    state.progress = 1;
    state.ball.vx = 0;
    clearInput();
    $('coins-collected').textContent = 'Coins: ' + state.coins;
    $('level-complete').style.display = 'block';
    updateHUD();
  }

  function controls() {
    const right = keys.has('arrowright') || keys.has('d') ? 1 : 0;
    const left = keys.has('arrowleft') || keys.has('a') ? 1 : 0;
    const up = keys.has('arrowup') || keys.has('w') ? 1 : 0;
    const down = keys.has('arrowdown') || keys.has('s') ? 1 : 0;
    return {
      nx: clamp(drag.nx + right - left, -1, 1),
      ny: state.simTime < graceUntil ? 0 : clamp(drag.ny + up - down, -1, 1)
    };
  }

  function advance(dt) {
    accumulator += dt;
    while (accumulator + EPS >= FIXED_DT) {
      simulate(FIXED_DT);
      accumulator -= FIXED_DT;
    }
    if (accumulator < 0) accumulator = 0;
  }

  function simulate(dt) {
    state.simTime += dt;
    updateProps(dt);
    const b = state.ball;

    if (state.status === 'falling' || state.status === 'respawning') {
      b.vy -= GRAVITY * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.z += b.vz * dt;
      spinAir(dt);
      if (state.simTime + EPS >= state.fallAt + RESPAWN_S) respawn();
      return;
    }

    if (state.status === 'complete') {
      b.vx *= Math.exp(-3 * dt);
      b.vz *= Math.exp(-3 * dt);
      const dx = b.vx * dt, dz = b.vz * dt;
      b.x += dx;
      b.z += dz;
      const t = sampleTrack(b.z, b.x);
      if (t.over) {
        const dy = t.y + BALL_R - b.y;
        b.y = t.y + BALL_R;
        b.vy = b.vz * t.slope;
        spinGround(dx, dy, dz, dt);
      } else {
        b.vy -= GRAVITY * dt;
        b.y = Math.max(FALL_Y, b.y + b.vy * dt);
        spinAir(dt);
      }
      return;
    }

    const old = { x: b.x, y: b.y, z: b.z };
    const previousBottom = b.y - BALL_R;
    const t0 = sampleTrack(b.z, b.x);
    const wasGrounded = state.grounded;
    let grounded = t0.over &&
      Math.abs(previousBottom - t0.y) <= 0.06 &&
      b.vy <= t0.slope * b.vz + 0.5;

    const input = controls();
    const response = grounded ? LAT_RESPONSE : AIR_RESPONSE;
    b.vx += (SCREEN_RIGHT_X * input.nx * LAT_MAX - b.vx) *
      (1 - Math.exp(-response * dt));
    b.vx = clamp(b.vx, -LAT_MAX, LAT_MAX);

    if (input.ny > 0) {
      // Throttle alone never adds speed above its cruise cap.
      if (b.vz < MAX_SPEED) {
        b.vz = Math.min(MAX_SPEED, b.vz + ACCEL * input.ny * dt);
      }
    } else if (input.ny < 0 && b.vz > 0) {
      b.vz = Math.max(0, b.vz - BRAKE * -input.ny * dt);
    }
    b.vz *= Math.exp(-(input.ny > 0 ? ROLL_DRAG : COAST_DRAG) * dt);

    if (grounded) {
      b.vz += -GRAVITY * t0.slope / (1 + t0.slope * t0.slope) * dt;
      b.vy = b.vz * t0.slope;
    } else {
      if (wasGrounded) takeoffY = b.y;
      b.vy -= GRAVITY * dt;
    }

    if (state.simTime <= boostUntil) {
      boostCap = PAD_SPEED;
    } else {
      boostCap += (DOWNHILL_CAP - boostCap) * smooth(dt, 0.45);
    }
    b.vz = clamp(b.vz, -DOWNHILL_CAP, Math.max(DOWNHILL_CAP, boostCap));

    const dx = b.vx * dt;
    const dz = b.vz * dt;
    const dy = b.vy * dt;
    b.x += dx;
    b.z += dz;
    b.y += dy;

    resolveGuards();
    const t1 = sampleTrack(b.z, b.x);
    const relativeVy = b.vy - t1.slope * b.vz;
    const nearSurface = b.y - BALL_R <= t1.y + 0.002;
    const abovePreviously = previousBottom >= t1.y - 0.2;
    const smallDrop = grounded && t0.over && t1.over &&
      t0.slope <= 0 && t0.y - t1.y >= -EPS && t0.y - t1.y < 0.15;

    if (t1.over && abovePreviously &&
        ((nearSurface && relativeVy <= 0) || smallDrop)) {
      b.y = t1.y + BALL_R;
      if (!grounded && Math.abs(relativeVy) > 6) {
        b.vy = t1.slope * b.vz - relativeVy * 0.12;
        grounded = false;
      } else {
        b.vy = t1.slope * b.vz;
        grounded = true;
      }
    } else if (grounded && t1.over &&
        Math.abs(b.y - BALL_R - t1.y) <= 0.06 &&
        relativeVy <= 0.5) {
      b.y = t1.y + BALL_R;
      b.vy = b.vz * t1.slope;
    } else {
      if (grounded) takeoffY = old.y;
      grounded = false;
      // Arriving below the deck top: hit the slab's front or side face instead of clipping into it.
      if (t1.over && !abovePreviously && b.y + BALL_R > t1.y - 0.25 && b.y - BALL_R < t1.y) {
        const was = sampleTrack(old.z, old.x);
        if (!was.over || was.segment !== t1.segment) {
          if (old.z < t1.segment.z0) { b.z = t1.segment.z0 - BALL_R; b.vz = -0.2 * Math.abs(b.vz); }
          else { b.x = old.x; b.vx *= -0.3; }
        }
      }
    }
    state.grounded = grounded;
    if (grounded) takeoffY = b.y;

    if (b.y < nearestSupportY(b.z, b.x) - 1.5 || b.y < FALL_Y) {
      beginFall();
      return;
    }

    const rolled = { x: b.x - old.x, z: b.z - old.z };
    collideObstacles();
    resolveGuards();
    const afterCollision = sampleTrack(b.z, b.x);
    if (!afterCollision.over) state.grounded = false;

    // Spin from the distance actually rolled this step (rails and walls included):
    // axis = cross(up, travel), angle = distance / radius.
    if (grounded || state.grounded) spinGround(rolled.x, afterCollision.slope * rolled.z, rolled.z, dt);
    else spinAir(dt);

    collidePads();
    collectCoins();
    crossCheckpoints(old);
    crossFinish(old);
    if (state.status !== 'complete') {
      state.progress = clamp(b.z / trackEnd, 0, 1);
    }
  }

  function spinGround(dx, dy, dz, dt) {
    const horizontal = Math.hypot(dx, dz);
    if (horizontal < EPS) {
      angular.set(0, 0, 0);
      return;
    }
    spinAxis.set(dz, 0, -dx).normalize();
    const angle = Math.hypot(dx, dy, dz) / BALL_R;
    spinQ.setFromAxisAngle(spinAxis, angle);
    ballMesh.quaternion.premultiply(spinQ).normalize();
    angular.copy(spinAxis).multiplyScalar(angle / dt);
  }

  function spinAir(dt) {
    const magnitude = angular.length();
    if (magnitude > EPS) {
      spinAxis.copy(angular).multiplyScalar(1 / magnitude);
      const decay = Math.exp(-0.5 * dt);
      spinQ.setFromAxisAngle(spinAxis, magnitude * (1 - decay) / 0.5);
      ballMesh.quaternion.premultiply(spinQ).normalize();
      angular.multiplyScalar(decay);
    }
  }

  function resolveGuards() {
    const b = state.ball;
    const t = sampleTrack(b.z, b.x);
    if (!t.segment || b.y - BALL_R > t.y + 0.35 || b.y < t.y) return;
    for (const side of ['left', 'right']) {
      if (t.guard !== 'both' && t.guard !== side) continue;
      const sign = screenX(side, 1);
      const distance = (b.x - t.center) * sign;
      if (distance + BALL_R <= t.half) continue;
      if (distance - BALL_R > t.half + 0.12) continue; // beyond the rail (flying past), not touching it
      b.x = t.center + sign * (t.half - BALL_R);
      if (b.vx * sign > 0) {
        // Bounce off the rail; scrub a little forward speed only on a real impact,
        // not on every step while the ball rolls along the rail.
        if (b.vx * sign > 1) b.vz *= 0.97;
        b.vx = -0.35 * b.vx;
      }
    }
  }

  function sphereBoxContact(o) {
    const b = state.ball;
    const p = o.mesh.position;
    const hx = o.w / 2, hy = o.h / 2, hz = o.d / 2;
    const cx = clamp(b.x, p.x - hx, p.x + hx);
    const cy = clamp(b.y, p.y - hy, p.y + hy);
    const cz = clamp(b.z, p.z - hz, p.z + hz);
    return (b.x - cx) ** 2 + (b.y - cy) ** 2 + (b.z - cz) ** 2 <= BALL_R ** 2;
  }

  function collideObstacles() {
    const b = state.ball;
    for (const o of obstacles) {
      if (o.dead || !sphereBoxContact(o)) continue;
      if (o.type === 'candy') {
        o.dead = true;
        o.mesh.visible = false;
        spawnChunks(o);
        const previous = pileLoss.has(o.pile) ? pileLoss.get(o.pile) : 1;
        const next = Math.max(0.7, previous * 0.93);
        b.vz *= next / previous;
        pileLoss.set(o.pile, next);
        continue;
      }

      const p = o.mesh.position;
      const delta = [b.x - p.x, b.y - p.y, b.z - p.z];
      const extent = [o.w / 2 + BALL_R, o.h / 2 + BALL_R, o.d / 2 + BALL_R];
      let axis = 0;
      let penetration = extent[0] - Math.abs(delta[0]);
      // (axis may be switched to z below when the ball is squeezed against a rail)
      for (let i = 1; i < 3; i++) {
        const amount = extent[i] - Math.abs(delta[i]);
        if (amount < penetration) {
          penetration = amount;
          axis = i;
        }
      }
      if (axis === 0) {
        const tx = p.x + (Math.sign(delta[0]) || 1) * extent[0];
        const tr = sampleTrack(b.z, tx);
        const side = (tx - tr.center) * SCREEN_RIGHT_X > 0 ? 'right' : 'left';
        if ((tr.guard === 'both' || tr.guard === side) && Math.abs(tx - tr.center) + BALL_R > tr.half) axis = 2;
      }
      const sign = Math.sign(delta[axis]) || (axis === 2 ? -1 : 1);
      if (axis === 0) {
        b.x = p.x + sign * extent[0];
        const relative = b.vx - o.wallVx;
        if (relative * sign < 0) b.vx = o.wallVx - 0.3 * relative;
        b.vx = clamp(b.vx, -LAT_MAX, LAT_MAX);
      } else if (axis === 1) {
        b.y = p.y + sign * extent[1];
        if (b.vy * sign < 0) b.vy = 0;
        state.grounded = false;
        takeoffY = b.y;
      } else {
        b.z = p.z + sign * extent[2];
        if (b.vz * sign < 0) b.vz = sign < 0 ? Math.max(-1, -0.3 * b.vz) : -0.3 * b.vz;
      }
    }
  }

  function spawnChunks(o) {
    const b = state.ball;
    const count = 6 + Math.floor(Math.random() * 3);
    for (let i = 0; i < count; i++) {
      const size = 0.15 + Math.random() * 0.05;
      const mat = material(o.color, { transparent: true, opacity: 1 });
      const mesh = meshBox(size, size, size, mat,
        o.mesh.position.x, o.mesh.position.y, o.mesh.position.z);
      chunks.push({
        mesh, age: 0,
        vx: b.vx * 0.45 + (Math.random() - 0.5) * 5,
        vy: 2 + Math.random() * 4,
        vz: b.vz * 0.5 + (Math.random() - 0.5) * 5,
        rx: (Math.random() - 0.5) * 12,
        rz: (Math.random() - 0.5) * 12
      });
    }
  }

  function collidePads() {
    const b = state.ball;
    for (const p of pads) {
      const inside = Math.abs(b.x - p.x) < 1.8 &&
        Math.abs(b.z - p.z) < 0.35;
      if (!inside) {
        p.inside = false;
        p.used = false;
        continue;
      }
      p.inside = true;
      if (p.used || !state.grounded || Math.abs(b.y - BALL_R - p.y) > 0.15) continue;
      p.used = true;
      if (p.type === 'speed') {
        b.vz = Math.max(b.vz, PAD_SPEED);
        boostUntil = state.simTime + PAD_DURATION;
        boostCap = PAD_SPEED;
      } else {
        b.vy = 9;
        state.grounded = false;
        takeoffY = b.y;
      }
    }
  }

  function collectCoins() {
    const b = state.ball;
    for (const c of coins) {
      if (c.collected) continue;
      const p = c.mesh.position;
      if (Math.hypot(b.x - p.x, b.y - p.y, b.z - p.z) <= 0.75) {
        c.collected = true;
        c.mesh.visible = false;
        state.coins++;
      }
    }
  }

  function sweptX(old, z) {
    const b = state.ball;
    const fraction = clamp((z - old.z) / (b.z - old.z || EPS), 0, 1);
    return old.x + (b.x - old.x) * fraction;
  }

  function crossCheckpoints(old) {
    const b = state.ball;
    if (!state.grounded) return;
    checkpoints.forEach((cp, index) => {
      if (cp.passed || old.z >= cp.z || b.z < cp.z) return;
      const x = sweptX(old, cp.z);
      if (!sampleTrack(cp.z, x).over) return;
      cp.passed = true;
      state.checkpointIndex = index;
      cp.mesh.material.color.setHex(0x3EE6B0);
      cp.mesh.material.emissive.setHex(0x3EE6B0);
    });
  }

  function crossFinish(old) {
    const b = state.ball;
    if (old.z < trackEnd && b.z >= trackEnd) {
      const x = sweptX(old, trackEnd);
      if (sampleTrack(trackEnd, x).over) completeLevel();
    }
  }

  function updateProps(dt) {
    for (const o of obstacles) {
      if (o.type === 'sliding') updateWall(o);
    }
    for (const c of coins) {
      if (!c.collected) c.mesh.rotation.y += Math.PI * dt;
    }
    for (let i = chunks.length - 1; i >= 0; i--) {
      const c = chunks[i];
      c.age += dt;
      if (c.age >= 1.2) {
        levelRoot.remove(c.mesh);
        c.mesh.geometry.dispose();
        c.mesh.material.dispose();
        chunks.splice(i, 1);
        continue;
      }
      c.vy -= GRAVITY * dt;
      c.mesh.position.x += c.vx * dt;
      c.mesh.position.y += c.vy * dt;
      c.mesh.position.z += c.vz * dt;
      c.mesh.rotation.x += c.rx * dt;
      c.mesh.rotation.z += c.rz * dt;
      c.mesh.material.opacity = clamp((1.2 - c.age) / 0.45, 0, 1);
    }
  }

  function cameraAim() {
    const b = state.ball;
    const ahead = sampleTrack(b.z + LOOK_AHEAD, b.x);
    const supportY = ahead.y + BALL_R;
    const framingY = state.grounded ? b.y : Math.max(b.y, takeoffY);
    // Look 10 m ahead at ball height on the flat (puts the ball ~70% down the screen);
    // blends toward the track ahead so it still pitches with climbs and drops.
    return aim.set(b.x, framingY * 0.7 + supportY * 0.3, b.z + LOOK_AHEAD + leadZ());
  }

  // The 0.15 s follow trails a moving target by v*tau; lead the target by the same
  // amount so the camera sits 8.5 m behind at speed instead of ~10 m.
  // The lead itself is eased (0.3 s) so a speed-pad kick doesn't jolt the camera.
  let camLead = 0;
  function leadZ() { return camLead; }
  function updateLead(dt) {
    const want = state.status === 'playing' ? Math.max(0, state.ball.vz) * CAMERA_TAU : 0;
    camLead += (want - camLead) * smooth(dt, 0.3);
  }

  function snapCamera() {
    const b = state.ball;
    camLead = Math.max(0, b.vz) * CAMERA_TAU;
    camera.position.set(b.x, b.y + CAM_ABOVE, b.z - CAM_BEHIND);
    lookTarget.copy(cameraAim());
    camera.fov = CAM_FOV;
    camera.updateProjectionMatrix();
    camera.lookAt(lookTarget);
    camera.updateMatrixWorld(true);
    frozenCamera.copy(camera.position);
    placePlanet();
  }

  function updateCamera(dt) {
    const b = state.ball;
    const k = smooth(dt, CAMERA_TAU);
    if (state.status === 'falling' || state.status === 'respawning') {
      camera.position.copy(frozenCamera);
      const horizontal = Math.max(0.1, Math.hypot(
        b.x - camera.position.x, b.z - camera.position.z
      ));
      const minY = camera.position.y -
        horizontal * Math.tan(THREE.MathUtils.degToRad(60)); // hold still, look down at the falling ball
      lookTarget.set(b.x, Math.max(b.y, minY), b.z);
    } else {
      updateLead(dt);
      temp.set(b.x, b.y + CAM_ABOVE, b.z - CAM_BEHIND + leadZ());
      camera.position.lerp(temp, k);
      lookTarget.lerp(cameraAim(), k);
    }
    camera.lookAt(lookTarget);
    const speed = Math.max(0, b.vz); // forward speed only: steering must not trigger the speed FOV/streaks
    // v1.1: fixed 60° FOV (no speed widening, so the ball keeps its on-screen size)
    if (camera.fov !== CAM_FOV) { camera.fov = CAM_FOV; camera.updateProjectionMatrix(); }
    camera.updateMatrixWorld(true);
    hills.position.set(camera.position.x, 0, camera.position.z);
    placePlanet();
    const opacity = speed >= MAX_SPEED * 0.85 ? '1' : '0';
    if (opacity !== lastStreak) {
      if (!streaks) streaks = [document.querySelector('.left-streak'), document.querySelector('.right-streak')];
      for (const el of streaks) el.style.opacity = opacity;
      lastStreak = opacity;
    }
  }

  function syncBall() {
    const b = state.ball;
    ballMesh.position.set(b.x, b.y, b.z);
  }

  function updateHUD() {
    $('coin-counter').textContent = 'Coins: ' + state.coins;
    $('progress-bar').style.width = (state.progress * 100).toFixed(1) + '%';
    $('progress-container').setAttribute('aria-valuenow',
      String(Math.round(state.progress * 100)));
  }

  function draw(dt) {
    syncBall();
    updateCamera(dt);
    updateHUD();
    renderer.render(scene, camera);
  }

  function frame(timestamp) {
    if (lastFrame === null) lastFrame = timestamp;
    const dt = clamp((timestamp - lastFrame) / 1000, 0, 0.1);
    lastFrame = timestamp;
    if (!hidden && !test.paused && !test.manual) {
      advance(dt);
      draw(dt);
    }
    requestAnimationFrame(frame);
  }

  if (document.readyState === 'complete') init();
  else window.addEventListener('load', init, { once: true });
})();