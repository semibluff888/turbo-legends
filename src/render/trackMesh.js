// Track geometry: road ribbon, painted lines, kerbs, offroad skirt, outer
// walls and the start/finish line — all built once from the simulation-side
// Track (read-only). No DOM access at import time: canvas textures are only
// created inside buildTrackMesh().

import * as THREE from 'three';
import { Rng } from '../core/rng.js';
import { pmod } from '../core/mathx.js';

// Render-only tuning (no gameplay meaning, so these live here, not constants.js).
const PAINT_LIFT = 0.025;        // painted lines float this far above the road
const KERB_LIFT_IN = 0.035;
const KERB_LIFT_OUT = 0.005;     // slight outward tilt so kerbs catch the light
const KERB_INSET = 0.15;         // kerb starts just inside the road edge
const KERB_REACH = 1.05;         // ...and reaches past it
const KERB_MIN_CURVATURE = 0.028;
const KERB_DILATE = 3;           // samples of padding around a qualifying arc
const KERB_MIN_RUN = 6;          // ignore blips shorter than this many samples
const EDGE_INSET = 0.35;
const EDGE_WIDTH = 0.38;
const SKIRT_DROP_IN = 0.02;      // skirt tucks under the road edge
const SKIRT_DROP_OUT = 0.12;     // ...and droops at the outer boundary
const WALL_HEIGHT = 0.9;
const WALL_DROP = 0.14;
const START_LIFT = 0.045;
const ICE_LIFT = 0.012;
const START_HALF_LENGTH = 1.35;
const ROAD_V_PERIOD = 6;         // metres of track per texture tile along s
const DASH_V_PERIOD = 4.5;       // dash + gap cycle length
const KERB_V_PERIOD = 2.4;       // red+white stripe pair length

/**
 * World-space extents of the drivable area (road + offroad strip).
 * Used by the shadow camera and the minimap.
 * @returns {{minX:number,maxX:number,minZ:number,maxZ:number,cx:number,cz:number,radius:number}}
 */
export function getTrackBounds(track) {
  const sp = track.spline;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  let maxReach = 0;
  for (let i = 0; i < sp.count; i++) {
    if (sp.px[i] < minX) minX = sp.px[i];
    if (sp.px[i] > maxX) maxX = sp.px[i];
    if (sp.pz[i] < minZ) minZ = sp.pz[i];
    if (sp.pz[i] > maxZ) maxZ = sp.pz[i];
    const hw = track.halfWidthAt(i * sp.spacing);
    const reach = hw + track.runoffAt(i * sp.spacing);
    if (reach > maxReach) maxReach = reach;
  }
  const margin = maxReach;
  minX -= margin; maxX += margin; minZ -= margin; maxZ += margin;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const radius = 0.5 * Math.hypot(maxX - minX, maxZ - minZ);
  return { minX, maxX, minZ, maxZ, cx, cz, radius };
}

/**
 * Checkerboard CanvasTexture (start line, gate banner). Exported so scene.js
 * can share it. Only call at build time — needs a real DOM canvas.
 */
export function makeCheckerTexture(cols = 16, rows = 2, colorA = '#f5f5f5', colorB = '#14141a') {
  const cell = 32;
  const canvas = document.createElement('canvas');
  canvas.width = cols * cell;
  canvas.height = rows * cell;
  const ctx = canvas.getContext('2d');
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? colorA : colorB;
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** Subtle grayscale speckle used for asphalt / dirt so flat colors don't band. */
function makeSpeckleTexture(rng, base = '#d6d6da', dots = 900) {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < dots; i++) {
    const shade = rng.chance(0.5) ? 0 : 255;
    ctx.fillStyle = `rgba(${shade},${shade},${shade},${(0.05 + rng.float() * 0.1).toFixed(3)})`;
    const s = rng.chance(0.85) ? 1 : 2;
    ctx.fillRect(Math.floor(rng.float() * size), Math.floor(rng.float() * size), s, s);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** Vertical dash pattern for the centre line (tiles along v = arc length). */
function makeDashTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 8, 64);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 4, 8, 28); // ~45% duty cycle dash
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** Red/white stripe pair for kerbs (tiles along v). */
function makeKerbTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#e33d3d';
  ctx.fillRect(0, 0, 32, 32);
  ctx.fillStyle = '#f6f3ee';
  ctx.fillRect(0, 32, 32, 32);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** Round a target tile length so the loop holds an integer tile count (seamless wrap). */
function loopPeriod(length, target) {
  return length / Math.max(1, Math.round(length / target));
}

function rangeFromArc(track, start, end) {
  const sp = track.spline;
  const startS = pmod(start, track.length);
  const endS = end === track.length ? track.length : pmod(end, track.length);
  const arc = endS >= startS ? endS - startS : track.length - startS + endS;
  return {
    start: Math.floor(startS / sp.spacing),
    count: Math.max(2, Math.ceil(arc / sp.spacing) + 1),
  };
}

function fracToS(track, frac) {
  return frac === 1 ? track.length : pmod(frac * track.length, track.length);
}

function makeIceTexture(rng) {
  const size = 192;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#dffaff';
  ctx.fillRect(0, 0, size, size);
  const gradient = ctx.createLinearGradient(0, 0, size, size);
  gradient.addColorStop(0, 'rgba(255,255,255,0.28)');
  gradient.addColorStop(0.55, 'rgba(74,191,224,0.08)');
  gradient.addColorStop(1, 'rgba(255,255,255,0.2)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  ctx.lineCap = 'round';
  for (let i = 0; i < 26; i++) {
    let x = rng.range(0, size);
    let y = rng.range(0, size);
    ctx.beginPath();
    ctx.moveTo(x, y);
    const steps = rng.int(2, 5);
    for (let step = 0; step < steps; step++) {
      x += rng.range(-22, 22);
      y += rng.range(10, 30);
      ctx.lineTo(x, y);
    }
    ctx.strokeStyle = rng.chance(0.45)
      ? 'rgba(30,104,142,0.22)' : 'rgba(255,255,255,0.42)';
    ctx.lineWidth = rng.range(0.7, 1.8);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2.5, 8);
  return tex;
}

/**
 * Build a two-rail ribbon that follows the spline. Rail A must be laterally
 * left of rail B (aLat < bLat) for an upward-facing winding; vertical ribbons
 * (walls) should use a DoubleSide material instead.
 *
 * @param {import('../track/track.js').Track} track
 * @param {{
 *   latA:(hw:number,i:number)=>number, latB:(hw:number,i:number)=>number,
 *   yA?:number|((hw:number,i:number)=>number), yB?:number|((hw:number,i:number)=>number),
 *   vPeriod?:number,
 *   range?:{start:number,count:number}  // open run of sample rows; omitted = closed loop
 * }} opts
 */
export function buildRibbonGeometry(track, opts) {
  const sp = track.spline;
  const n = sp.count;
  const closed = !opts.range;
  const rows = closed ? n + 1 : opts.range.count;
  const startIdx = closed ? 0 : opts.range.start;
  const vPeriod = opts.vPeriod ?? ROAD_V_PERIOD;

  const positions = new Float32Array(rows * 2 * 3);
  const uvs = new Float32Array(rows * 2 * 2);

  const yOf = (y, hw, i) => (typeof y === 'function' ? y(hw, i) : (y ?? 0));

  for (let r = 0; r < rows; r++) {
    const i = (startIdx + r) % n;
    const hw = track.halfWidthAt(i * sp.spacing);
    const aLat = opts.latA(hw, i);
    const bLat = opts.latB(hw, i);
    const aY = yOf(opts.yA, hw, i);
    const bY = yOf(opts.yB, hw, i);

    const o = r * 6;
    positions[o] = sp.px[i] + sp.rx[i] * aLat;
    positions[o + 1] = sp.py[i] + aY;
    positions[o + 2] = sp.pz[i] + sp.rz[i] * aLat;
    positions[o + 3] = sp.px[i] + sp.rx[i] * bLat;
    positions[o + 4] = sp.py[i] + bY;
    positions[o + 5] = sp.pz[i] + sp.rz[i] * bLat;

    // v runs on ribbon-local arc length so open runs start their pattern cleanly.
    const v = (r * sp.spacing) / vPeriod;
    const u = r * 4;
    uvs[u] = 0; uvs[u + 1] = v;
    uvs[u + 2] = 1; uvs[u + 3] = v;
  }

  const segs = rows - 1;
  const vertCount = rows * 2;
  const IndexArray = vertCount > 65535 ? Uint32Array : Uint16Array;
  const indices = new IndexArray(segs * 6);
  for (let r = 0; r < segs; r++) {
    const a = r * 2, b = a + 1, c = a + 2, d = a + 3;
    const o = r * 6;
    indices[o] = a; indices[o + 1] = c; indices[o + 2] = d;
    indices[o + 3] = a; indices[o + 4] = d; indices[o + 5] = b;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();
  return geo;
}

function buildTunnelGeometry(track, startS, endS, ceiling) {
  const arc = endS >= startS ? endS - startS : track.length - startS + endS;
  const rows = Math.max(2, Math.ceil(arc / 2.8) + 1);
  const cols = 14;
  const positions = new Float32Array(rows * cols * 3);
  const uvs = new Float32Array(rows * cols * 2);
  const sm = {};

  for (let row = 0; row < rows; row++) {
    const t = row / (rows - 1);
    const s = pmod(startS + arc * t, track.length);
    track.spline.sampleAt(s, sm);
    const radius = track.halfWidthAt(s) + track.runoffAt(s) + 1.15;
    for (let col = 0; col < cols; col++) {
      const u = col / (cols - 1);
      const angle = Math.PI * (1 - u);
      const lateral = Math.cos(angle) * radius;
      const rise = Math.sin(angle) * ceiling;
      const o = (row * cols + col) * 3;
      positions[o] = sm.x + sm.rx * lateral;
      positions[o + 1] = sm.y + rise + 0.05;
      positions[o + 2] = sm.z + sm.rz * lateral;
      const uv = (row * cols + col) * 2;
      uvs[uv] = u * 3;
      uvs[uv + 1] = (arc * t) / 9;
    }
  }

  const IndexArray = rows * cols > 65535 ? Uint32Array : Uint16Array;
  const indices = new IndexArray((rows - 1) * (cols - 1) * 6);
  let io = 0;
  for (let row = 0; row < rows - 1; row++) {
    for (let col = 0; col < cols - 1; col++) {
      const a = row * cols + col;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      indices[io++] = a; indices[io++] = c; indices[io++] = d;
      indices[io++] = a; indices[io++] = d; indices[io++] = b;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();
  return geo;
}

function inFractionRange(frac, startFrac, endFrac) {
  return startFrac <= endFrac
    ? frac >= startFrac && frac <= endFrac
    : frac >= startFrac || frac <= endFrac;
}

function addTunnelStructure(group, track, structure) {
  const startS = fracToS(track, structure.startFrac);
  const endS = fracToS(track, structure.endFrac);
  const openings = (structure.openings || [])
    .map((opening) => ({
      start: fracToS(track, opening.startFrac),
      end: fracToS(track, opening.endFrac),
      startFrac: opening.startFrac,
      endFrac: opening.endFrac,
    }))
    .sort((a, b) => a.start - b.start);
  const ranges = [];
  let cursor = startS;
  for (const opening of openings) {
    if (opening.start > cursor) ranges.push([cursor, opening.start]);
    cursor = Math.max(cursor, opening.end);
  }
  if (cursor < endS) ranges.push([cursor, endS]);

  const shellMat = new THREE.MeshStandardMaterial({
    color: 0x78cfe5,
    emissive: 0x174d70,
    emissiveIntensity: 0.28,
    transparent: true,
    opacity: 0.82,
    roughness: 0.3,
    metalness: 0.12,
    side: THREE.DoubleSide,
  });
  for (const [a, b] of ranges) {
    const shell = new THREE.Mesh(buildTunnelGeometry(track, a, b, structure.ceiling ?? 7), shellMat);
    shell.name = `tunnel-shell@${a.toFixed(0)}`;
    shell.castShadow = true;
    shell.receiveShadow = true;
    freeze(shell);
    group.add(shell);
  }

  const lightMat = new THREE.MeshStandardMaterial({
    color: 0xffd19a, emissive: 0xffa847, emissiveIntensity: 2.3,
    roughness: 0.35, metalness: 0.15,
  });
  const lightGeo = new THREE.BoxGeometry(0.34, 0.24, 1.4);
  const pos = {};
  let lightIndex = 0;
  for (let s = startS + 10; s < endS - 5; s += 17) {
    const frac = s / track.length;
    if (openings.some((opening) => inFractionRange(frac, opening.startFrac, opening.endFrac))) continue;
    for (const side of [-1, 1]) {
      const lateral = side * (track.halfWidthAt(s) + track.runoffAt(s) * 0.55);
      track.toWorld(s, lateral, pos);
      const fixture = new THREE.Mesh(lightGeo, lightMat);
      fixture.position.set(pos.x, pos.y + 2.55, pos.z);
      fixture.rotation.y = pos.heading;
      fixture.castShadow = false;
      freeze(fixture);
      group.add(fixture);
    }
    if (lightIndex++ % 2 === 0) {
      track.toWorld(s, 0, pos);
      const lamp = new THREE.PointLight(0xffbd78, 4.5, 22, 2);
      lamp.position.set(pos.x, pos.y + 3.5, pos.z);
      lamp.castShadow = false;
      group.add(lamp);
    }
  }
}

function addBridgeTower(group, track, s, material) {
  const centre = track.toWorld(s, 0, {});
  const reach = track.halfWidthAt(s) + track.runoffAt(s) - 0.45;
  const tower = new THREE.Group();
  tower.position.set(centre.x, centre.y, centre.z);
  tower.rotation.y = centre.heading;
  const pillarGeo = new THREE.BoxGeometry(0.72, 7.2, 0.72);
  for (const side of [-1, 1]) {
    const pillar = new THREE.Mesh(pillarGeo, material);
    pillar.position.set(side * reach, 3.6, 0);
    pillar.castShadow = true;
    pillar.receiveShadow = true;
    tower.add(pillar);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(reach * 2 + 0.8, 0.55, 0.65), material);
  beam.position.set(0, 7.0, 0);
  beam.castShadow = true;
  tower.add(beam);
  tower.updateMatrix();
  tower.matrixAutoUpdate = false;
  group.add(tower);
}

function addBridgeStructure(group, track, structure) {
  const startS = fracToS(track, structure.startFrac);
  const endS = fracToS(track, structure.endFrac);
  const range = rangeFromArc(track, startS, endS);
  const sp = track.spline;
  const reach = (hw, i) => hw + track.runoffAt(i * sp.spacing);
  const deckMat = new THREE.MeshStandardMaterial({
    color: 0x183a5a, roughness: 0.52, metalness: 0.55, side: THREE.DoubleSide,
  });
  const fasciaMat = new THREE.MeshStandardMaterial({
    color: 0x24577a, roughness: 0.45, metalness: 0.45, side: THREE.DoubleSide,
  });
  const railMat = new THREE.MeshStandardMaterial({
    color: 0x8defff, emissive: 0x2da9c7, emissiveIntensity: 0.38,
    transparent: true, opacity: 0.7, roughness: 0.18, metalness: 0.12,
    side: THREE.DoubleSide,
  });
  const add = (geo, mat, name, castShadow = false) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    freeze(mesh);
    group.add(mesh);
  };

  add(buildRibbonGeometry(track, {
    latA: (hw, i) => -reach(hw, i), latB: (hw, i) => reach(hw, i),
    yA: -0.95, yB: -0.95, range,
  }), deckMat, 'bridge-underdeck', true);
  for (const side of [-1, 1]) {
    add(buildRibbonGeometry(track, {
      latA: (hw, i) => side * reach(hw, i),
      latB: (hw, i) => side * reach(hw, i),
      yA: -0.95, yB: 0.12, range,
    }), fasciaMat, `bridge-fascia-${side}`);
    add(buildRibbonGeometry(track, {
      latA: (hw, i) => side * (reach(hw, i) + 0.04),
      latB: (hw, i) => side * (reach(hw, i) + 0.04),
      yA: 0.15, yB: 1.45, range,
    }), railMat, `bridge-rail-${side}`);
  }

  const mainStartS = fracToS(track, structure.mainStartFrac ?? structure.startFrac);
  const mainEndS = fracToS(track, structure.mainEndFrac ?? structure.endFrac);
  const towerMat = new THREE.MeshStandardMaterial({
    color: 0x153754, emissive: 0x0c263c, emissiveIntensity: 0.25,
    roughness: 0.45, metalness: 0.58,
  });
  addBridgeTower(group, track, mainStartS, towerMat);
  addBridgeTower(group, track, mainEndS, towerMat);

  const cableMat = new THREE.MeshStandardMaterial({
    color: 0x9af5ff, emissive: 0x42bfd4, emissiveIntensity: 0.5,
    roughness: 0.35, metalness: 0.6,
  });
  const hangerPositions = [];
  for (const side of [-1, 1]) {
    const points = [];
    for (let i = 0; i <= 14; i++) {
      const t = i / 14;
      const s = mainStartS + (mainEndS - mainStartS) * t;
      const lateral = side * (track.halfWidthAt(s) + track.runoffAt(s) - 0.45);
      const p = track.toWorld(s, lateral, {});
      const cableRise = 2.2 + 4.8 * Math.pow(t * 2 - 1, 2);
      points.push(new THREE.Vector3(p.x, p.y + cableRise, p.z));
      if (i > 0 && i < 14 && i % 2 === 0) {
        hangerPositions.push(p.x, p.y + 1.45, p.z, p.x, p.y + cableRise, p.z);
      }
    }
    const cable = new THREE.Mesh(
      new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 72, 0.11, 6, false),
      cableMat,
    );
    cable.name = `bridge-cable-${side}`;
    cable.castShadow = false;
    freeze(cable);
    group.add(cable);
  }
  const hangerGeo = new THREE.BufferGeometry();
  hangerGeo.setAttribute('position', new THREE.Float32BufferAttribute(hangerPositions, 3));
  const hangers = new THREE.LineSegments(
    hangerGeo,
    new THREE.LineBasicMaterial({ color: 0x8eeeff, transparent: true, opacity: 0.72 }),
  );
  hangers.name = 'bridge-hangers';
  freeze(hangers);
  group.add(hangers);
}

/**
 * Contiguous high-curvature arcs, each tagged with the inside of the turn:
 * +1 = right-hand turn (kerb on +lateral), -1 = left-hand turn.
 * @returns {Array<{start:number,count:number,side:number}>}
 */
function findKerbRuns(spline) {
  const n = spline.count;
  const side = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    const k = spline.curvature[i];
    side[i] = k > KERB_MIN_CURVATURE ? 1 : k < -KERB_MIN_CURVATURE ? -1 : 0;
  }
  // Extend each arc a little so kerbs begin before the apex.
  const dilated = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    if (side[i] === 0) continue;
    for (let o = -KERB_DILATE; o <= KERB_DILATE; o++) {
      const j = pmod(i + o, n);
      if (dilated[j] === 0) dilated[j] = side[i];
    }
  }

  const runs = [];
  let runStart = -1;
  let runSide = 0;
  for (let i = 0; i < n; i++) {
    const s = dilated[i];
    if (s === runSide) continue;
    if (runSide !== 0) runs.push({ start: runStart, count: i - runStart, side: runSide });
    runStart = i;
    runSide = s;
  }
  if (runSide !== 0) runs.push({ start: runStart, count: n - runStart, side: runSide });

  // Merge a run that wraps across the s=0 seam.
  if (runs.length >= 2) {
    const first = runs[0];
    const last = runs[runs.length - 1];
    if (first.start === 0 && last.start + last.count === n && first.side === last.side) {
      last.count += first.count;
      runs.shift();
    }
  }
  return runs.filter((r) => r.count >= KERB_MIN_RUN);
}

function buildStartLineGeometry(track) {
  const sm = track.spline.sampleAt(0, {});
  const hw = track.halfWidthAt(0);
  const fl = Math.hypot(sm.tx, sm.tz) || 1;
  const fx = sm.tx / fl;
  const fz = sm.tz / fl;

  const positions = new Float32Array(12);
  const put = (o, lat, fwd) => {
    positions[o] = sm.x + sm.rx * lat + fx * fwd;
    positions[o + 1] = sm.y + START_LIFT;
    positions[o + 2] = sm.z + sm.rz * lat + fz * fwd;
  };
  put(0, -hw, -START_HALF_LENGTH);
  put(3, hw, -START_HALF_LENGTH);
  put(6, -hw, START_HALF_LENGTH);
  put(9, hw, START_HALF_LENGTH);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), 2));
  geo.setIndex([0, 2, 3, 0, 3, 1]);
  geo.computeVertexNormals();
  return geo;
}

function freeze(obj) {
  obj.updateMatrix();
  obj.matrixAutoUpdate = false;
}

/**
 * Build the complete static track group: road, edge lines, centre dashes,
 * kerbs, offroad skirts, boundary walls, start/finish line.
 * @param {import('../track/track.js').Track} track
 * @returns {THREE.Group}
 */
export function buildTrackMesh(track) {
  const theme = track.theme || {};
  const sp = track.spline;
  const group = new THREE.Group();
  group.name = `track:${track.id}`;

  const texRng = new Rng(`trackmesh:${track.id}`);
  const roadV = loopPeriod(track.length, ROAD_V_PERIOD);
  const dashV = loopPeriod(track.length, DASH_V_PERIOD);

  const addMesh = (geo, mat, name, { shadow = true, order = 0 } = {}) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.receiveShadow = shadow;
    mesh.castShadow = false;
    if (order !== 0) mesh.renderOrder = order;
    freeze(mesh);
    group.add(mesh);
    return mesh;
  };

  // --- Road ribbon -----------------------------------------------------------
  const asphaltTex = makeSpeckleTexture(texRng, '#d6d6da', 900);
  asphaltTex.repeat.set(3, 1);
  const roadMat = new THREE.MeshStandardMaterial({
    color: theme.road ?? 0x3c414c,
    map: asphaltTex,
    roughness: 0.96,
    metalness: 0,
  });
  addMesh(
    buildRibbonGeometry(track, { latA: (hw) => -hw, latB: (hw) => hw, vPeriod: roadV }),
    roadMat, 'road'
  );

  // --- Local low-grip ice sheets -----------------------------------------------
  if (track.gripZones.length > 0) {
    const iceMat = new THREE.MeshStandardMaterial({
      color: 0xbdefff,
      emissive: 0x2a7896,
      emissiveIntensity: 0.14,
      map: makeIceTexture(texRng),
      transparent: true,
      opacity: 0.52,
      depthWrite: false,
      roughness: 0.22,
      metalness: 0.12,
    });
    for (const zone of track.gripZones) {
      addMesh(buildRibbonGeometry(track, {
        latA: (hw) => -hw, latB: (hw) => hw,
        yA: ICE_LIFT, yB: ICE_LIFT,
        vPeriod: 8,
        range: rangeFromArc(track, zone.start, zone.end),
      }), iceMat, `ice@${zone.start.toFixed(0)}`, { shadow: false, order: 1 });
    }
  }

  // --- Offroad skirts (droop toward the outer boundary) -----------------------
  const dirtTex = makeSpeckleTexture(texRng, '#d0cec6', 700);
  dirtTex.repeat.set(4, 1);
  const skirtMat = new THREE.MeshStandardMaterial({
    color: theme.offroad ?? 0x7c9a5f,
    map: dirtTex,
    roughness: 1,
    metalness: 0,
  });
  addMesh(
    buildRibbonGeometry(track, {
      latA: (hw, i) => -(hw + track.runoffAt(i * sp.spacing)), latB: (hw) => -hw,
      yA: -SKIRT_DROP_OUT, yB: -SKIRT_DROP_IN, vPeriod: roadV,
    }),
    skirtMat, 'skirt-left'
  );
  addMesh(
    buildRibbonGeometry(track, {
      latA: (hw) => hw, latB: (hw, i) => hw + track.runoffAt(i * sp.spacing),
      yA: -SKIRT_DROP_IN, yB: -SKIRT_DROP_OUT, vPeriod: roadV,
    }),
    skirtMat, 'skirt-right'
  );

  // --- White (theme.roadEdge) edge lines --------------------------------------
  const edgeMat = new THREE.MeshStandardMaterial({
    color: theme.roadEdge ?? 0xf0f0f0,
    emissive: theme.roadEdge ?? 0xf0f0f0,
    emissiveIntensity: 0.12,
    roughness: 0.6,
    metalness: 0,
  });
  const edgeIn = EDGE_INSET + EDGE_WIDTH;
  addMesh(
    buildRibbonGeometry(track, {
      latA: (hw) => -(hw - EDGE_INSET), latB: (hw) => -(hw - edgeIn),
      yA: PAINT_LIFT, yB: PAINT_LIFT, vPeriod: roadV,
    }),
    edgeMat, 'edge-left'
  );
  addMesh(
    buildRibbonGeometry(track, {
      latA: (hw) => hw - edgeIn, latB: (hw) => hw - EDGE_INSET,
      yA: PAINT_LIFT, yB: PAINT_LIFT, vPeriod: roadV,
    }),
    edgeMat, 'edge-right'
  );

  // --- Centre dashed line ------------------------------------------------------
  const dashMat = new THREE.MeshStandardMaterial({
    color: theme.roadEdge ?? 0xf0f0f0,
    map: makeDashTexture(),
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    roughness: 0.7,
    metalness: 0,
  });
  addMesh(
    buildRibbonGeometry(track, {
      latA: () => -0.16, latB: () => 0.16,
      yA: PAINT_LIFT, yB: PAINT_LIFT, vPeriod: dashV,
    }),
    dashMat, 'centre-dash', { order: 1 }
  );

  // --- Kerbs on the inside edge of sharp turns ---------------------------------
  const kerbMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: makeKerbTexture(),
    roughness: 0.55,
    metalness: 0,
  });
  for (const run of findKerbRuns(track.spline)) {
    // curvature > 0 turns right, so the inside of the turn is +lateral.
    const sideSign = run.side;
    const geo = buildRibbonGeometry(track, {
      latA: (hw) => sideSign > 0 ? hw - KERB_INSET : -(hw + KERB_REACH),
      latB: (hw) => sideSign > 0 ? hw + KERB_REACH : -(hw - KERB_INSET),
      yA: sideSign > 0 ? KERB_LIFT_IN : KERB_LIFT_OUT,
      yB: sideSign > 0 ? KERB_LIFT_OUT : KERB_LIFT_IN,
      vPeriod: KERB_V_PERIOD,
      range: { start: run.start, count: run.count + 1 },
    });
    addMesh(geo, kerbMat, `kerb@${run.start}`);
  }

  // --- Low boundary wall at the offroad edge (always — reads as a clean barrier) --
  const wallMat = new THREE.MeshStandardMaterial({
    color: theme.wall ?? 0x8899aa,
    emissive: theme.wall ?? 0x8899aa,
    emissiveIntensity: 0.08,
    transparent: true,
    opacity: 0.95,
    side: THREE.DoubleSide,
    roughness: 0.5,
    metalness: 0,
  });
  addMesh(
    buildRibbonGeometry(track, {
      latA: (hw, i) => -(hw + track.runoffAt(i * sp.spacing)),
      latB: (hw, i) => -(hw + track.runoffAt(i * sp.spacing)),
      yA: -WALL_DROP, yB: -WALL_DROP + WALL_HEIGHT, vPeriod: roadV,
    }),
    wallMat, 'wall-left'
  );
  addMesh(
    buildRibbonGeometry(track, {
      latA: (hw, i) => hw + track.runoffAt(i * sp.spacing),
      latB: (hw, i) => hw + track.runoffAt(i * sp.spacing),
      yA: -WALL_DROP, yB: -WALL_DROP + WALL_HEIGHT, vPeriod: roadV,
    }),
    wallMat, 'wall-right'
  );

  // --- Start/finish line ---------------------------------------------------------
  const startTex = makeCheckerTexture(16, 2);
  const startMat = new THREE.MeshStandardMaterial({
    map: startTex,
    roughness: 0.7,
    metalness: 0,
  });
  addMesh(buildStartLineGeometry(track), startMat, 'start-line', { order: 1 });

  // --- Authored large structures -------------------------------------------------
  for (const structure of track.structures) {
    if (structure.kind === 'tunnel') addTunnelStructure(group, track, structure);
    else if (structure.kind === 'bridge') addBridgeStructure(group, track, structure);
  }

  freeze(group);
  return group;
}
