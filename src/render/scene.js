// Renderer + world dressing: sky, fog, lights, ground, themed scenery, the
// start gate, item-box visuals and boost-pad decals. Everything gameplay-
// relevant is read-only from the Track; this module never mutates sim state.
// No DOM/WebGL access at import time — all of it happens inside the exported
// functions (the Node syntax check imports this file with stubs).

import * as THREE from 'three';
import { BOUNDS } from '../core/constants.js';
import { Rng } from '../core/rng.js';
import { clamp01, easeOutBack, damp } from '../core/mathx.js';
import { getTrackBounds, makeCheckerTexture } from './trackMesh.js';

// Render-only tuning.
const MAX_PIXEL_RATIO = 2;
const SUN_DIR = { x: -0.48, y: 0.82, z: 0.32 };  // stylized late-day key light
const SHADOW_MAP_SIZE = 2048;
const SCATTER_MIN_OFFSET = 26;
const SCATTER_MAX_OFFSET = 60;
const SCATTER_CLEARANCE = 3;     // extra gap beyond road + offroad strip
const BOX_SPIN_RATE = 1.75;
const BOX_BOB_RATE = 2.2;
const BOX_BOB_AMPLITUDE = 0.12;
const BOX_POP_TIME = 0.34;
const BOX_HIDE_LAMBDA = 22;
const PAD_LIFT = 0.045;

/**
 * Create the WebGL renderer with the project-wide presentation defaults.
 * @param {HTMLCanvasElement} canvas
 * @returns {{renderer: THREE.WebGLRenderer, resize(w:number,h:number):void}}
 */
export function createRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));

  const resize = (w, h) => {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    renderer.setSize(w, h, false);
  };
  return { renderer, resize };
}

// ---------------------------------------------------------------------------
// Procedural textures (call-time only — they need a real 2D canvas)
// ---------------------------------------------------------------------------

function makeQuestionTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  ctx.font = 'bold 92px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 12;
  ctx.strokeStyle = 'rgba(40,30,70,0.9)';
  ctx.strokeText('?', size / 2, size / 2 + 6);
  ctx.fillStyle = '#ffffff';
  ctx.fillText('?', size / 2, size / 2 + 6);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Three upward chevrons on a transparent background (tinted by the material). */
function makeChevronTexture() {
  const w = 64, h = 128;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < 3; i++) {
    const y = 108 - i * 38;
    ctx.beginPath();
    ctx.moveTo(6, y);
    ctx.lineTo(32, y - 24);
    ctx.lineTo(58, y);
    ctx.lineTo(58, y - 14);
    ctx.lineTo(32, y - 38);
    ctx.lineTo(6, y - 14);
    ctx.closePath();
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------------------
// Sky
// ---------------------------------------------------------------------------

function buildSkyDome(theme, radius) {
  const geo = new THREE.SphereGeometry(radius, 24, 14);
  const pos = geo.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  const top = new THREE.Color(theme.sky ?? 0x86b8ef);
  const horizon = new THREE.Color(theme.skyHorizon ?? 0xdff0ff);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    // Blend by altitude; keep the horizon band wide so the gradient reads soft.
    const t = clamp01((pos.getY(i) / radius) * 1.55);
    c.lerpColors(horizon, top, t * t * (3 - 2 * t));
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.BackSide,
    fog: false,
    depthWrite: false,
  });
  const sky = new THREE.Mesh(geo, mat);
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  return sky;
}

// ---------------------------------------------------------------------------
// Scenery scatter
// ---------------------------------------------------------------------------

/**
 * Sample points laterally outside the drivable ribbon. Rejects candidates
 * close to ANY pass of the track (spline.project dist check), which matters
 * where the loop folds back on itself.
 * @returns {Array<{x:number,z:number,rot:number,dist:number}>}
 */
function scatterPoints(track, rng, count) {
  const sp = track.spline;
  const out = [];
  const samp = {};
  const proj = {};
  let attempts = count * 10;
  while (out.length < count && attempts-- > 0) {
    const s = rng.float() * track.length;
    const side = rng.chance(0.5) ? 1 : -1;
    const offset = rng.range(SCATTER_MIN_OFFSET, SCATTER_MAX_OFFSET);
    sp.sampleAt(s, samp);
    const x = samp.x + samp.rx * side * offset;
    const z = samp.z + samp.rz * side * offset;
    sp.project(x, z, proj);
    const clearance = track.halfWidthAt(proj.s) + BOUNDS.offroadExtent + SCATTER_CLEARANCE;
    if (proj.dist < clearance) continue;
    out.push({ x, z, rot: rng.float() * Math.PI * 2, dist: proj.dist });
  }
  return out;
}

/**
 * One InstancedMesh per part, all parts sharing the same per-instance
 * transform (part-local offsets are baked into the geometries).
 * @param {Array<{geometry:THREE.BufferGeometry, material:THREE.Material}>} parts
 * @param {Array<{x:number,y:number,z:number,rot:number,sx:number,sy:number,sz:number,tint?:number}>} transforms
 */
function addInstancedParts(parent, parts, transforms) {
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  for (const part of parts) {
    const mesh = new THREE.InstancedMesh(part.geometry, part.material, transforms.length);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    for (let i = 0; i < transforms.length; i++) {
      const t = transforms[i];
      dummy.position.set(t.x, t.y, t.z);
      dummy.rotation.set(0, t.rot, 0);
      dummy.scale.set(t.sx, t.sy, t.sz);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      if (t.tint != null) mesh.setColorAt(i, color.setHex(t.tint));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    parent.add(mesh);
  }
  return transforms.length;
}

const grayTints = (rng, lo = 0.82, hi = 1.12) => {
  const v = Math.round(rng.range(lo, hi) * 255);
  const ch = Math.max(0, Math.min(255, v));
  return (ch << 16) | (ch << 8) | ch;
};

function buildDesertScenery(group, track, rng) {
  let instances = 0;

  // Saguaro cacti: trunk + two angled arms, origin at the ground.
  const cactusMat = new THREE.MeshStandardMaterial({ color: 0x3f9e52, roughness: 0.9 });
  const trunk = new THREE.CylinderGeometry(0.42, 0.55, 3.2, 7);
  trunk.translate(0, 1.6, 0);
  const arm1 = new THREE.CylinderGeometry(0.26, 0.3, 1.7, 6);
  arm1.rotateZ(0.85);
  arm1.translate(0.82, 2.0, 0);
  const arm2 = new THREE.CylinderGeometry(0.24, 0.28, 1.4, 6);
  arm2.rotateZ(-0.9);
  arm2.translate(-0.72, 2.4, 0);
  const cactusSpots = scatterPoints(track, rng, 55).map((p) => ({
    x: p.x, y: 0, z: p.z, rot: p.rot,
    sx: rng.range(0.8, 1.5), sy: rng.range(0.8, 1.7), sz: rng.range(0.8, 1.5),
    tint: grayTints(rng),
  }));
  instances += addInstancedParts(group, [
    { geometry: trunk, material: cactusMat },
    { geometry: arm1, material: cactusMat },
    { geometry: arm2, material: cactusMat },
  ], cactusSpots);

  // Red rocks: flattened icosahedra half-sunk into the sand.
  const rockMat = new THREE.MeshStandardMaterial({ color: 0xb4543a, roughness: 1, flatShading: true });
  const rock = new THREE.IcosahedronGeometry(1.7, 0);
  rock.scale(1.35, 0.72, 1.05);
  rock.translate(0, 0.45, 0);
  const rockSpots = scatterPoints(track, rng, 55).map((p) => ({
    x: p.x, y: 0, z: p.z, rot: p.rot,
    sx: rng.range(0.7, 2.4), sy: rng.range(0.6, 1.8), sz: rng.range(0.7, 2.4),
    tint: grayTints(rng, 0.75, 1.15),
  }));
  instances += addInstancedParts(group, [{ geometry: rock, material: rockMat }], rockSpots);
  return instances;
}

const CONTAINER_COLORS = [0xe8632c, 0x2f9e6e, 0x3b7dd8, 0xf2c14e, 0xc94f4f, 0x8e6cc0];

function buildCrane(color) {
  const crane = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.25 });
  const add = (w, h, d, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.castShadow = false;
    m.receiveShadow = true;
    crane.add(m);
  };
  add(0.9, 14, 0.9, -5.2, 7, 0);       // legs
  add(0.9, 14, 0.9, 5.2, 7, 0);
  add(12.6, 1.2, 1.2, 0, 14.2, 0);     // gantry beam
  add(1.8, 1.6, 1.8, 1.4, 13.0, 0);    // trolley cab
  add(0.7, 0.7, 15, 0, 14.6, 3.5);     // jib reaching over the water
  add(0.16, 5.5, 0.16, 0, 11.2, 10.4); // cable
  add(2.2, 1.1, 1.1, 0, 8.2, 10.4);    // spreader
  return crane;
}

function buildHarborScenery(group, track, rng) {
  let instances = 0;

  // Container stacks in bright port colors.
  const containerMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.65, metalness: 0.2 });
  const containerGeo = new THREE.BoxGeometry(6.1, 2.6, 2.44);
  containerGeo.translate(0, 1.3, 0);
  const stacks = scatterPoints(track, rng, 30);
  const boxes = [];
  for (const p of stacks) {
    const tiers = rng.int(1, 3);
    for (let tier = 0; tier < tiers; tier++) {
      boxes.push({
        x: p.x + rng.range(-0.4, 0.4),
        y: tier * 2.6,
        z: p.z + rng.range(-0.4, 0.4),
        rot: p.rot + rng.range(-0.08, 0.08),
        sx: 1, sy: 1, sz: 1,
        tint: rng.pick(CONTAINER_COLORS),
      });
    }
  }
  instances += addInstancedParts(group, [{ geometry: containerGeo, material: containerMat }], boxes);

  // Dock bollards for mid-ground detail.
  const bollardMat = new THREE.MeshStandardMaterial({ color: 0x2c3540, roughness: 0.5, metalness: 0.4 });
  const bollardGeo = new THREE.CylinderGeometry(0.35, 0.45, 1.0, 8);
  bollardGeo.translate(0, 0.5, 0);
  const bollards = scatterPoints(track, rng, 26).map((p) => ({
    x: p.x, y: 0, z: p.z, rot: p.rot, sx: 1, sy: 1, sz: 1,
  }));
  instances += addInstancedParts(group, [{ geometry: bollardGeo, material: bollardMat }], bollards);

  // Two gantry cranes looming over the docks.
  const craneSpots = scatterPoints(track, rng, 2);
  for (let i = 0; i < craneSpots.length; i++) {
    const crane = buildCrane(i === 0 ? 0xe8632c : 0x3b7dd8);
    crane.position.set(craneSpots[i].x, 0, craneSpots[i].z);
    crane.rotation.y = craneSpots[i].rot;
    group.add(crane);
    instances++;
  }
  return instances;
}

function buildAlpineScenery(group, track, rng, bounds) {
  let instances = 0;

  // Pines: trunk + foliage cone + snow tip.
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6e4a33, roughness: 1 });
  const foliageMat = new THREE.MeshStandardMaterial({ color: 0x2e6b4f, roughness: 0.95 });
  const snowMat = new THREE.MeshStandardMaterial({ color: 0xf4f7ff, roughness: 0.8 });
  const trunkGeo = new THREE.CylinderGeometry(0.22, 0.32, 1.3, 6);
  trunkGeo.translate(0, 0.65, 0);
  const foliageGeo = new THREE.ConeGeometry(1.55, 3.6, 7);
  foliageGeo.translate(0, 3.0, 0);
  const tipGeo = new THREE.ConeGeometry(0.52, 1.0, 7);
  tipGeo.translate(0, 4.55, 0);
  const pineSpots = scatterPoints(track, rng, 95).map((p) => {
    const s = rng.range(0.75, 1.7);
    return { x: p.x, y: 0, z: p.z, rot: p.rot, sx: s, sy: s * rng.range(0.9, 1.25), sz: s, tint: grayTints(rng, 0.85, 1.1) };
  });
  instances += addInstancedParts(group, [
    { geometry: trunkGeo, material: trunkMat },
    { geometry: foliageGeo, material: foliageMat },
    { geometry: tipGeo, material: snowMat },
  ], pineSpots);

  // Distant peaks ringed around the valley.
  const peakMat = new THREE.MeshStandardMaterial({ color: 0x77689c, roughness: 1, flatShading: true });
  const peakGeo = new THREE.ConeGeometry(1, 1, 6);
  peakGeo.translate(0, 0.5, 0);
  const capGeo = new THREE.ConeGeometry(0.34, 0.34, 6);
  capGeo.translate(0, 0.82, 0);
  const peaks = [];
  const peakProj = {};
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + rng.range(-0.25, 0.25);
    // Close enough that the peaks read as silhouettes through the fog...
    let d = bounds.radius * rng.range(1.25, 1.9);
    const h = rng.range(55, 105);
    const r = h * rng.range(0.55, 0.8);
    // ...but never so close that a base circle crosses the drivable strip.
    let x = bounds.cx + Math.sin(a) * d;
    let z = bounds.cz + Math.cos(a) * d;
    for (let tries = 0; tries < 20; tries++) {
      track.spline.project(x, z, peakProj);
      const clearance = track.halfWidthAt(peakProj.s) + BOUNDS.offroadExtent + r + 6;
      if (peakProj.dist >= clearance) break;
      d += 20;
      x = bounds.cx + Math.sin(a) * d;
      z = bounds.cz + Math.cos(a) * d;
    }
    peaks.push({ x, y: -2, z, rot: rng.float() * Math.PI, sx: r, sy: h, sz: r });
  }
  instances += addInstancedParts(group, [
    { geometry: peakGeo, material: peakMat },
    { geometry: capGeo, material: snowMat },
  ], peaks);

  // Floating clouds — parented to a pivot at the track centre so animate()
  // can drift the whole layer with one rotation.
  const cloudPivot = new THREE.Group();
  cloudPivot.position.set(bounds.cx, 0, bounds.cz);
  const cloudMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 });
  const cloudGeo = new THREE.SphereGeometry(1, 10, 7);
  cloudGeo.scale(3.4, 1.05, 2.1);
  const clouds = [];
  for (let i = 0; i < 12; i++) {
    const a = rng.float() * Math.PI * 2;
    const d = bounds.radius * rng.range(0.5, 1.6);
    const s = rng.range(1.6, 4.2);
    clouds.push({
      x: Math.sin(a) * d, y: rng.range(34, 68), z: Math.cos(a) * d,
      rot: rng.float() * Math.PI, sx: s, sy: s * rng.range(0.7, 1), sz: s,
    });
  }
  instances += addInstancedParts(cloudPivot, [{ geometry: cloudGeo, material: cloudMat }], clouds);
  group.add(cloudPivot);
  return { instances, cloudPivot };
}

// ---------------------------------------------------------------------------
// Start gate
// ---------------------------------------------------------------------------

function buildStartGate(track) {
  const gate = new THREE.Group();
  gate.name = 'start-gate';
  const sm = track.spline.sampleAt(0, {});
  const hw = track.halfWidthAt(0);
  gate.position.set(sm.x, sm.y, sm.z);
  gate.rotation.y = sm.heading;

  const pillarH = 5.6;
  const pillarMat = new THREE.MeshStandardMaterial({
    color: track.theme.wall ?? 0xdd4444, roughness: 0.5, metalness: 0.1,
  });
  const pillarGeo = new THREE.BoxGeometry(0.85, pillarH, 0.85);
  for (const side of [-1, 1]) {
    const pillar = new THREE.Mesh(pillarGeo, pillarMat);
    pillar.position.set(side * (hw + 1.3), pillarH / 2, 0);
    pillar.castShadow = true;
    pillar.receiveShadow = true;
    gate.add(pillar);
  }

  const bannerTex = makeCheckerTexture(22, 2);
  const banner = new THREE.Mesh(
    new THREE.BoxGeometry((hw + 1.3) * 2 + 0.85, 1.5, 0.45),
    new THREE.MeshStandardMaterial({ map: bannerTex, roughness: 0.7 })
  );
  banner.position.set(0, pillarH + 0.75, 0);
  banner.castShadow = true;
  banner.receiveShadow = true;
  gate.add(banner);
  return gate;
}

// ---------------------------------------------------------------------------
// buildScene
// ---------------------------------------------------------------------------

/**
 * Build the full static world for a track. Returned `animate(dt, raceTime)`
 * drives item box spin/bob/respawn, boost pad pulse and ambient scenery
 * motion — call it once per rendered frame. Allocation-free per call.
 *
 * @param {import('../track/track.js').Track} track
 * @returns {{scene: THREE.Scene, sunLight: THREE.DirectionalLight,
 *            bounds: ReturnType<typeof getTrackBounds>,
 *            animate(dt:number, raceTime:number):void}}
 */
export function buildScene(track) {
  const theme = track.theme || {};
  const rng = new Rng(`scenery:${track.id}`);
  const bounds = getTrackBounds(track);
  const scene = new THREE.Scene();
  scene.name = `scene:${track.id}`;

  // --- Atmosphere ------------------------------------------------------------
  scene.background = new THREE.Color(theme.fog ?? 0xcfe0ee);
  scene.fog = new THREE.FogExp2(theme.fog ?? 0xcfe0ee, theme.fogDensity ?? 0.0035);
  // Dome is centred on the track; keep its far side inside CAMERA.far (900)
  // for a camera anywhere over the track, or the sky would clip.
  const skyRadius = Math.min(860 - bounds.radius, Math.max(460, bounds.radius * 3));
  const sky = buildSkyDome(theme, skyRadius);
  sky.position.set(bounds.cx, 0, bounds.cz);
  scene.add(sky);

  // --- Lights ------------------------------------------------------------------
  const hemi = new THREE.HemisphereLight(
    theme.ambient ?? 0xdfeaff,
    new THREE.Color(theme.offroadDark ?? 0x556644).multiplyScalar(0.55),
    theme.ambientIntensity ?? 0.55
  );
  scene.add(hemi);

  const sunLight = new THREE.DirectionalLight(theme.sun ?? 0xffffff, theme.sunIntensity ?? 1.2);
  const sunDist = bounds.radius * 1.5 + 60;
  sunLight.position.set(
    bounds.cx + SUN_DIR.x * sunDist,
    SUN_DIR.y * sunDist,
    bounds.cz + SUN_DIR.z * sunDist
  );
  sunLight.target.position.set(bounds.cx, 0, bounds.cz);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
  const shadowSpan = bounds.radius * 1.08 + 12;
  const cam = sunLight.shadow.camera;
  cam.left = -shadowSpan;
  cam.right = shadowSpan;
  cam.top = shadowSpan;
  cam.bottom = -shadowSpan;
  cam.near = 1;
  cam.far = sunDist + bounds.radius * 2;
  sunLight.shadow.bias = -0.0004;
  // ~1 shadow texel in world units at this span; kills acne on low-poly faces.
  sunLight.shadow.normalBias = (shadowSpan * 2) / SHADOW_MAP_SIZE;
  scene.add(sunLight);
  scene.add(sunLight.target);

  // --- Ground ------------------------------------------------------------------
  const isHarbor = theme.scenery === 'harbor';
  const groundRadius = bounds.radius + (isHarbor ? 55 : 140);
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(groundRadius, 48),
    new THREE.MeshStandardMaterial({ color: theme.offroadDark ?? 0x66794f, roughness: 1 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(bounds.cx, -0.05, bounds.cz);
  ground.receiveShadow = true;
  ground.updateMatrix();
  ground.matrixAutoUpdate = false;
  scene.add(ground);

  // --- Themed scenery ------------------------------------------------------------
  const scenery = new THREE.Group();
  scenery.name = 'scenery';
  let water = null;
  let cloudPivot = null;
  if (theme.scenery === 'desert') {
    buildDesertScenery(scenery, track, rng);
  } else if (isHarbor) {
    buildHarborScenery(scenery, track, rng);
    // Sea plane below the dock slab; the drop reads as a quayside edge.
    water = new THREE.Mesh(
      new THREE.PlaneGeometry(2600, 2600),
      new THREE.MeshStandardMaterial({
        color: 0x2f7fc4, transparent: true, opacity: 0.82,
        roughness: 0.18, metalness: 0.05,
      })
    );
    water.rotation.x = -Math.PI / 2;
    water.position.set(bounds.cx, -0.55, bounds.cz);
    scenery.add(water);
  } else if (theme.scenery === 'alpine') {
    ({ cloudPivot } = buildAlpineScenery(scenery, track, rng, bounds));
  }
  scene.add(scenery);

  scene.add(buildStartGate(track));

  // --- Item box visuals ------------------------------------------------------------
  const boxMat = new THREE.MeshStandardMaterial({
    color: 0x66ccff,
    emissive: 0x3355ff,
    emissiveIntensity: 0.55,
    metalness: 0.85,
    roughness: 0.15,
    transparent: true,
    opacity: 0.82,
    depthWrite: false,
  });
  const boxGeo = new THREE.BoxGeometry(1.15, 1.15, 1.15);
  const qMat = new THREE.SpriteMaterial({
    map: makeQuestionTexture(), transparent: true, depthWrite: false,
  });
  const boxVisuals = [];
  for (const box of track.itemBoxes) {
    const pivot = new THREE.Group();
    pivot.position.set(box.x, box.y, box.z);
    const mesh = new THREE.Mesh(boxGeo, boxMat);
    mesh.rotation.set(0.36, 0, 0.52); // constant diagonal tilt; pivot spins
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = 3;
    const sprite = new THREE.Sprite(qMat);
    sprite.scale.set(0.72, 0.72, 1);
    sprite.renderOrder = 4;
    pivot.add(mesh);
    pivot.add(sprite);
    scene.add(pivot);
    boxVisuals.push({
      box, pivot,
      baseY: box.y,
      phase: box.id * 1.31,
      popT: BOX_POP_TIME,   // start fully shown
      scale: 1,
      wasActive: true,
    });
  }

  // --- Boost pad decals ------------------------------------------------------------
  const chevronTex = makeChevronTexture();
  const padMat = new THREE.MeshStandardMaterial({
    color: 0x39e6ff,
    emissive: 0x39e6ff,
    emissiveIntensity: 0.9,
    map: chevronTex,
    transparent: true,
    depthWrite: false,
    roughness: 0.4,
    side: THREE.DoubleSide,
  });
  const padPos = {};
  for (const pad of track.boostPads) {
    const geo = new THREE.PlaneGeometry(pad.halfWidth * 2, pad.halfLength * 2);
    geo.rotateX(-Math.PI / 2);
    track.toWorld(pad.s, pad.lateral, padPos);
    const decal = new THREE.Mesh(geo, padMat);
    decal.position.set(padPos.x, padPos.y + PAD_LIFT, padPos.z);
    // rotateX(-PI/2) leaves texture-v pointing local -z, so flip to face travel.
    decal.rotation.y = padPos.heading + Math.PI;
    decal.renderOrder = 2;
    decal.receiveShadow = false;
    decal.updateMatrix();
    decal.matrixAutoUpdate = false;
    scene.add(decal);
  }

  // --- Per-frame animation (zero allocation) ------------------------------------------
  let selfTime = 0;
  function animate(dt, raceTime) {
    selfTime += dt;
    const t = Number.isFinite(raceTime) ? raceTime : selfTime;

    // Iridescent hue cycle shared by every item box.
    const hue = (t * 0.12) % 1;
    boxMat.color.setHSL(hue, 0.7, 0.62);
    boxMat.emissive.setHSL((hue + 0.18) % 1, 0.85, 0.42);

    for (let i = 0; i < boxVisuals.length; i++) {
      const v = boxVisuals[i];
      const active = v.box.active;
      if (active && !v.wasActive) v.popT = 0;   // respawn pop
      v.wasActive = active;

      if (active) {
        v.popT += dt;
        v.scale = easeOutBack(Math.min(v.popT / BOX_POP_TIME, 1));
      } else {
        v.scale = damp(v.scale, 0, BOX_HIDE_LAMBDA, dt);
      }

      const visible = v.scale > 0.02;
      v.pivot.visible = visible;
      if (!visible) continue;
      v.pivot.scale.setScalar(v.scale);
      v.pivot.rotation.y = t * BOX_SPIN_RATE + v.phase;
      v.pivot.position.y = v.baseY + Math.sin(t * BOX_BOB_RATE + v.phase) * BOX_BOB_AMPLITUDE;
    }

    // Boost pads breathe.
    padMat.emissiveIntensity = 0.85 + 0.35 * Math.sin(t * 4.6);

    if (water) {
      water.position.y = -0.55 + Math.sin(t * 0.5) * 0.05;
      water.material.opacity = 0.82 + 0.05 * Math.sin(t * 0.9 + 1.7);
    }
    if (cloudPivot) {
      cloudPivot.rotation.y = t * 0.006;
    }
  }

  return { scene, sunLight, bounds, animate };
}
