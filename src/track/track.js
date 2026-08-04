// Track: the spline plus everything gameplay needs to ask about the world.
// Pure logic (no THREE) so the whole race can be simulated headlessly in tests.

import { ClosedSpline } from './spline.js';
import { SURFACE, ITEM_BOX_RESPAWN, BOUNDS } from '../core/constants.js';
import { clamp, lerp, pmod, loopDelta } from '../core/mathx.js';

/**
 * @typedef {object} TrackDef
 * @property {string} id
 * @property {string} name
 * @property {string} [subtitle]
 * @property {Array<{x:number,y?:number,z:number,w?:number,runoff?:number}>} points control points;
 *   `w` overrides road width and `runoff` overrides the drivable strip beyond each road edge
 * @property {number} width default half-width is width/2
 * @property {number} [runoff] default drivable strip beyond each road edge
 * @property {number} [laps]
 * @property {Array<{s:number, lateral?:number, width?:number, length?:number}>} [boostPads]
 * @property {Array<{s:number, lateral?:number}>} [itemBoxes] positions along the track
 * @property {Array<{startFrac:number,endFrac:number,grip?:number,driftGrip?:number}>} [gripZones]
 * @property {Array<object>} [structures] render-only authored tunnel/bridge ranges
 * @property {object} [theme] colors for the renderer
 */

export class Track {
  /** @param {TrackDef} def */
  constructor(def) {
    this.def = def;
    this.id = def.id;
    this.name = def.name;
    this.subtitle = def.subtitle || '';
    this.laps = def.laps ?? 3;
    this.theme = def.theme || {};

    this.spline = new ClosedSpline(def.points, { spacing: def.spacing ?? 1.0 });
    this.length = this.spline.length;

    this._buildWidthTable(def);
    this._buildRunoffTable(def);
    this._buildGripZones(def);
    this._buildBoostPads(def);
    this._buildItemBoxes(def);
    this.structures = (def.structures || []).map((structure) => ({ ...structure }));

    // Scratch objects reused by per-frame queries to avoid GC churn.
    this._proj = {};
    this._samp = {};
  }

  // -------------------------------------------------------------------------
  // Width
  // -------------------------------------------------------------------------

  _buildPointProfile(def, baseValue, valueOf) {
    const n = this.spline.count;
    const profile = new Float64Array(n);

    // Control points may override width; spread those overrides smoothly around
    // the loop so the road tapers instead of stepping.
    const overrides = [];
    const cps = def.points;
    const perCp = this.length / cps.length;
    for (let i = 0; i < cps.length; i++) {
      const value = valueOf(cps[i]);
      if (value != null) {
        // Approximate arc position of this control point.
        const p = this.spline.project(cps[i].x, cps[i].z, {}, null, cps[i].y ?? 0);
        overrides.push({ s: p.s, value });
      }
    }

    if (overrides.length === 0) {
      profile.fill(baseValue);
    } else {
      for (let i = 0; i < n; i++) {
        const s = i * this.spline.spacing;
        // Inverse-distance weighting over the loop, falling back to base width.
        let num = 0;
        let den = 0;
        for (const o of overrides) {
          const d = Math.abs(loopDelta(s, o.s, this.length));
          const falloff = Math.max(1e-3, Math.pow(Math.max(0, 1 - d / (perCp * 1.6)), 2));
          num += o.value * falloff;
          den += falloff;
        }
        const blend = clamp(den, 0, 1);
        profile[i] = lerp(baseValue, den > 0 ? num / den : baseValue, blend);
      }
    }
    return profile;
  }

  _buildWidthTable(def) {
    const baseHalf = (def.width ?? 20) / 2;
    const half = this._buildPointProfile(def, baseHalf, (point) => (
      point.w == null ? null : point.w / 2
    ));

    this.halfWidths = half;
    this.baseHalfWidth = baseHalf;
  }

  _profileAt(profile, s) {
    const n = this.spline.count;
    const fi = pmod(s, this.length) / this.spline.spacing;
    const i0 = Math.floor(fi) % n;
    const i1 = (i0 + 1) % n;
    const t = fi - Math.floor(fi);
    return lerp(profile[i0], profile[i1], t);
  }

  /** Drivable half-width at arc length `s`. */
  halfWidthAt(s) {
    return this._profileAt(this.halfWidths, s);
  }

  // -------------------------------------------------------------------------
  // Runoff / grip profiles
  // -------------------------------------------------------------------------

  _buildRunoffTable(def) {
    this.baseRunoff = def.runoff ?? BOUNDS.offroadExtent;
    this.runoffWidths = this._buildPointProfile(
      def,
      this.baseRunoff,
      (point) => point.runoff ?? null,
    );
  }

  /** Drivable strip beyond either road edge at arc length `s`. */
  runoffAt(s) {
    return this._profileAt(this.runoffWidths, s);
  }

  _rangeS(frac, absolute, isEnd = false) {
    if (frac != null) {
      if (isEnd && frac === 1) return this.length;
      return pmod(frac * this.length, this.length);
    }
    if (isEnd && absolute === this.length) return this.length;
    return pmod(absolute ?? 0, this.length);
  }

  _buildGripZones(def) {
    this.gripZones = (def.gripZones || []).map((zone) => ({
      start: this._rangeS(zone.startFrac, zone.start),
      end: this._rangeS(zone.endFrac, zone.end, true),
      grip: clamp(zone.grip ?? 1, 0.05, 1),
      driftGrip: clamp(zone.driftGrip ?? zone.grip ?? 1, 0.05, 1),
    }));
  }

  /** Grip multiplier at `s`; ice affects ordinary and drift grip independently. */
  gripAt(s, drifting = false) {
    const ls = pmod(s, this.length);
    let grip = 1;
    for (const zone of this.gripZones) {
      const inside = zone.start <= zone.end
        ? ls >= zone.start && ls <= zone.end
        : ls >= zone.start || ls <= zone.end;
      if (inside) grip = Math.min(grip, drifting ? zone.driftGrip : zone.grip);
    }
    return grip;
  }

  // -------------------------------------------------------------------------
  // Boost pads
  // -------------------------------------------------------------------------

  /**
   * Resolve an authored position to arc length. Definitions may use `sFrac`
   * (0..1 around the loop, the preferred form since it survives edits to the
   * control points) or an absolute `s`.
   */
  _resolveS(entry) {
    if (entry.sFrac != null) return pmod(entry.sFrac * this.length, this.length);
    return pmod(entry.s ?? 0, this.length);
  }

  _buildBoostPads(def) {
    this.boostPads = (def.boostPads || []).map((p, i) => ({
      id: i,
      s: this._resolveS(p),
      lateral: p.lateral ?? 0,
      halfWidth: (p.width ?? 5) / 2,
      halfLength: (p.length ?? 7) / 2,
    }));
  }

  /** True when the given track-space position is on a boost pad. */
  isOnBoostPad(s, lateral) {
    for (const pad of this.boostPads) {
      if (Math.abs(loopDelta(pad.s, s, this.length)) > pad.halfLength) continue;
      if (Math.abs(lateral - pad.lateral) > pad.halfWidth) continue;
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Item boxes
  // -------------------------------------------------------------------------

  _buildItemBoxes(def) {
    this.itemBoxes = (def.itemBoxes || []).map((b, i) => ({
      id: i,
      s: this._resolveS(b),
      lateral: b.lateral ?? 0,
      active: true,
      respawnAt: 0,
      // World position is filled in by `refreshItemBoxPositions`.
      x: 0, y: 0, z: 0,
    }));
    this.refreshItemBoxPositions();
  }

  refreshItemBoxPositions() {
    const s = {};
    for (const box of this.itemBoxes) {
      this.spline.sampleAt(box.s, s);
      box.x = s.x + s.rx * box.lateral;
      box.y = s.y + 1.1;
      box.z = s.z + s.rz * box.lateral;
    }
  }

  /** Reset every box to active — called on race restart. */
  resetItemBoxes() {
    for (const box of this.itemBoxes) {
      box.active = true;
      box.respawnAt = 0;
    }
  }

  /** Advance item box respawn timers. `now` is race time in seconds. */
  updateItemBoxes(now) {
    for (const box of this.itemBoxes) {
      if (!box.active && now >= box.respawnAt) box.active = true;
    }
  }

  consumeItemBox(box, now) {
    box.active = false;
    box.respawnAt = now + ITEM_BOX_RESPAWN;
  }

  // -------------------------------------------------------------------------
  // World queries
  // -------------------------------------------------------------------------

  /**
   * Full surface query for a world position.
   * `hintS` should be the entity's last known arc-length — it disambiguates
   * self-overlapping track sections. `worldY` additionally distinguishes
   * vertically stacked roads when it is available.
   *
   * @returns {{s:number, lateral:number, halfWidth:number, surface:string,
   *            offTrackDepth:number, height:number, heading:number,
   *            curvature:number, cx:number, cz:number}}
   */
  sampleWorld(x, z, hintS = null, out = {}, worldY = null) {
    const p = this.spline.project(x, z, this._proj, hintS, worldY);
    const halfWidth = this.halfWidthAt(p.s);
    const absLat = Math.abs(p.lateral);

    const sm = this.spline.sampleAt(p.s, this._samp);

    out.s = p.s;
    out.lateral = p.lateral;
    out.halfWidth = halfWidth;
    out.cx = p.cx;
    out.cz = p.cz;
    out.height = sm.y;
    out.heading = sm.heading;
    out.curvature = sm.curvature;
    out.offTrackDepth = Math.max(0, absLat - halfWidth);
    out.runoff = this.runoffAt(p.s);

    if (out.offTrackDepth > 0) {
      out.surface = SURFACE.OFFROAD;
    } else if (this.isOnBoostPad(p.s, p.lateral)) {
      out.surface = SURFACE.BOOST;
    } else {
      out.surface = SURFACE.ROAD;
    }
    return out;
  }

  /** Convert track space (arc length + lateral) to a world position. */
  toWorld(s, lateral, out = {}) {
    const sm = this.spline.sampleAt(s, this._samp);
    out.x = sm.x + sm.rx * lateral;
    out.y = sm.y;
    out.z = sm.z + sm.rz * lateral;
    out.heading = sm.heading;
    return out;
  }

  /**
   * Starting grid slot for position `i` (0-based), 2 karts per row.
   * Returns a world position + heading facing along the track.
   */
  gridSlot(i, total, rowSpacing, columnOffset, out = {}) {
    const row = Math.floor(i / 2);
    const col = i % 2 === 0 ? -1 : 1;
    // Start line is at s = 0; the grid stretches backwards from it.
    const s = pmod(-(6 + row * rowSpacing), this.length);
    const lateral = col * columnOffset;
    this.toWorld(s, lateral, out);
    out.s = s;
    return out;
  }

  /**
   * The "ideal" racing-line lateral offset at `s`, derived from curvature:
   * hug the inside of a corner. Used by AI and by the ghost/route preview.
   */
  racingLineLateral(s) {
    const sm = this.spline.sampleAt(s, this._samp);
    const halfWidth = this.halfWidthAt(s);
    // curvature > 0 means turning right, so the inside is to the right (+lateral).
    const k = clamp(sm.curvature * 26, -1, 1);
    return k * halfWidth * 0.55;
  }

  /**
   * Nearest safe respawn point for a kart that fell off or needs resetting.
   * Returns a world position on the centreline slightly behind `s`.
   */
  respawnPoint(s, out = {}) {
    return this.toWorld(pmod(s - 3, this.length), 0, out);
  }
}
