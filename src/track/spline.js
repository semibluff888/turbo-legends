// Closed centripetal Catmull-Rom spline with an arc-length lookup table.
// Pure math on plain {x,y,z} objects so it can be unit-tested under Node
// without a WebGL context.

import { clamp, pmod } from '../core/mathx.js';

const EPS = 1e-9;
const PROJECTION_CONTINUITY_RADIUS = 42;
const PROJECTION_ARC_WEIGHT = 1.25;

/**
 * Centripetal Catmull-Rom (alpha = 0.5) avoids the cusps and self-intersections
 * that uniform Catmull-Rom produces when control points are unevenly spaced —
 * which matters a lot for hand-authored race tracks.
 */
function catmullRom(p0, p1, p2, p3, t, alpha, out) {
  const d01 = Math.pow(dist(p0, p1), alpha);
  const d12 = Math.pow(dist(p1, p2), alpha);
  const d23 = Math.pow(dist(p2, p3), alpha);

  // Degenerate spacing — fall back to linear so we never divide by zero.
  if (d01 < EPS || d12 < EPS || d23 < EPS) {
    out.x = p1.x + (p2.x - p1.x) * t;
    out.y = p1.y + (p2.y - p1.y) * t;
    out.z = p1.z + (p2.z - p1.z) * t;
    return out;
  }

  const t0 = 0;
  const t1 = t0 + d01;
  const t2 = t1 + d12;
  const t3 = t2 + d23;
  const tt = t1 + (t2 - t1) * t;

  const a1 = lerpP(p0, p1, (tt - t0) / (t1 - t0));
  const a2 = lerpP(p1, p2, (tt - t1) / (t2 - t1));
  const a3 = lerpP(p2, p3, (tt - t2) / (t3 - t2));
  const b1 = lerpP(a1, a2, (tt - t0) / (t2 - t0));
  const b2 = lerpP(a2, a3, (tt - t1) / (t3 - t1));
  const c = lerpP(b1, b2, (tt - t1) / (t2 - t1));

  out.x = c.x;
  out.y = c.y;
  out.z = c.z;
  return out;
}

function dist(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) || EPS;
}

function lerpP(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

function loopDistance(a, b, length) {
  const direct = Math.abs(pmod(a, length) - pmod(b, length));
  return Math.min(direct, length - direct);
}

function projectionSampleD2(spline, x, y, z, useHeight, i) {
  const dx = x - spline.px[i];
  const dz = z - spline.pz[i];
  const dy = useHeight ? y - spline.py[i] : 0;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * A closed spline resampled at (near-)uniform arc length.
 *
 * After construction the authoritative representation is `samples` — a dense
 * ring of points with precomputed tangents, right-vectors and cumulative
 * distance. All queries interpolate between samples, which keeps every lookup
 * O(1) after an O(log n) or O(1) index search.
 */
export class ClosedSpline {
  /**
   * @param {Array<{x:number,y?:number,z:number}>} controlPoints ordered around the loop
   * @param {{samplesPerSegment?:number, alpha?:number}} [opts]
   */
  constructor(controlPoints, opts = {}) {
    if (!Array.isArray(controlPoints) || controlPoints.length < 3) {
      throw new Error('ClosedSpline needs at least 3 control points');
    }
    const alpha = opts.alpha ?? 0.5;
    const per = Math.max(4, opts.samplesPerSegment ?? 26);

    const cps = controlPoints.map((p) => ({ x: p.x, y: p.y ?? 0, z: p.z }));
    const n = cps.length;

    // --- Dense positional sampling around the closed loop ------------------
    const pts = [];
    const tmp = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < n; i++) {
      const p0 = cps[(i - 1 + n) % n];
      const p1 = cps[i];
      const p2 = cps[(i + 1) % n];
      const p3 = cps[(i + 2) % n];
      for (let j = 0; j < per; j++) {
        catmullRom(p0, p1, p2, p3, j / per, alpha, tmp);
        pts.push({ x: tmp.x, y: tmp.y, z: tmp.z });
      }
    }

    // --- Cumulative arc length (closing segment included) ------------------
    const m = pts.length;
    const cum = new Float64Array(m + 1);
    for (let i = 0; i < m; i++) {
      cum[i + 1] = cum[i] + dist(pts[i], pts[(i + 1) % m]);
    }
    const total = cum[m];

    // --- Resample at uniform arc length -----------------------------------
    // Uniform spacing makes index lookup O(1) (`s / spacing`) instead of a
    // binary search, and keeps AI look-ahead distances meaningful.
    const targetSpacing = opts.spacing ?? 1.0;
    const count = Math.max(16, Math.round(total / targetSpacing));
    const spacing = total / count;

    const px = new Float64Array(count);
    const py = new Float64Array(count);
    const pz = new Float64Array(count);

    let seg = 0;
    for (let i = 0; i < count; i++) {
      const target = i * spacing;
      while (seg < m - 1 && cum[seg + 1] < target) seg++;
      const segLen = cum[seg + 1] - cum[seg] || EPS;
      const t = clamp((target - cum[seg]) / segLen, 0, 1);
      const a = pts[seg];
      const b = pts[(seg + 1) % m];
      px[i] = a.x + (b.x - a.x) * t;
      py[i] = a.y + (b.y - a.y) * t;
      pz[i] = a.z + (b.z - a.z) * t;
    }

    // --- Tangents / right vectors / curvature -----------------------------
    const tx = new Float64Array(count);
    const ty = new Float64Array(count);
    const tz = new Float64Array(count);
    const rx = new Float64Array(count);
    const rz = new Float64Array(count);
    const heading = new Float64Array(count);
    const curvature = new Float64Array(count);

    for (let i = 0; i < count; i++) {
      const a = (i - 1 + count) % count;
      const b = (i + 1) % count;
      let dx = px[b] - px[a];
      let dy = py[b] - py[a];
      let dz = pz[b] - pz[a];
      const len = Math.hypot(dx, dy, dz) || EPS;
      dx /= len; dy /= len; dz /= len;
      tx[i] = dx; ty[i] = dy; tz[i] = dz;

      // Right vector on the horizontal plane: rotate the flattened tangent -90°.
      const flat = Math.hypot(dx, dz) || EPS;
      rx[i] = dz / flat;
      rz[i] = -dx / flat;

      // Heading measured the same way the karts measure yaw: atan2(x, z).
      heading[i] = Math.atan2(dx, dz);
    }

    // Curvature from the heading derivative — signed, positive = turning right.
    for (let i = 0; i < count; i++) {
      const a = (i - 1 + count) % count;
      const b = (i + 1) % count;
      let dh = heading[b] - heading[a];
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      curvature[i] = dh / (2 * spacing);
    }

    this.count = count;
    this.spacing = spacing;
    this.length = count * spacing;
    this.px = px; this.py = py; this.pz = pz;
    this.tx = tx; this.ty = ty; this.tz = tz;
    this.rx = rx; this.rz = rz;
    this.heading = heading;
    this.curvature = curvature;

    this._buildGrid();
  }

  /**
   * Uniform bucket grid over the XZ bounding box, mapping each cell to the
   * sample indices near it. Turns `project()` from O(n) into a small local scan.
   */
  _buildGrid() {
    const { px, pz, count } = this;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < count; i++) {
      if (px[i] < minX) minX = px[i];
      if (px[i] > maxX) maxX = px[i];
      if (pz[i] < minZ) minZ = pz[i];
      if (pz[i] > maxZ) maxZ = pz[i];
    }
    const pad = 60;
    minX -= pad; minZ -= pad; maxX += pad; maxZ += pad;

    const cell = 12;
    const cols = Math.max(1, Math.ceil((maxX - minX) / cell));
    const rows = Math.max(1, Math.ceil((maxZ - minZ) / cell));
    const buckets = new Array(cols * rows);

    this._grid = { minX, minZ, cell, cols, rows, buckets };

    // Register each sample into its own cell and the 8 neighbours, so a point
    // anywhere in a cell always sees every candidate within ~one cell radius.
    for (let i = 0; i < count; i++) {
      const cx = Math.floor((px[i] - minX) / cell);
      const cz = Math.floor((pz[i] - minZ) / cell);
      for (let ox = -1; ox <= 1; ox++) {
        for (let oz = -1; oz <= 1; oz++) {
          const gx = cx + ox;
          const gz = cz + oz;
          if (gx < 0 || gz < 0 || gx >= cols || gz >= rows) continue;
          const key = gz * cols + gx;
          (buckets[key] || (buckets[key] = [])).push(i);
        }
      }
    }
  }

  /** Sample index for an arc-length position (wraps). */
  indexAt(s) {
    return pmod(Math.floor(pmod(s, this.length) / this.spacing), this.count);
  }

  /**
   * Interpolated sample at arc length `s` (wraps automatically).
   * Writes into `out` to avoid per-frame allocation.
   */
  sampleAt(s, out = {}) {
    const ls = pmod(s, this.length);
    const fi = ls / this.spacing;
    const i0 = Math.floor(fi) % this.count;
    const i1 = (i0 + 1) % this.count;
    const t = fi - Math.floor(fi);

    out.x = this.px[i0] + (this.px[i1] - this.px[i0]) * t;
    out.y = this.py[i0] + (this.py[i1] - this.py[i0]) * t;
    out.z = this.pz[i0] + (this.pz[i1] - this.pz[i0]) * t;

    out.tx = this.tx[i0] + (this.tx[i1] - this.tx[i0]) * t;
    out.ty = this.ty[i0] + (this.ty[i1] - this.ty[i0]) * t;
    out.tz = this.tz[i0] + (this.tz[i1] - this.tz[i0]) * t;
    const tl = Math.hypot(out.tx, out.ty, out.tz) || EPS;
    out.tx /= tl; out.ty /= tl; out.tz /= tl;

    out.rx = this.rx[i0] + (this.rx[i1] - this.rx[i0]) * t;
    out.rz = this.rz[i0] + (this.rz[i1] - this.rz[i0]) * t;
    const rl = Math.hypot(out.rx, out.rz) || EPS;
    out.rx /= rl; out.rz /= rl;

    // Heading interpolates along the shortest arc so the ±PI seam is smooth.
    let dh = this.heading[i1] - this.heading[i0];
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    out.heading = this.heading[i0] + dh * t;

    out.curvature = this.curvature[i0] + (this.curvature[i1] - this.curvature[i0]) * t;
    out.s = ls;
    return out;
  }

  /** Position only — cheaper when tangents aren't needed. */
  positionAt(s, out = {}) {
    const ls = pmod(s, this.length);
    const fi = ls / this.spacing;
    const i0 = Math.floor(fi) % this.count;
    const i1 = (i0 + 1) % this.count;
    const t = fi - Math.floor(fi);
    out.x = this.px[i0] + (this.px[i1] - this.px[i0]) * t;
    out.y = this.py[i0] + (this.py[i1] - this.py[i0]) * t;
    out.z = this.pz[i0] + (this.pz[i1] - this.pz[i0]) * t;
    return out;
  }

  /**
   * Project a world point onto the spline.
   * Returns { s, lateral, dist, index } where `lateral` is signed distance
   * along the right-vector (positive = right of the direction of travel).
   *
   * @param {number} hintS optional previous arc-length, used to disambiguate
   *   when the track passes near itself (overlaps / figure-eights).
   * @param {number} y optional world height, used to distinguish stacked roads.
   */
  project(x, z, out = {}, hintS = null, y = null) {
    const g = this._grid;
    const gx = Math.floor((x - g.minX) / g.cell);
    const gz = Math.floor((z - g.minZ) / g.cell);
    const useHeight = Number.isFinite(y);
    let continuityS = hintS;

    let best = -1;
    let bestD2 = Infinity;

    if (gx >= 0 && gz >= 0 && gx < g.cols && gz < g.rows) {
      const bucket = g.buckets[gz * g.cols + gx];
      if (bucket) {
        for (let k = 0; k < bucket.length; k++) {
          const i = bucket[k];
          const d2 = projectionSampleD2(this, x, y, z, useHeight, i);
          if (d2 < bestD2) { bestD2 = d2; best = i; }
        }
      }
    }

    // Outside the grid or an empty cell (far off-track) — brute force.
    if (best < 0) {
      for (let i = 0; i < this.count; i++) {
        const d2 = projectionSampleD2(this, x, y, z, useHeight, i);
        if (d2 < bestD2) { bestD2 = d2; best = i; }
      }
    }

    // Where the track overlaps itself, the geometrically nearest sample can be
    // on the wrong pass. Prefer a candidate consistent with the caller's hint.
    if (hintS != null) {
      const hs = pmod(hintS, this.length);
      const hfi = hs / this.spacing;
      const hi0 = Math.floor(hfi) % this.count;
      const hi1 = (hi0 + 1) % this.count;
      const ht = hfi - Math.floor(hfi);
      const hx = this.px[hi0] + (this.px[hi1] - this.px[hi0]) * ht;
      const hz = this.pz[hi0] + (this.pz[hi1] - this.pz[hi0]) * ht;
      let htx = this.tx[hi0] + (this.tx[hi1] - this.tx[hi0]) * ht;
      let htz = this.tz[hi0] + (this.tz[hi1] - this.tz[hi0]) * ht;
      const htLen = Math.hypot(htx, htz) || EPS;
      htx /= htLen;
      htz /= htLen;

      // Predict progress from the query's displacement along the hinted
      // tangent. Lateral off-road motion therefore stays on the same segment,
      // while cameras and entities a few metres ahead/behind can still move
      // their projection naturally instead of being pinned to the old s.
      const along = (x - hx) * htx + (z - hz) * htz;
      continuityS = hintS + clamp(along, -40, 40);

      const continuityLocal = pmod(continuityS, this.length);
      const continuityIndex = Math.floor(continuityLocal / this.spacing);
      const hintIdx = pmod(continuityIndex, this.count);
      const continuityOffset = continuityLocal - continuityIndex * this.spacing;
      const window = Math.max(8, Math.ceil(40 / this.spacing));
      let hintBest = -1;
      let hintBestD2 = Infinity;
      let hintBestScore = Infinity;
      for (let o = -window; o <= window; o++) {
        const i = pmod(hintIdx + o, this.count);
        const d2 = projectionSampleD2(this, x, y, z, useHeight, i);
        const ds = o * this.spacing - continuityOffset;
        const continuity = ds * PROJECTION_ARC_WEIGHT;
        const score = d2 + continuity * continuity;
        if (score < hintBestScore) {
          hintBestScore = score;
          hintBestD2 = d2;
          hintBest = i;
        }
      }
      // A supplied hint represents continuity from the previous simulation
      // step. Prefer it anywhere inside a generous drivable/recovery radius;
      // at a vertical crossover the other deck may be an exact XZ match, so
      // geometric distance alone cannot decide which pass owns the point.
      if (hintBest >= 0
          && hintBestD2 <= PROJECTION_CONTINUITY_RADIUS * PROJECTION_CONTINUITY_RADIUS) {
        best = hintBest;
        bestD2 = hintBestD2;
      }
    }

    // Refine against the two adjacent segments for sub-sample accuracy.
    const refine = (i) => {
      const j = (i + 1) % this.count;
      const ax = this.px[i], ay = this.py[i], az = this.pz[i];
      const bx = this.px[j], by = this.py[j], bz = this.pz[j];
      const ex = bx - ax, ez = bz - az;
      const len2 = ex * ex + ez * ez || EPS;
      const t = clamp(((x - ax) * ex + (z - az) * ez) / len2, 0, 1);
      const cx = ax + ex * t, cz = az + ez * t;
      const cy = ay + (by - ay) * t;
      const dx = x - cx, dz = z - cz;
      const dy = useHeight ? y - cy : 0;
      const horizontalD2 = dx * dx + dz * dz;
      const s = (i + t) * this.spacing;
      const continuity = hintS == null
        ? 0
        : loopDistance(s, continuityS, this.length) * PROJECTION_ARC_WEIGHT;
      return {
        d2: horizontalD2,
        score: horizontalD2 + dy * dy + continuity * continuity,
        s,
        i,
        t,
        cy,
      };
    };

    const c1 = refine(best);
    const c2 = refine(pmod(best - 1, this.count));
    const chosen = c2.score < c1.score ? c2 : c1;

    const s = pmod(chosen.s, this.length);
    const i0 = chosen.i;
    const i1 = (i0 + 1) % this.count;
    const t = chosen.t;

    const cx = this.px[i0] + (this.px[i1] - this.px[i0]) * t;
    const cz = this.pz[i0] + (this.pz[i1] - this.pz[i0]) * t;
    let rxv = this.rx[i0] + (this.rx[i1] - this.rx[i0]) * t;
    let rzv = this.rz[i0] + (this.rz[i1] - this.rz[i0]) * t;
    const rl = Math.hypot(rxv, rzv) || EPS;
    rxv /= rl; rzv /= rl;

    out.s = s;
    out.index = i0;
    out.lateral = (x - cx) * rxv + (z - cz) * rzv;
    out.dist = Math.sqrt(chosen.d2);
    out.cx = cx;
    out.cy = chosen.cy;
    out.cz = cz;
    return out;
  }

  /** Ground height at an arc-length position. */
  heightAt(s) {
    const ls = pmod(s, this.length);
    const fi = ls / this.spacing;
    const i0 = Math.floor(fi) % this.count;
    const i1 = (i0 + 1) % this.count;
    const t = fi - Math.floor(fi);
    return this.py[i0] + (this.py[i1] - this.py[i0]) * t;
  }
}
