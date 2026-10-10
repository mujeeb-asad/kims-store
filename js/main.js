import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const MODEL_URL = 'assets/kims.glb';
const POINTS_URL = 'assets/points.glb';                  // dense cloud, ~1.3M points
const POINTS_PREVIEW_URL = 'assets/points-preview.glb';  // coarse version shown while the full one loads
const POINT_SIZE = 0.045;   // world units; a bit above the ~3 cm spacing so close surfaces read solid
const POINT_MIN_PX = 1.5;   // keep far-away points visible in the overview
const CAMERAS_URL = 'assets/cameras.json';
const OVERVIEW_FOV = 45;
const PHOTO_DEPTH = 1;       // the photo plane sits this far in front of its camera
const MARKER_SIZE = 0.32;    // depth of the frustum markers, in model units

const $ = (s) => document.querySelector(s);
const body = document.body;
const canvas = $('#scene');
const ui = {
  status: $('#load-status .status-text'),
  retro: $('#retro'),
  retroBar: $('#retro-bar'),
  retroPct: $('#retro-pct'),
  retroBytes: $('#retro-bytes'),
  retroLine: $('#retro-line'),
  retroHead: $('#retro-head'),
  reprBtns: [...document.querySelectorAll('.repr-btn')],
  reprWrap: $('#repr-wrap'),
  reprLabels: [...document.querySelectorAll('.repr-drawer span')],
  shotNum: $('#shot-num'),
  prev: $('#prev'),
  next: $('#next'),
  lookLock: $('#look-lock'),
  lookNote: $('#look-note'),
  lookBtns: [...document.querySelectorAll('.seg-btn')],
  shotTotal: $('#shot-total'),
  compare: $('#compare'),
  tooltip: $('#tooltip'),
  modes: [...document.querySelectorAll('.mode')],
  pill: $('.mode-pill'),
};

const pad = (n) => String(n).padStart(2, '0');
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeOutBack = (t) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2);
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/* ------------------------------------------------------------------ renderer */

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(OVERVIEW_FOV, 1, 0.02, 600);
const controls = new OrbitControls(camera, canvas);
controls.enabled = false;
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 1;
controls.maxDistance = 120;

/* ------------------------------------------------------------------ tweens */

const tweens = new Set();
function tween(ms, onUpdate, ease = easeInOutCubic) {
  let entry;
  const promise = new Promise((resolve) => {
    entry = { t0: performance.now(), ms, onUpdate, ease, resolve };
    tweens.add(entry);
  });
  promise.cancel = () => { if (tweens.delete(entry)) entry.resolve(false); };
  return promise;
}
function runTweens(now) {
  for (const tw of tweens) {
    const p = clamp((now - tw.t0) / tw.ms, 0, 1);
    tw.onUpdate(tw.ease(p));
    if (p >= 1) { tweens.delete(tw); tw.resolve(true); }
  }
}

/* ------------------------------------------------------------------ data */

const state = {
  view: 'welcome',      // welcome | tour | overview
  shot: -1,             // shot we are at / flying to, -1 when free
  lastShot: 0,
  ready: false,
  pending: null,        // action queued while the model downloads
  flight: null,
  compare: false,
  lastOverview: null,   // where the visitor left the orbit camera
};

let data;
try {
  const res = await fetch(CAMERAS_URL);
  if (!res.ok) throw new Error(res.status);
  data = await res.json();
} catch (err) {
  body.classList.add('model-error');
  ui.status.textContent = location.protocol === 'file:'
    ? 'Open this page through a local web server (see README).'
    : 'Could not load camera data.';
  throw err;
}

const TAN = data.tanHalfFov;
const A = data.sceneRotation;
const sceneRotation = new THREE.Matrix4().set(A[0], A[1], A[2], 0, A[3], A[4], A[5], 0, A[6], A[7], A[8], 0, 0, 0, 0, 1);

const shots = data.shots.map((s) => {
  const [x, y, z] = s.basis.map((v) => new THREE.Vector3(...v));
  return {
    id: s.id,
    photo: s.photo,
    thumb: s.thumb,
    position: new THREE.Vector3(...s.position),
    quaternion: new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z)),
    right: x,
  };
});
// Tour order runs left to right as seen by the cameras, whatever the file numbering.
{
  const right = new THREE.Vector3();
  shots.forEach((s) => right.add(s.right));
  const sweep = shots[shots.length - 1].position.clone().sub(shots[0].position).dot(right);
  if (sweep < 0) shots.reverse();
}
const N = shots.length;
ui.shotTotal.textContent = pad(N);

// Store layout: frame the camera path plus the points the cameras look at (~4.5 units ahead),
// so the overview shows the shelves and not just the aisle.
const storeLayout = (() => {
  const meanFwd = new THREE.Vector3();
  const pts = [];
  for (const s of shots) {
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(s.quaternion);
    meanFwd.add(fwd);
    pts.push(s.position, s.position.clone().addScaledVector(fwd, 4.5));
  }
  const center = new THREE.Vector3();
  pts.forEach((p) => center.add(p));
  center.divideScalar(pts.length);
  let xx = 0, xz = 0, zz = 0;
  for (const p of pts) {
    const dx = p.x - center.x, dz = p.z - center.z;
    xx += dx * dx; xz += dx * dz; zz += dz * dz;
  }
  const angle = 0.5 * Math.atan2(2 * xz, xx - zz);
  const long = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
  const side = new THREE.Vector3(-long.z, 0, long.x);
  // look from behind the cameras so the shelf fronts face the viewer
  if (side.dot(meanFwd) > 0) side.negate();
  let halfLong = 0, halfSide = 0;
  for (const p of pts) {
    const d = p.clone().sub(center);
    halfLong = Math.max(halfLong, Math.abs(d.dot(long)));
    halfSide = Math.max(halfSide, Math.abs(d.dot(side)));
  }
  return { center, long, side, halfLong: halfLong + 1, halfSide: halfSide + 1 };
})();
const storeCenter = storeLayout.center;

/* ------------------------------------------------------------------ camera poses */

function lookQuat(pos, target) {
  const m = new THREE.Matrix4().lookAt(pos, target, new THREE.Vector3(0, 1, 0));
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

// Field of view that keeps the photo's frustum inside the viewport with a margin,
// so the mesh stays visible around it.
function shotFov() {
  const aspect = window.innerWidth / window.innerHeight;
  const kY = window.innerWidth < 560 ? 0.7 : 0.76;
  const kX = 0.92;
  const t = Math.max(TAN.y / kY, TAN.x / (aspect * kX));
  return THREE.MathUtils.radToDeg(2 * Math.atan(t));
}

function defaultOverview() {
  const { side, halfLong, halfSide } = storeLayout;
  const aspect = window.innerWidth / window.innerHeight;
  const tanV = Math.tan(THREE.MathUtils.degToRad(OVERVIEW_FOV / 2));
  const dist = Math.max(halfLong / (tanV * aspect), halfSide / tanV) * 1.25;
  const elev = THREE.MathUtils.degToRad(58);
  const dir = side.clone().multiplyScalar(Math.cos(elev)).add(new THREE.Vector3(0, Math.sin(elev), 0));
  return { pos: storeCenter.clone().addScaledVector(dir, dist), target: storeCenter.clone() };
}

/* ------------------------------------------------------------------ scene content */

const modelRoot = new THREE.Group();
modelRoot.quaternion.setFromRotationMatrix(sceneRotation);
scene.add(modelRoot);

// camera markers + tour path
const markerGroup = new THREE.Group();
scene.add(markerGroup);
const markerLineMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.9, depthTest: false });
const markerDotMat = new THREE.MeshBasicMaterial({ transparent: true, depthTest: false });
const markerHotLineMat = new THREE.LineBasicMaterial({ depthTest: false });
const markerHotDotMat = new THREE.MeshBasicMaterial({ depthTest: false });
const pathMat = new THREE.LineDashedMaterial({ dashSize: 0.25, gapSize: 0.18, transparent: true, opacity: 0.5, depthTest: false });

const frustumGeo = (() => {
  const s = MARKER_SIZE, w = TAN.x * s, h = TAN.y * s;
  const c = [[-w, -h], [w, -h], [w, h], [-w, h]];
  const pts = [];
  for (let i = 0; i < 4; i++) {
    pts.push(0, 0, 0, c[i][0], c[i][1], -s);
    pts.push(c[i][0], c[i][1], -s, c[(i + 1) % 4][0], c[(i + 1) % 4][1], -s);
  }
  // little "up" tick on the top edge
  pts.push(-w * 0.35, h, -s, 0, h * 1.35, -s, 0, h * 1.35, -s, w * 0.35, h, -s);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return g;
})();
const dotGeo = new THREE.SphereGeometry(0.05, 12, 8);

const markers = shots.map((s) => {
  const g = new THREE.Group();
  g.position.copy(s.position);
  g.quaternion.copy(s.quaternion);
  const lines = new THREE.LineSegments(frustumGeo, markerLineMat);
  const dot = new THREE.Mesh(dotGeo, markerDotMat);
  lines.renderOrder = dot.renderOrder = 5;
  g.add(lines, dot);
  markerGroup.add(g);
  return { group: g, lines, dot };
});

const pathLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(shots.map((s) => s.position)), pathMat);
pathLine.computeLineDistances();
pathLine.renderOrder = 4;
markerGroup.add(pathLine);

// photo overlay: a plane filling exactly the shot's frustum at PHOTO_DEPTH
const photoAnchor = new THREE.Group();
scene.add(photoAnchor);
const photoMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthTest: false, depthWrite: false, toneMapped: false });
const photoPlane = new THREE.Mesh(new THREE.PlaneGeometry(2 * TAN.x * PHOTO_DEPTH, 2 * TAN.y * PHOTO_DEPTH), photoMat);
photoPlane.position.z = -PHOTO_DEPTH;
photoPlane.renderOrder = 10;
photoPlane.visible = false;
photoAnchor.add(photoPlane);

const bracketMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0, depthTest: false });
const brackets = (() => {
  const w = TAN.x * PHOTO_DEPTH * 1.025, h = TAN.y * PHOTO_DEPTH * 1.02, l = Math.min(w, h) * 0.12;
  const pts = [];
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    pts.push(sx * w, sy * h, 0, sx * (w - l), sy * h, 0);
    pts.push(sx * w, sy * h, 0, sx * w, sy * (h - l), 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const seg = new THREE.LineSegments(g, bracketMat);
  seg.renderOrder = 11;
  return seg;
})();
photoPlane.add(brackets);

function applyThemeColors() {
  const accent = new THREE.Color(cssVar('--accent'));
  const fg = new THREE.Color(cssVar('--fg'));
  const muted = new THREE.Color(cssVar('--muted'));
  markerLineMat.color.copy(accent);
  markerDotMat.color.copy(accent);
  markerHotLineMat.color.copy(fg);
  markerHotDotMat.color.copy(fg);
  pathMat.color.copy(muted);
  bracketMat.color.copy(accent);
}
applyThemeColors();

/* ------------------------------------------------------------------ photos */

const texLoader = new THREE.TextureLoader();
const texCache = new Map();   // shot index -> Promise<Texture|null>
let shownTexIndex = -1;

function photoTexture(i) {
  if (!texCache.has(i)) {
    texCache.set(i, new Promise((resolve) => {
      texLoader.load(shots[i].photo, (t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = renderer.capabilities.getMaxAnisotropy();
        resolve(t);
      }, undefined, () => resolve(null));
    }));
  }
  return texCache.get(i);
}

// keep the current shot, its neighbours and whatever is on screen; free the rest
function prunePhotos(center) {
  const keep = new Set([center - 1, center, center + 1, shownTexIndex]);
  for (const [i, p] of texCache) {
    if (!keep.has(i)) { texCache.delete(i); p.then((t) => t && t.dispose()); }
  }
}

let photoTween = null;
function photoOpacity() { return state.compare ? 0.45 : 1; }

function showPhoto(i, tex) {
  photoTween?.cancel();
  shownTexIndex = i;
  photoAnchor.position.copy(shots[i].position);
  photoAnchor.quaternion.copy(shots[i].quaternion);
  photoMat.map = tex;
  photoMat.needsUpdate = true;
  photoPlane.visible = true;
  const target = photoOpacity();
  photoTween = tween(620, (e) => {
    const s = 0.9 + 0.1 * easeOutBack(e);
    photoPlane.scale.set(s, s, 1);
    photoMat.opacity = target * clamp(e * 1.8, 0, 1);
    bracketMat.opacity = clamp(e * 1.5, 0, 1);
  }, (t) => t);
}

function hidePhoto() {
  if (!photoPlane.visible) return;
  photoTween?.cancel();
  const o0 = photoMat.opacity, b0 = bracketMat.opacity;
  photoTween = tween(200, (e) => {
    photoMat.opacity = o0 * (1 - e);
    bracketMat.opacity = b0 * (1 - e);
  }, easeOutCubic);
  photoTween.then((done) => { if (done) { photoPlane.visible = false; shownTexIndex = -1; } });
}

function setCompare(on) {
  state.compare = on;
  ui.compare.setAttribute('aria-pressed', String(on));
  if (photoPlane.visible) {
    const o0 = photoMat.opacity, o1 = photoOpacity();
    tween(250, (e) => { photoMat.opacity = o0 + (o1 - o0) * e; });
  }
}

/* ------------------------------------------------------------------ flights */

function flyTo(pos, quat, fov) {
  state.flight?.cancel();
  controls.enabled = false;
  body.classList.add('flying');
  const p0 = camera.position.clone(), q0 = camera.quaternion.clone(), f0 = camera.fov;
  const dist = p0.distanceTo(pos);
  const lift = dist > 3 ? Math.min((dist - 3) * 0.12, 1.5) : 0;   // gentle arc on long jumps
  const ms = clamp(900 + dist * 110, 1000, 2600);
  const flight = tween(ms, (e) => {
    camera.position.lerpVectors(p0, pos, e);
    camera.position.y += Math.sin(Math.PI * e) * lift;
    camera.quaternion.slerpQuaternions(q0, quat, e);
    camera.fov = f0 + (fov - f0) * e;
    camera.updateProjectionMatrix();
  });
  state.flight = flight;
  return flight.then((done) => {
    if (done) body.classList.remove('flying');
    return done;
  });
}

async function goToShot(i) {
  if (i < 0 || i >= N) return;   // no wrap-around: the tour ends at the outermost shots
  if (state.shot === -1 && state.view === 'overview' && controls.enabled) {
    state.lastOverview = { pos: camera.position.clone(), target: controls.target.clone() };
  }
  // being at a photo is the tour, however you got there (arrows, a camera in the overview, a swipe)
  if (state.view !== 'tour') setView('tour');
  state.shot = i;
  state.lastShot = i;
  body.classList.add('in-shot');
  markerGroup.visible = false;
  setHover(-1);
  ui.shotNum.textContent = pad(i + 1);
  ui.prev.disabled = i === 0;
  ui.next.disabled = i === N - 1;
  resetLook(true);
  hidePhoto();

  const texPromise = photoTexture(i);
  if (i + 1 < N) photoTexture(i + 1);
  if (i > 0) photoTexture(i - 1);
  prunePhotos(i);

  const s = shots[i];
  const arrived = await flyTo(s.position, s.quaternion, shotFov());
  if (!arrived) return;
  showReprLabels(1000);
  const tex = await texPromise;
  if (tex && state.shot === i && !body.classList.contains('flying')) showPhoto(i, tex);
}

async function enterOverview() {
  setView('overview');
  state.shot = -1;
  body.classList.remove('in-shot');
  setLookMode('locked');
  resetLook(true);
  hidePhoto();
  markerGroup.visible = true;
  const { pos, target } = state.lastOverview || defaultOverview();
  const arrived = await flyTo(pos, lookQuat(pos, target), OVERVIEW_FOV);
  if (!arrived) return;
  controls.target.copy(target);
  controls.enabled = true;
  controls.update();
  showReprLabels(0);
}

function enterTour() {
  setView('tour');
  goToShot(state.shot >= 0 ? state.shot : state.lastShot);
}

/* ------------------------------------------------------------------ look-around */

// While unlocked, the camera stays on the shot's position and only turns, so the photo
// stays pinned where it belongs and the mesh continues past its edges.
const LOOK_MAX_YAW = THREE.MathUtils.degToRad(100);
const LOOK_MAX_PITCH = THREE.MathUtils.degToRad(55);
const look = {
  mode: 'locked',        // locked | drag | gyro
  yaw: 0, pitch: 0,      // current offsets from the shot's framing (radians)
  targetYaw: 0, targetPitch: 0,
  gyroBase: null,        // device yaw/pitch taken as "straight ahead" once the sensor settles
  gyroPrev: null,        // previous reading, for settling and glitch detection
  gyroSteady: 0,         // consecutive steady readings so far
  gyroSamples: 0,        // readings since (re)centring
  gyroLive: false,
};
let gyroToken = 0;
const lookEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const lookRot = new THREE.Quaternion();
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

function setLookTarget(yaw, pitch) {
  look.targetYaw = clamp(yaw, -LOOK_MAX_YAW, LOOK_MAX_YAW);
  look.targetPitch = clamp(pitch, -LOOK_MAX_PITCH, LOOK_MAX_PITCH);
}

function resetLook(instant) {
  setLookTarget(0, 0);
  resetGyroBaseline();
  if (instant) { look.yaw = 0; look.pitch = 0; }
}

function setLookNote(text, warn = false) {
  ui.lookNote.textContent = text;
  ui.lookNote.classList.toggle('warn', warn);
}

function setLookMode(mode) {
  if (mode !== 'gyro') stopGyro();
  look.mode = mode;
  const unlocked = mode !== 'locked';
  body.classList.toggle('look-unlocked', unlocked);
  body.classList.toggle('look-drag', mode === 'drag');
  ui.lookLock.setAttribute('aria-pressed', String(unlocked));
  ui.lookLock.title = unlocked ? 'Lock the camera back to the photo (L)' : 'Unlock the camera to look around (L)';
  ui.lookBtns.forEach((b) => {
    const on = b.dataset.look === mode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
  });
  if (!unlocked) resetLook(false);
  if (mode === 'drag') setLookNote('Drag to look around');
}

// three.js camera orientation from DeviceOrientation angles (same maths as the old
// DeviceOrientationControls): camera looks out of the back of the phone, world Y up.
const devEuler = new THREE.Euler();
const devQuat = new THREE.Quaternion();
const devTmp = new THREE.Quaternion();
const devFix = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
const zAxis = new THREE.Vector3(0, 0, 1);
const D2R = THREE.MathUtils.DEG2RAD;

const devLook = new THREE.Euler(0, 0, 0, 'YXZ');
// Sensors often send a few unsettled readings right after they start (notably on iOS after the
// permission prompt). Taking "straight ahead" from one of those made the view swing off on its own.
const GYRO_STEADY = 1.5 * D2R;      // readings closer than this count as steady
const GYRO_SETTLE = 4;              // steady readings in a row before the baseline is taken
const GYRO_SETTLE_MAX = 30;         // ...but never wait longer than this many readings
const GYRO_GLITCH = 20 * D2R;       // a jump this large between two readings is a sensor reset, not a hand

function resetGyroBaseline() {
  look.gyroBase = null;
  look.gyroPrev = null;
  look.gyroSteady = 0;
  look.gyroSamples = 0;
}

function onOrientation(e) {
  if (e.alpha == null || e.beta == null || e.gamma == null) return;
  look.gyroLive = true;
  if (look.mode !== 'gyro' || state.shot < 0 || body.classList.contains('flying')) { resetGyroBaseline(); return; }
  const orient = (screen.orientation?.angle ?? window.orientation ?? 0) * D2R;
  devEuler.set(e.beta * D2R, e.alpha * D2R, -e.gamma * D2R, 'YXZ');
  devQuat.setFromEuler(devEuler).multiply(devFix).multiply(devTmp.setFromAxisAngle(zAxis, -orient));
  devLook.setFromQuaternion(devQuat, 'YXZ');
  const yaw = devLook.y, pitch = devLook.x;
  const prev = look.gyroPrev;
  look.gyroPrev = { yaw, pitch };
  const dYaw = prev ? wrapAngle(yaw - prev.yaw) : 0;
  const dPitch = prev ? pitch - prev.pitch : 0;

  if (!look.gyroBase) {
    look.gyroSamples++;
    const steady = prev && Math.abs(dYaw) < GYRO_STEADY && Math.abs(dPitch) < GYRO_STEADY;
    look.gyroSteady = steady ? look.gyroSteady + 1 : 0;
    if (look.gyroSteady < GYRO_SETTLE && look.gyroSamples < GYRO_SETTLE_MAX) return;
    look.gyroBase = { yaw, pitch, fromYaw: look.targetYaw, fromPitch: look.targetPitch };
  } else if (Math.abs(dYaw) > GYRO_GLITCH || Math.abs(dPitch) > GYRO_GLITCH) {
    // absorb the jump into the baseline so the view doesn't spin
    look.gyroBase.yaw = wrapAngle(look.gyroBase.yaw + dYaw);
    look.gyroBase.pitch += dPitch;
  }
  const b = look.gyroBase;
  setLookTarget(b.fromYaw + wrapAngle(yaw - b.yaw), b.fromPitch + (pitch - b.pitch));
}

async function startGyro() {
  const token = ++gyroToken;
  const fail = (msg) => { if (token !== gyroToken) return; setLookMode('drag'); setLookNote(msg, true); };
  if (!('DeviceOrientationEvent' in window)) return fail('This browser has no motion sensor access. Using drag instead.');
  if (!window.isSecureContext) return fail('Gyro needs the https version of the site. Using drag instead.');
  // iOS 13+: must be asked from the tap itself, which is why this runs straight from the click handler
  if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    let answer = 'denied';
    try { answer = await DeviceOrientationEvent.requestPermission(); } catch (err) { /* treated as denied */ }
    if (answer !== 'granted') return fail('Motion access was not allowed. Using drag instead.');
  }
  if (token !== gyroToken) return;
  resetGyroBaseline();
  look.gyroLive = false;
  window.addEventListener('deviceorientation', onOrientation);
  setLookNote('Move your phone to look around');
  setTimeout(() => {
    if (token === gyroToken && look.mode === 'gyro' && !look.gyroLive) fail('No motion sensor found on this device. Using drag instead.');
  }, 1500);
}

function stopGyro() {
  gyroToken++;
  window.removeEventListener('deviceorientation', onOrientation);
}

function applyLook(dt) {
  const k = 1 - Math.exp(-dt * (look.mode === 'gyro' ? 12 : 16));
  look.yaw += (look.targetYaw - look.yaw) * k;
  look.pitch += (look.targetPitch - look.pitch) * k;
  lookEuler.set(look.pitch, look.yaw, 0, 'YXZ');
  camera.quaternion.copy(shots[state.shot].quaternion).multiply(lookRot.setFromEuler(lookEuler));
}

ui.lookLock.addEventListener('click', () => setLookMode(look.mode === 'locked' ? 'drag' : 'locked'));
ui.lookBtns.forEach((b) => b.addEventListener('click', () => {
  const mode = b.dataset.look;
  if (mode === look.mode) return;
  setLookMode(mode);
  if (mode === 'gyro') {
    resetLook(false);   // start from the photo's framing, not wherever a drag left the view
    startGyro();
  }
}));
$('#look-recenter').addEventListener('click', () => resetLook(false));

/* ------------------------------------------------------------------ view + mode switch */

function setView(view) {
  state.view = view;
  body.dataset.view = view;
  ui.modes.forEach((b) => b.classList.toggle('active', b.dataset.mode === view));
  const active = ui.modes.find((b) => b.dataset.mode === view);
  if (active) {
    ui.pill.style.width = `${active.offsetWidth}px`;
    ui.pill.style.transform = `translateX(${active.offsetLeft - 4}px)`;
  }
}

// Run now if the model is ready, otherwise show the retro loader and run it on load.
function whenReady(action) {
  if (state.ready) { action(); return; }
  state.pending = action;
  showRetro();
}

$('#start-tour').addEventListener('click', () => { setView('tour'); whenReady(enterTour); });
$('#start-overview').addEventListener('click', () => { setView('overview'); whenReady(enterOverview); });
ui.modes.forEach((b) => b.addEventListener('click', () => {
  const mode = b.dataset.mode;
  setView(mode);
  whenReady(mode === 'tour' ? enterTour : enterOverview);
}));
$('#prev').addEventListener('click', () => goToShot(state.shot - 1));
$('#next').addEventListener('click', () => goToShot(state.shot + 1));
$('#exit-shot').addEventListener('click', () => enterOverview());
ui.compare.addEventListener('click', () => setCompare(!state.compare));

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || !state.ready || state.view === 'welcome') return;
  const inShot = state.shot >= 0;
  if (e.key === 'Escape' && help.open) { setHelp(false); e.preventDefault(); return; }
  if (e.key === 'h' || e.key === 'H' || e.key === '?') { setHelp(!help.open); e.preventDefault(); return; }
  if (e.key === 'ArrowRight') { inShot ? goToShot(state.shot + 1) : (setView('tour'), goToShot(state.lastShot)); }
  else if (e.key === 'ArrowLeft') { inShot ? goToShot(state.shot - 1) : (setView('tour'), goToShot(state.lastShot)); }
  else if (e.key === 'Escape' && inShot) enterOverview();
  else if ((e.key === 'c' || e.key === 'C') && inShot) setCompare(!state.compare);
  else if ((e.key === 'l' || e.key === 'L') && inShot) setLookMode(look.mode === 'locked' ? 'drag' : 'locked');
  else if (e.key === 'p' || e.key === 'P') setRepresentation(repr.wanted === 'mesh' ? 'points' : 'mesh');
  else return;
  e.preventDefault();
});

/* ------------------------------------------------------------------ theme */

$('#theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('kims-theme', next); } catch (e) { /* storage blocked */ }
  applyThemeColors();
});

/* ------------------------------------------------------------------ picking, hover, swipe */

const proj = new THREE.Vector3();
let hovered = -1;

// nearest marker on screen, so small markers stay easy to hit (especially on touch)
function pickAt(x, y, radius = 28) {
  if (!markerGroup.visible) return -1;
  let best = -1, bestD = radius;
  for (let i = 0; i < N; i++) {
    const p = proj.copy(shots[i].position).project(camera);
    if (p.z > 1) continue;  // behind the camera
    const d = Math.hypot((p.x + 1) / 2 * window.innerWidth - x, (1 - p.y) / 2 * window.innerHeight - y);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

function setHover(i, x, y) {
  if (i !== hovered) {
    if (hovered >= 0) {
      const m = markers[hovered];
      m.lines.material = markerLineMat; m.dot.material = markerDotMat; m.group.scale.setScalar(1);
    }
    hovered = i;
    if (i >= 0) {
      const m = markers[i];
      m.lines.material = markerHotLineMat; m.dot.material = markerHotDotMat; m.group.scale.setScalar(1.4);
      ui.tooltip.querySelector('img').src = shots[i].thumb;
      ui.tooltip.querySelector('span').textContent = `Shot ${pad(i + 1)}`;
    }
    ui.tooltip.hidden = i < 0;
    body.classList.toggle('hovering-marker', i >= 0);
  }
  if (i >= 0 && x !== undefined) {
    ui.tooltip.style.left = `${Math.min(x, window.innerWidth - 130)}px`;
    ui.tooltip.style.top = `${Math.min(y, window.innerHeight - 180)}px`;
  }
}

const interactive = () => state.ready && state.view !== 'welcome';
let down = null;

const lookDragging = () => state.shot >= 0 && look.mode === 'drag' && !body.classList.contains('flying');

canvas.addEventListener('pointermove', (e) => {
  if (down && lookDragging()) {
    // grab-the-world: the scene follows the finger, at roughly one screen per field of view
    const k = THREE.MathUtils.degToRad(camera.fov) / window.innerHeight;
    setLookTarget(look.targetYaw + (e.clientX - down.lx) * k, look.targetPitch + (e.clientY - down.ly) * k);
    down.lx = e.clientX; down.ly = e.clientY;
    return;
  }
  if (!interactive() || e.pointerType !== 'mouse' || down || state.shot >= 0) return;
  setHover(pickAt(e.clientX, e.clientY), e.clientX, e.clientY);
});
canvas.addEventListener('pointerleave', () => setHover(-1));
canvas.addEventListener('pointerdown', (e) => {
  down = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, t: performance.now() };
  if (lookDragging()) { canvas.setPointerCapture(e.pointerId); body.classList.add('dragging'); }
});
canvas.addEventListener('pointercancel', () => { down = null; body.classList.remove('dragging'); });
canvas.addEventListener('pointerup', (e) => {
  const d = down; down = null;
  body.classList.remove('dragging');
  if (!d || !interactive()) return;
  const dx = e.clientX - d.x, dy = e.clientY - d.y, dt = performance.now() - d.t;
  if (state.shot >= 0) {
    if (look.mode === 'drag') return;   // dragging looks around instead of changing shots
    // swipe between shots
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5 && dt < 800) goToShot(state.shot + (dx < 0 ? 1 : -1));
    return;
  }
  if (Math.hypot(dx, dy) < 6 && dt < 500) {
    const i = pickAt(e.clientX, e.clientY, e.pointerType === 'mouse' ? 28 : 40);
    if (i >= 0) goToShot(i);
  }
});

/* ------------------------------------------------------------------ loading */

let retroShownAt = 0;
function showRetro() {
  if (!ui.retro.hidden) return;
  ui.retro.classList.remove('leaving');
  ui.retro.hidden = false;
  retroShownAt = performance.now();
}
function hideRetro() {
  if (ui.retro.hidden) return Promise.resolve();
  // keep it up long enough to be read, then let it pop away
  const wait = Math.max(0, 700 - (performance.now() - retroShownAt));
  return new Promise((resolve) => setTimeout(() => {
    ui.retro.classList.add('leaving');
    setTimeout(() => { ui.retro.hidden = true; resolve(); }, 350);
  }, wait));
}

function resetRetro(head, line) {
  ui.retroHead.textContent = head;
  ui.retroLine.textContent = line;
  ui.retroBar.textContent = `[${'.'.repeat(20)}]`;
  ui.retroPct.textContent = '00%';
  ui.retroBytes.textContent = '';
}

function setRetroProgress(p, loaded) {
  const pct = Math.round(p * 100);
  const filled = Math.round(p * 20);
  ui.retroBar.textContent = `[${'#'.repeat(filled)}${'.'.repeat(20 - filled)}]`;
  ui.retroPct.textContent = `${pad(Math.min(pct, 99))}%`;
  if (loaded) ui.retroBytes.textContent = `${(loaded / 1e6).toFixed(1)} MB`;
}

// hosts that gzip on the fly don't send a usable length; ease towards 95% instead
const progressOf = (xhr, typical) => (xhr.lengthComputable && xhr.total ? xhr.loaded / xhr.total : 0.95 * (1 - Math.exp(-xhr.loaded / typical)));

function setProgress(p, loaded) {
  setRetroProgress(p, loaded);
  ui.status.textContent = `Building the store in the background · ${Math.round(p * 100)}%`;
}

function welcomePose(t) {
  const { pos } = defaultOverview();
  const off = pos.clone().sub(storeCenter);
  off.applyAxisAngle(new THREE.Vector3(0, 1, 0), t * 0.06);
  const p = storeCenter.clone().add(off.multiplyScalar(0.9));
  return { pos: p, quat: lookQuat(p, storeCenter) };
}

const meshMaterials = [];   // faded out/in when switching to the point cloud

function onModelLoaded(gltf) {
  ui.retroLine.textContent = '> uploading textures';
  const model = gltf.scene;
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  model.traverse((o) => {
    if (!o.isMesh) return;
    // Photogrammetry texture already contains the lighting: render it unlit.
    // FrontSide lets the overview see into the store through the far walls.
    const old = o.material;
    if (old.map) { old.map.anisotropy = maxAniso; renderer.initTexture(old.map); }
    o.material = new THREE.MeshBasicMaterial({ map: old.map, side: THREE.FrontSide });
    meshMaterials.push(o.material);
    old.dispose();
  });
  modelRoot.add(model);
  renderer.compile(scene, camera);

  state.ready = true;
  setProgress(1);
  ui.retroPct.textContent = '100%';
  ui.retroLine.textContent = '> ready. entering store';
  ui.status.textContent = `Model ready · ${N} shots`;
  body.classList.add('model-ready');

  const pending = state.pending;
  state.pending = null;
  if (pending) {
    // start from the establishing shot, then fly in once the loader pops away
    const w = welcomePose(0);
    camera.position.copy(w.pos); camera.quaternion.copy(w.quat);
    hideRetro().then(pending);
  }
  prefetchPointsWhenIdle();
}

function onModelError(err) {
  console.error(err);
  body.classList.add('model-error');
  ui.status.textContent = 'Could not load the 3D model.';
  ui.retroLine.textContent = '> ERROR: model failed to load';
  ui.retroBar.textContent = '[!!!!!!!!!!!!!!!!!!!!]';
}

const gltfLoader = new GLTFLoader();
gltfLoader.setMeshoptDecoder(MeshoptDecoder);
gltfLoader.load(MODEL_URL, onModelLoaded, (xhr) => {
  const p = progressOf(xhr, 4e6);
  setProgress(Math.min(p, 0.99), xhr.loaded);
  if (p >= 0.99) ui.retroLine.textContent = '> decoding geometry';
}, onModelError);

/* ------------------------------------------------------------------ point cloud */

// The dense cloud is its own view of the store, not an overlay: the switch crossfades between
// mesh and points and never touches the camera, so a locked shot, an orbit or a look-around
// carries straight over. A coarse preview loads first; the full cloud replaces it quietly.
const pointsRoot = new THREE.Group();
pointsRoot.visible = false;
scene.add(pointsRoot);

const pointsMat = new THREE.PointsMaterial({ size: POINT_SIZE, sizeAttenuation: true, vertexColors: true, transparent: true, opacity: 0 });
pointsMat.onBeforeCompile = (shader) => {
  shader.vertexShader = shader.vertexShader
    .replace('#include <color_vertex>', `#include <color_vertex>
      // Metashape writes sRGB colours but glTF vertex colours are linear; decode them here,
      // otherwise the output conversion brightens them a second time (the washed-out look).
      vColor.rgb = mix(vColor.rgb / 12.92, pow((vColor.rgb + 0.055) / 1.055, vec3(2.4)), step(0.04045, vColor.rgb));`)
    .replace('#include <logdepthbuf_vertex>', `gl_PointSize = max(gl_PointSize, ${POINT_MIN_PX.toFixed(1)});
      #include <logdepthbuf_vertex>`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
      vec2 pc = gl_PointCoord - 0.5;
      if (dot(pc, pc) > 0.25) discard;   // round dots instead of squares`);
};

const points = { level: 0, onProgress: null };   // level: 0 none, 1 preview, 2 full
let pointsPromise = null;

const loadGLB = (url, onProgress) => new Promise((resolve, reject) => gltfLoader.load(url, resolve, onProgress, reject));

function adoptPoints(gltf, level) {
  if (level <= points.level) return;
  gltf.scene.traverse((o) => {
    if (o.isPoints) { o.material.dispose(); o.material = pointsMat; }
  });
  const old = [...pointsRoot.children];
  pointsRoot.add(gltf.scene);
  old.forEach((o) => { pointsRoot.remove(o); o.traverse((c) => c.geometry?.dispose()); });
  points.level = level;
}

// Resolves once something is showable (the preview); the full cloud follows in the background.
function ensurePoints() {
  if (!pointsPromise) {
    pointsPromise = loadGLB(POINTS_PREVIEW_URL, (xhr) => points.onProgress?.(xhr)).then((g) => {
      adoptPoints(g, 1);
      loadGLB(POINTS_URL).then((f) => adoptPoints(f, 2)).catch((err) => console.warn('Full point cloud failed to load', err));
    });
    pointsPromise.catch(() => { pointsPromise = null; });   // let a later switch retry
  }
  return pointsPromise;
}

// Fetch the cloud once the visitor has settled in, so the switch is usually instant.
// Skipped on data saver or very slow connections; those visitors load it only on demand.
function prefetchPointsWhenIdle() {
  const c = navigator.connection;
  if (c && (c.saveData || /2g$/.test(c.effectiveType || ''))) return;
  const go = () => ensurePoints().catch(() => {});
  setTimeout(() => (window.requestIdleCallback ? requestIdleCallback(go, { timeout: 5000 }) : go()), 5000);
}

const repr = { current: 'mesh', wanted: 'mesh', tween: null };

function setReprUI(mode, loading = false) {
  ui.reprBtns.forEach((b) => {
    const on = b.dataset.repr === mode;
    b.classList.toggle('active', on);
    b.classList.toggle('loading', on && loading);
    b.setAttribute('aria-checked', String(on));
  });
  ui.reprLabels.forEach((l) => l.classList.toggle('current', l.dataset.for === mode));
}

function crossfadeTo(mode) {
  if (mode === repr.current) return;
  repr.current = mode;
  const toPoints = mode === 'points';
  repr.tween?.cancel();
  [...meshMaterials, pointsMat].forEach((m) => { if (!m.transparent) { m.transparent = true; m.needsUpdate = true; } });
  modelRoot.visible = true;
  pointsRoot.visible = true;
  const m0 = meshMaterials[0]?.opacity ?? 1, p0 = pointsMat.opacity;
  const m1 = toPoints ? 0 : 1, p1 = toPoints ? 1 : 0;
  repr.tween = tween(650, (e) => {
    meshMaterials.forEach((m) => { m.opacity = m0 + (m1 - m0) * e; });
    pointsMat.opacity = p0 + (p1 - p0) * e;
  });
  repr.tween.then((done) => {
    if (!done) return;
    modelRoot.visible = !toPoints;
    pointsRoot.visible = toPoints;
    (toPoints ? [pointsMat] : meshMaterials).forEach((m) => { m.transparent = false; m.needsUpdate = true; });
  });
}

async function setRepresentation(mode) {
  if (!state.ready || mode === repr.wanted) return;
  repr.wanted = mode;
  setReprUI(mode);
  if (mode === 'mesh') {
    if (!ui.retro.hidden) hideRetro();   // changed their mind while the points were loading
    crossfadeTo('mesh');
    return;
  }
  if (points.level === 0) {
    // first time: keep the mesh up and usable, float the retro loader while the points arrive
    setReprUI('points', true);
    resetRetro('SCATTERING POINTS', '> fetching point cloud');
    points.onProgress = (xhr) => {
      const p = progressOf(xhr, 1e6);
      setRetroProgress(Math.min(p, 0.99), xhr.loaded);
      if (p >= 0.99) ui.retroLine.textContent = '> decoding points';
    };
    showRetro();
    try {
      await ensurePoints();
    } catch (err) {
      console.error(err);
      ui.retroLine.textContent = '> ERROR: point cloud failed to load';
      ui.retroBar.textContent = `[${'!'.repeat(20)}]`;
      setTimeout(hideRetro, 1600);
      if (repr.wanted === 'points') { repr.wanted = 'mesh'; setReprUI('mesh'); }
      return;
    } finally {
      points.onProgress = null;
    }
    if (repr.wanted !== 'points') return;
    setRetroProgress(1);
    ui.retroPct.textContent = '100%';
    ui.retroLine.textContent = '> ready. switching view';
    setReprUI('points');
    await hideRetro();
    if (repr.wanted !== 'points') return;
  }
  crossfadeTo('points');
}

ui.reprBtns.forEach((b) => b.addEventListener('click', () => setRepresentation(b.dataset.repr)));

// The full names slide out next to the Mesh / Points icons (timings live in the CSS):
//  - once per visit, when the camera first settles, held for a moment;
//  - whenever the mouse glides over the switch, for as long as it stays there;
//  - on a touch long-press, staying a little after the finger lifts.
const REPR_LABELS_HOLD = 2800;       // automatic showing: open -> start closing, ms
const REPR_LONG_PRESS = 450;         // ms a finger must rest on the switch
const REPR_AFTER_PRESS = 2000;       // ms the labels stay after a long-press ends
const reprLabels = { shown: false, timer: 0, hover: false, pressTimer: 0, longPressed: false };

function openReprLabels() {
  if (help.open) return;   // the help box next to the switch already names both modes
  clearTimeout(reprLabels.timer);
  ui.reprWrap.classList.add('labels-open');
}
function closeReprLabels(delay = 0) {
  clearTimeout(reprLabels.timer);
  reprLabels.timer = setTimeout(() => {
    if (!reprLabels.hover) ui.reprWrap.classList.remove('labels-open');
  }, delay);
}
function showReprLabels(delay) {
  if (reprLabels.shown) return;
  reprLabels.shown = true;
  setTimeout(() => { openReprLabels(); closeReprLabels(REPR_LABELS_HOLD); }, delay);
}

ui.reprWrap.addEventListener('pointerenter', (e) => {
  if (e.pointerType !== 'mouse') return;
  reprLabels.hover = true;
  openReprLabels();
});
ui.reprWrap.addEventListener('pointerleave', (e) => {
  if (e.pointerType !== 'mouse') return;
  reprLabels.hover = false;
  closeReprLabels(150);
});
ui.reprWrap.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse') return;
  reprLabels.longPressed = false;
  clearTimeout(reprLabels.pressTimer);
  reprLabels.pressTimer = setTimeout(() => { reprLabels.longPressed = true; openReprLabels(); }, REPR_LONG_PRESS);
});
for (const type of ['pointerup', 'pointercancel']) {
  ui.reprWrap.addEventListener(type, (e) => {
    if (e.pointerType === 'mouse') return;
    clearTimeout(reprLabels.pressTimer);
    if (reprLabels.longPressed) closeReprLabels(REPR_AFTER_PRESS);
  });
}
// a long-press only reveals the labels: swallow the click that follows it
ui.reprWrap.addEventListener('click', (e) => {
  if (!reprLabels.longPressed) return;
  reprLabels.longPressed = false;
  e.stopPropagation();
  e.preventDefault();
}, true);
ui.reprWrap.addEventListener('contextmenu', (e) => e.preventDefault());
ui.reprLabels.forEach((l) => l.addEventListener('click', () => setRepresentation(l.dataset.for)));

/* ------------------------------------------------------------------ help */

// One retro box per group of controls (top switch, side column, bottom bar), each joined by a
// line to a dashed outline around its group. The text follows what is on screen, and the page
// stays fully usable underneath: the overlay never takes pointer events.
const helpEls = {
  root: $('#help'),
  svg: $('#help-lines'),
  btn: $('#help-toggle'),
  boxes: { top: $('#help-top'), side: $('#help-side'), bottom: $('#help-bottom') },
};
const help = { open: false, raf: 0, content: '', geometry: '' };
const HELP_MARGIN = 12;   // boxes keep this far from the screen edge
const HELP_GAP = 22;      // length of the link between a box and its group
const HELP_PAD = 6;       // dashed outline's distance from the controls

function helpGroups() {
  const touch = window.matchMedia('(hover: none)').matches;
  const groups = {
    top: { title: 'VIEW', rows: [['Tour', 'step through the photos'], ['Overview', 'orbit the whole store']] },
    side: { title: 'DISPLAY', rows: [['Theme', 'light or dark'], ['Mesh', 'textured 3D surface'], ['Points', 'dense point cloud'], ['?', 'show or hide this help']] },
  };
  if (state.shot >= 0) {
    const swipes = look.mode !== 'drag';   // in Drag mode a swipe looks around instead
    const rows = [
      ['< >', `previous / next photo${swipes ? (touch ? ', or swipe' : ', or arrow keys') : ''}`],
      ['Compare', 'fade the photo to check the fit'],
      ['Overview', 'back out to the whole store'],
    ];
    if (look.mode === 'locked') {
      rows.push(['Nav', 'unlock to look around from here']);
    } else {
      rows.push(['Nav', 'lock back onto the photo'], ['Drag', 'look around by dragging'],
        ['Gyro', touch ? 'look around by moving your phone' : 'look around with a phone\'s motion sensor'],
        ['Recenter', 'return to the photo\'s framing']);
    }
    groups.bottom = { title: look.mode === 'locked' ? 'PHOTO' : 'PHOTO + LOOK AROUND', rows };
  } else if (state.view === 'overview') {
    groups.bottom = {
      title: 'MOVE',
      rows: [['Drag', 'orbit around the store'], [touch ? 'Pinch' : 'Scroll', 'zoom in and out'],
        [touch ? 'Tap' : 'Click', 'a pink camera to step into its photo']],
    };
  }
  return groups;
}

function helpTargets() {
  const union = (els) => {
    const r = { l: Infinity, t: Infinity, r: -Infinity, b: -Infinity };
    for (const el of els) {
      // layout size around the on-screen centre: a hover rotation or press scale on a button
      // must not make the outline (and everything placed from it) jump
      const q = el.getBoundingClientRect();
      const cx = (q.left + q.right) / 2, cy = (q.top + q.bottom) / 2, hw = el.offsetWidth / 2, hh = el.offsetHeight / 2;
      r.l = Math.min(r.l, cx - hw); r.t = Math.min(r.t, cy - hh); r.r = Math.max(r.r, cx + hw); r.b = Math.max(r.b, cy + hh);
    }
    return { l: r.l - HELP_PAD, t: r.t - HELP_PAD, r: r.r + HELP_PAD, b: r.b + HELP_PAD };
  };
  const t = { top: union([$('.modes')]), side: union([$('#theme-toggle'), $('.repr'), helpEls.btn]) };
  if (state.shot >= 0) t.bottom = union(look.mode === 'locked' ? [$('#shotbar')] : [$('#shotbar'), $('#look-menu')]);
  else if (state.view === 'overview') t.bottom = union([$('#hint')]);
  return t;
}

// Straight line where the box and its group overlap along one axis; an L out of the box's
// side when the group sits diagonally from it (the side box on narrow screens).
function helpLink(box, tgt) {
  const mid = (a, b) => (a + b) / 2;
  if (box.b <= tgt.t || box.t >= tgt.b) {
    const above = box.b <= tgt.t;
    const y0 = above ? box.b : box.t, y1 = above ? tgt.t : tgt.b;
    const lo = Math.max(box.l + 12, tgt.l + 6), hi = Math.min(box.r - 12, tgt.r - 6);
    if (lo <= hi) { const x = clamp(mid(tgt.l, tgt.r), lo, hi); return [[x, y0], [x, y1]]; }
    const x1 = clamp(mid(tgt.l, tgt.r), tgt.l + 6, tgt.r - 6);
    const ySide = above ? box.b - 16 : box.t + 16;
    return [[box.r <= tgt.l ? box.r : box.l, ySide], [x1, ySide], [x1, y1]];
  }
  const left = box.r <= tgt.l;
  const x0 = left ? box.r : box.l, x1 = left ? tgt.l : tgt.r;
  const lo = Math.max(box.t + 12, tgt.t + 6), hi = Math.min(box.b - 12, tgt.b - 6);
  if (lo <= hi) { const y = clamp(mid(tgt.t, tgt.b), lo, hi); return [[x0, y], [x1, y]]; }
  const y0 = clamp(mid(tgt.t, tgt.b), box.t + 12, box.b - 12), y1 = clamp(y0, tgt.t + 6, tgt.b - 6);
  return [[x0, y0], [mid(x0, x1), y0], [mid(x0, x1), y1], [x1, y1]];
}

function layoutHelp() {
  // 1. text: rebuild only when what is on screen changed
  const groups = helpGroups();
  const content = JSON.stringify(groups);
  if (content !== help.content) {
    help.content = content;
    for (const [key, box] of Object.entries(helpEls.boxes)) {
      const g = groups[key];
      box.hidden = !g;
      if (!g) continue;
      box.querySelector('.help-title').textContent = g.title;
      box.querySelector('dl').replaceChildren(...g.rows.flatMap(([k, v]) => {
        const dt = document.createElement('dt'), dd = document.createElement('dd');
        dt.textContent = k; dd.textContent = v;
        return [dt, dd];
      }));
    }
  }

  // 2. measure (all reads before any writes)
  const vw = window.innerWidth, vh = window.innerHeight;
  const tg = helpTargets();
  const size = {};
  for (const [key, box] of Object.entries(helpEls.boxes)) if (!box.hidden) size[key] = { w: box.offsetWidth, h: box.offsetHeight };
  const geometry = JSON.stringify([vw, vh, tg, size]);
  if (geometry === help.geometry) return;
  help.geometry = geometry;

  // 3. place the boxes: top one under the view switch, side one left of the column, bottom one above the bar
  const sideLimit = tg.side.l - HELP_GAP;                 // nothing may cross into the side column
  const maxW = { top: Math.min(310, sideLimit - 14 - HELP_MARGIN), side: Math.min(300, sideLimit - HELP_MARGIN), bottom: Math.min(380, vw - 2 * HELP_MARGIN) };
  const pos = {};
  pos.top = {
    x: clamp((tg.top.l + tg.top.r) / 2 - size.top.w / 2, HELP_MARGIN, Math.max(HELP_MARGIN, sideLimit + 8 - size.top.w)),
    y: tg.top.b + HELP_GAP,
  };
  pos.side = { x: sideLimit - size.side.w, y: tg.side.t };
  const hits = (a, aw, ah, b) => a.x < b.r + 8 && a.x + aw > b.l - 8 && a.y < b.b + 8 && a.y + ah > b.t - 8;
  const topBox = { l: pos.top.x, t: pos.top.y, r: pos.top.x + size.top.w, b: pos.top.y + size.top.h };
  if (hits(pos.side, size.side.w, size.side.h, tg.top) || hits(pos.side, size.side.w, size.side.h, topBox)) {
    pos.side.y = topBox.b + 14;   // narrow screens: stack it under the first box
  }
  if (size.bottom && tg.bottom) {
    pos.bottom = {
      x: clamp((tg.bottom.l + tg.bottom.r) / 2 - size.bottom.w / 2, HELP_MARGIN, Math.max(HELP_MARGIN, vw - HELP_MARGIN - size.bottom.w)),
      y: tg.bottom.t - HELP_GAP - size.bottom.h,
    };
    // Short screens: if the bottom box would run into the stack above it, drop the VIEW box
    // (its two buttons already say what they do) and move the side box up into its place.
    if (pos.side.y > tg.side.t && pos.bottom.y < pos.side.y + size.side.h + 10) {
      pos.side.y = pos.top.y;
      pos.top = null;
    }
  }
  helpEls.boxes.top.style.visibility = pos.top ? '' : 'hidden';   // stays measurable, so the choice is stable

  // 4. write: positions, widths, then the outlines and links
  helpEls.root.classList.toggle('compact', vh < 720 || vw < 380);
  let svg = '';
  for (const [key, box] of Object.entries(helpEls.boxes)) {
    if (!pos[key]) continue;
    const x = Math.round(pos[key].x), y = Math.round(pos[key].y);
    box.style.left = `${x}px`;
    box.style.top = `${y}px`;
    box.style.maxWidth = `${Math.max(150, Math.round(maxW[key]))}px`;
    const t = tg[key];
    const pts = helpLink({ l: x, t: y, r: x + size[key].w, b: y + size[key].h }, t).map(([px, py]) => [Math.round(px), Math.round(py)]);
    const [ex, ey] = pts[pts.length - 1];
    // each stroke is drawn twice: a background-coloured halo first, so it reads over any photo
    const rect = `x="${Math.round(t.l)}" y="${Math.round(t.t)}" width="${Math.round(t.r - t.l)}" height="${Math.round(t.b - t.t)}"`;
    const line = `points="${pts.map((q) => q.join(',')).join(' ')}"`;
    svg += `<rect class="group halo" ${rect}/><polyline class="link halo" ${line}/>`
      + `<rect class="cap halo" x="${ex - 4}" y="${ey - 4}" width="8" height="8"/>`
      + `<rect class="group" ${rect}/><polyline class="link" ${line}/>`
      + `<rect class="cap" x="${ex - 3}" y="${ey - 3}" width="6" height="6"/>`;
  }
  helpEls.svg.innerHTML = svg;
}

function setHelp(on) {
  if (on === help.open) return;
  help.open = on;
  helpEls.btn.setAttribute('aria-pressed', String(on));
  cancelAnimationFrame(help.raf);
  if (on) {
    ui.reprWrap.classList.remove('labels-open');
    help.content = help.geometry = '';
    helpEls.root.classList.remove('leaving');
    helpEls.root.hidden = false;
    // lay out twice up front (the second pass sees the widths the first one set), then keep
    // following the controls as bars slide in, modes change or the window resizes
    const tick = () => { layoutHelp(); help.raf = requestAnimationFrame(tick); };
    layoutHelp();
    tick();
  } else {
    helpEls.root.classList.add('leaving');
    setTimeout(() => { if (!help.open) helpEls.root.hidden = true; }, 260);
  }
}

helpEls.btn.addEventListener('click', () => setHelp(!help.open));

/* ------------------------------------------------------------------ loop */

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  if (state.shot >= 0 && !body.classList.contains('flying')) camera.fov = shotFov();
  camera.updateProjectionMatrix();
  setView(state.view);
}
window.addEventListener('resize', resize);
resize();
document.fonts?.ready.then(() => setView(state.view));

{
  const w = welcomePose(0);
  camera.position.copy(w.pos);
  camera.quaternion.copy(w.quat);
}

const clock = new THREE.Clock();
let welcomeT = 0;
renderer.setAnimationLoop((now) => {
  const dt = Math.min(clock.getDelta(), 0.1);
  runTweens(now ?? performance.now());
  if (state.view === 'welcome' && state.ready) {
    welcomeT += dt;
    const w = welcomePose(welcomeT);
    camera.position.copy(w.pos);
    camera.quaternion.copy(w.quat);
  } else if (state.shot >= 0 && !body.classList.contains('flying')) {
    applyLook(dt);
  } else if (controls.enabled) {
    controls.update();
  }
  renderer.render(scene, camera);
});
