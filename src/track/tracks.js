// Track roster. Control points are authored on the XZ plane (y = elevation).
// The start/finish line is at arc length s = 0, i.e. at the first control
// point, with racing direction toward the second point.
//
// Authoring notes:
//  - `sFrac` places pads/boxes as a fraction (0..1) of the lap, so tweaking
//    control points doesn't silently move every pickup.
//  - Item boxes are authored in clusters of 3–4 across the road, like the
//    genre convention, so the whole pack can pick up at once.

/** Convenience: a lateral row of item boxes at one track position. */
function boxRow(sFrac, laterals) {
  return laterals.map((lateral) => ({ sFrac, lateral }));
}

export const TRACKS = [
  {
    id: 'sunset-circuit',
    name: 'Sunset Circuit',
    subtitle: 'A fast opener — two hairpins and a boosted back straight.',
    width: 22,
    laps: 3,
    spacing: 1.0,
    theme: {
      sky: 0xffb36b, skyHorizon: 0xffe0b0, fog: 0xffcf9e, fogDensity: 0.0035,
      road: 0x3a3f4a, roadEdge: 0xf2f2f2, offroad: 0xc98f4e, offroadDark: 0xa8733a,
      wall: 0xff6b6b, scenery: 'desert',
      sun: 0xffd9a0, sunIntensity: 1.25, ambient: 0xffe8cf, ambientIntensity: 0.55,
    },
    points: [
      { x: 0, z: 0 },        // start/finish — heading +z
      { x: 4, z: 60 },
      { x: 18, z: 110 },
      { x: 60, z: 150 },
      { x: 115, z: 158 },
      { x: 158, z: 132 },    // hairpin 1 entry
      { x: 166, z: 92 },
      { x: 140, z: 60 },     // hairpin 1 exit
      { x: 100, z: 52 },
      { x: 74, z: 20 },
      { x: 84, z: -30 },     // back straight begins (boost pads)
      { x: 110, z: -78 },
      { x: 96, z: -122 },
      { x: 48, z: -138 },    // hairpin 2
      { x: 2, z: -122 },
      { x: -18, z: -80 },
      { x: -14, z: -36 },
    ],
    boostPads: [
      { sFrac: 0.565, lateral: -3.2, width: 5, length: 9 },
      { sFrac: 0.565, lateral: 3.2, width: 5, length: 9 },
      { sFrac: 0.60, lateral: 0, width: 5, length: 9 },
    ],
    itemBoxes: [
      ...boxRow(0.10, [-6, -2, 2, 6]),
      ...boxRow(0.38, [-6, -2, 2, 6]),
      ...boxRow(0.70, [-6, -2, 2, 6]),
    ],
  },

  {
    id: 'harbor-loop',
    name: 'Harbor Loop',
    subtitle: 'Tight dockside corners. Watch the chicane by the cranes.',
    width: 19,
    laps: 3,
    spacing: 1.0,
    theme: {
      sky: 0x7ec8f7, skyHorizon: 0xd9f0ff, fog: 0xbfe4f7, fogDensity: 0.0030,
      road: 0x424750, roadEdge: 0xffd23f, offroad: 0x6da05f, offroadDark: 0x55854a,
      wall: 0x3b7dd8, scenery: 'harbor',
      sun: 0xffffff, sunIntensity: 1.35, ambient: 0xcfe8ff, ambientIntensity: 0.6,
    },
    points: [
      { x: 0, z: 0 },
      { x: -6, z: 55 },
      { x: 10, z: 104 },      // sweeper right
      { x: 56, z: 122 },
      { x: 104, z: 108 },
      { x: 128, z: 70 },
      { x: 120, z: 30 },      // chicane in
      { x: 148, z: -2 },      // chicane out
      { x: 150, z: -50 },
      { x: 118, z: -86 },
      { x: 70, z: -92, w: 15 }, // narrow dock section
      { x: 26, z: -80, w: 15 },
      { x: -8, z: -96 },
      { x: -46, z: -84 },
      { x: -58, z: -42 },
      { x: -40, z: -6 },
    ],
    boostPads: [
      { sFrac: 0.335, lateral: 0, width: 6, length: 8 },
      { sFrac: 0.86, lateral: -2.5, width: 4.5, length: 8 },
      { sFrac: 0.86, lateral: 2.5, width: 4.5, length: 8 },
    ],
    itemBoxes: [
      ...boxRow(0.085, [-5, -1.7, 1.7, 5]),
      ...boxRow(0.46, [-5, -1.7, 1.7, 5]),
      ...boxRow(0.74, [-4.5, -1.5, 1.5, 4.5]),
    ],
  },

  {
    id: 'summit-raceway',
    name: 'Summit Raceway',
    subtitle: 'A climbing figure of ambition — long drifts, big drops.',
    width: 21,
    laps: 3,
    spacing: 1.0,
    theme: {
      sky: 0x9a86e8, skyHorizon: 0xf3c4e0, fog: 0xcdb6ea, fogDensity: 0.0042,
      road: 0x39344a, roadEdge: 0xe95fa0, offroad: 0x4a5f52, offroadDark: 0x3a4c41,
      wall: 0xb45fe9, scenery: 'alpine',
      sun: 0xf5d9ff, sunIntensity: 1.1, ambient: 0xd6c7f2, ambientIntensity: 0.62,
    },
    // Start/finish sits on the northern climb straight; the lap ends in a
    // wide hairpin (the old start corner, now w:28) before the run to the line.
    points: [
      { x: 10, y: 0, z: 62 },
      { x: 44, y: 1.5, z: 104 },
      { x: 96, y: 4, z: 118 },      // climbing
      { x: 148, y: 7, z: 98 },
      { x: 170, y: 9, z: 52 },      // summit sweeper
      { x: 158, y: 10, z: 4 },
      { x: 120, y: 8.5, z: -28 },
      { x: 118, y: 6.5, z: -76, w: 25 },   // descent S-curves
      { x: 84, y: 4.5, z: -104, w: 25 },
      { x: 36, y: 2.5, z: -96, w: 26 },
      { x: 18, y: 1.8, z: -80, w: 27 },    // rounds the valley kink
      { x: 12, y: 1.2, z: -62, w: 27 },    // valley kink
      { x: -28, y: 0.6, z: -48, w: 26 },
      { x: -58, y: 0, z: -72, w: 25 },
      { x: -88, y: 0, z: -52 },
      { x: -84, y: 0, z: -6 },
      { x: -46, y: 0, z: 16, w: 24 },
      { x: 0, y: 0, z: 0, w: 28 },  // final hairpin
    ],
    boostPads: [
      { sFrac: 0.235, lateral: 0, width: 6, length: 10 },  // climb launch
      { sFrac: 0.88, lateral: -3, width: 5, length: 9 },
      { sFrac: 0.88, lateral: 3, width: 5, length: 9 },
    ],
    itemBoxes: [
      ...boxRow(0.05, [-5.5, -1.8, 1.8, 5.5]),
      ...boxRow(0.34, [-5.5, -1.8, 1.8, 5.5]),
      ...boxRow(0.59, [-5, -1.7, 1.7, 5]),
    ],
  },
];

export const TRACKS_BY_ID = Object.fromEntries(TRACKS.map((t) => [t.id, t]));

export function getTrackDef(id) {
  return TRACKS_BY_ID[id] || TRACKS[0];
}
