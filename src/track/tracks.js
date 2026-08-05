// Track roster. Control points are authored on the XZ plane (y = elevation).
// The start/finish line is at arc length s = 0, i.e. at the first control
// point, with racing direction toward the second point.
//
// Authoring notes:
//  - `sFrac` places pads/boxes as a fraction (0..1) of the lap, so tweaking
//    control points doesn't silently move every pickup.
//  - Item boxes are authored in rows of 6 across the road, like the
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
      ...boxRow(0.10, [-10, -6, -2, 2, 6, 10]),
      ...boxRow(0.38, [-10, -6, -2, 2, 6, 10]),
      ...boxRow(0.70, [-10, -6, -2, 2, 6, 10]),
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
      ...boxRow(0.085, [-8.5, -5.1, -1.7, 1.7, 5.1, 8.5]),
      ...boxRow(0.46, [-8.5, -5.1, -1.7, 1.7, 5.1, 8.5]),
      ...boxRow(0.74, [-7.2, -4.32, -1.44, 1.44, 4.32, 7.2]),
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
      ...boxRow(0.05, [-9.5, -5.7, -1.9, 1.9, 5.7, 9.5]),
      ...boxRow(0.34, [-9.5, -5.7, -1.9, 1.9, 5.7, 9.5]),
      ...boxRow(0.59, [-12.4, -7.44, -2.48, 2.48, 7.44, 12.4]),
    ],
  },

  {
    id: 'aurora-icefall',
    name: 'Aurora Icefall',
    subtitle: 'Blue-ice tunnels, mirror-lake switchbacks, and a skybridge over your own line.',
    width: 20,
    laps: 3,
    spacing: 1.0,
    theme: {
      sky: 0x15284f, skyHorizon: 0x8fc8e5, fog: 0xa8d0e2, fogDensity: 0.0036,
      road: 0x273746, roadEdge: 0xbff7ff, offroad: 0xe7f3ff, offroadDark: 0x7894aa,
      wall: 0x65dff3, scenery: 'glacier',
      sun: 0xcfe9ff, sunIntensity: 1.05, ambient: 0xbfdcff, ambientIntensity: 0.68,
    },
    points: [
      { x: 0, y: 1, z: 104, w: 22, runoff: 8 },
      { x: 40, y: 1, z: 112, w: 22, runoff: 9 },
      { x: 80, y: 0.8, z: 100, w: 22, runoff: 10 },
      { x: 108, y: 0.6, z: 72, w: 21, runoff: 10 },
      { x: 116, y: 0.4, z: 32, w: 21, runoff: 8 },
      { x: 104, y: 0.3, z: -8, w: 20, runoff: 5 },
      { x: 76, y: 0.3, z: -36, w: 19, runoff: 3 },
      { x: 40, y: 0.3, z: -44, w: 19, runoff: 3 },
      { x: 8, y: 0.3, z: -28, w: 19, runoff: 3 },
      { x: -20, y: 0.4, z: -4, w: 19, runoff: 3 },
      { x: -52, y: 0.5, z: 8, w: 20, runoff: 5 },
      { x: -84, y: 0.5, z: -8, w: 19, runoff: 6 },
      { x: -100, y: 0.5, z: -28, w: 18, runoff: 5 },
      { x: -84, y: 0.5, z: -52, w: 18, runoff: 4 },
      { x: -102, y: 0.5, z: -76, w: 24, runoff: 5 },
      { x: -72, y: 1, z: -100, w: 21, runoff: 6 },
      { x: -28, y: 4, z: -100, w: 20, runoff: 4 },
      { x: 4, y: 8, z: -80, w: 18, runoff: 2.5 },
      { x: 26, y: 12, z: -48, w: 18, runoff: 2 },
      { x: 34, y: 14, z: -12, w: 18, runoff: 2 },
      { x: 24, y: 13, z: 24, w: 18, runoff: 2 },
      { x: 4, y: 9, z: 56, w: 19, runoff: 3 },
      { x: -28, y: 5.5, z: 76, w: 20, runoff: 6 },
      { x: -60, y: 3, z: 92, w: 21, runoff: 8 },
      { x: -48, y: 1.4, z: 120, w: 24, runoff: 7 },
      { x: -16, y: 1, z: 124, w: 22, runoff: 8 },
    ],
    gripZones: [
      { startFrac: 0.105, endFrac: 0.185, grip: 0.70, driftGrip: 0.88 },
      { startFrac: 0.445, endFrac: 0.505, grip: 0.70, driftGrip: 0.88 },
      { startFrac: 0.575, endFrac: 0.635, grip: 0.70, driftGrip: 0.88 },
    ],
    structures: [
      {
        kind: 'tunnel', startFrac: 0.252, endFrac: 0.407, ceiling: 7.2,
        openings: [{ startFrac: 0.298, endFrac: 0.327 }],
      },
      {
        kind: 'bridge', startFrac: 0.628, endFrac: 0.827,
        mainStartFrac: 0.675, mainEndFrac: 0.8,
      },
    ],
    boostPads: [
      { sFrac: 0.413, lateral: 0, width: 6, length: 9 },
      { sFrac: 0.646, lateral: -3, width: 5, length: 8 },
      { sFrac: 0.646, lateral: 3, width: 5, length: 8 },
      { sFrac: 0.838, lateral: 0, width: 6, length: 10 },
    ],
    itemBoxes: [
      ...boxRow(0.075, [-10, -6, -2, 2, 6, 10]),
      ...boxRow(0.410, [-9, -5.4, -1.8, 1.8, 5.4, 9]),
      ...boxRow(0.620, [-9, -5.4, -1.8, 1.8, 5.4, 9]),
      ...boxRow(0.855, [-9, -5.4, -1.8, 1.8, 5.4, 9]),
    ],
  },

  {
    id: 'monaco-gp',
    name: 'Monaco Grand Prix',
    subtitle: 'Iconic F1 street circuit — tight hairpins, harbor yachts, casino square, and the dark tunnel.',
    width: 20,
    laps: 3,
    spacing: 1.0,
    theme: {
      sky: 0x3a86ff, skyHorizon: 0xbde0fe, fog: 0xc4e0ff, fogDensity: 0.0020,
      road: 0x363a45, roadEdge: 0xffffff, offroad: 0x4a7c59, offroadDark: 0x355e40,
      wall: 0xe33d3d, scenery: 'monaco',
      sun: 0xfffaed, sunIntensity: 1.45, ambient: 0xe2e8f0, ambientIntensity: 0.70,
    },
    points: [
      { x: 0, y: 0, z: 0, w: 22, runoff: 8 },         // Start / Finish Pit Straight
      { x: 0, y: 0, z: 65, w: 22, runoff: 8 },
      { x: 28, y: 0, z: 98, w: 19, runoff: 6 },        // T1 Sainte Devote
      { x: 72, y: 2, z: 152, w: 19, runoff: 6 },       // Beau Rivage climb
      { x: 104, y: 3.5, z: 208, w: 19, runoff: 7 },    // Massenet left curve
      { x: 148, y: 4, z: 228, w: 19, runoff: 7 },      // Casino Square
      { x: 195, y: 3.0, z: 215, w: 18, runoff: 6 },    // Curve 1 (Right sweeper into Upper Tunnel)
      { x: 220, y: 2.2, z: 175, w: 18, runoff: 6 },    // Upper Tunnel Entry
      { x: 190, y: 1.4, z: 135, w: 18, runoff: 6 },    // Curve 2 (S-bend inside Upper Tunnel)
      { x: 215, y: 0.8, z: 95, w: 18, runoff: 6 },     // Curve 3 (Right S-bend exit)
      { x: 205, y: 0, z: 45, w: 20, runoff: 6 },       // Coastal Tunnel entry
      { x: 208, y: 0, z: -45, w: 21, runoff: 6 },      // Coastal Tunnel straight
      { x: 198, y: 0, z: -122, w: 21, runoff: 6 },     // Coastal Tunnel exit approach
      { x: 168, y: 0, z: -155, w: 19, runoff: 5 },     // Nouvelle Chicane left
      { x: 134, y: 0, z: -142, w: 19, runoff: 5 },     // Nouvelle Chicane right
      { x: 88, y: 0, z: -148, w: 20, runoff: 6 },      // Tabac fast left along harbor
      { x: 38, y: 0, z: -152, w: 19, runoff: 5 },      // Swimming Pool entrance
      { x: 6, y: 0, z: -130, w: 18, runoff: 5 },       // Swimming Pool chicane 1
      { x: -28, y: 0, z: -146, w: 18, runoff: 5 },     // Swimming Pool chicane 2
      { x: -70, y: 0, z: -140, w: 18, runoff: 5 },     // La Rascasse entry
      { x: -96, y: 0, z: -108, w: 18, runoff: 5 },     // La Rascasse hairpin
      { x: -80, y: 0, z: -68, w: 18, runoff: 5 },      // Antony Noghès right kink
      { x: -44, y: 0, z: -32, w: 20, runoff: 7 },      // Back to Start/Finish
    ],
    gripZones: [],
    structures: [
      {
        kind: 'tunnel', startFrac: 0.315, endFrac: 0.415, ceiling: 7.5,
        openings: [{ startFrac: 0.355, endFrac: 0.375 }],
      },
      {
        kind: 'tunnel', startFrac: 0.445, endFrac: 0.595, ceiling: 7.5,
        openings: [{ startFrac: 0.505, endFrac: 0.535 }],
      },
    ],
    boostPads: [
      { sFrac: 0.05, lateral: 0, width: 6, length: 9 },   // Start straight launch
      { sFrac: 0.36, lateral: 0, width: 6, length: 9 },   // Upper Tunnel S-bend boost
      { sFrac: 0.54, lateral: 0, width: 6, length: 10 },  // Coastal Tunnel exit launch
      { sFrac: 0.72, lateral: 0, width: 6, length: 9 },   // Harbor straight
    ],
    itemBoxes: [
      ...boxRow(0.08, [-9.1, -5.46, -1.82, 1.82, 5.46, 9.1]),
      ...boxRow(0.35, [-8.0, -4.8, -1.6, 1.6, 4.8, 8.0]),
      ...boxRow(0.58, [-9.4, -5.64, -1.88, 1.88, 5.64, 9.4]),
      ...boxRow(0.78, [-8.2, -4.92, -1.64, 1.64, 4.92, 8.2]),
      ...boxRow(0.92, [-8.4, -5.04, -1.68, 1.68, 5.04, 8.4]),
    ],
  },

  {
    id: 'metropolis-highway',
    name: 'Metropolis Highway',
    subtitle: 'High-rise overpasses, glass skyscrapers, and smooth city straights.',
    width: 20,
    laps: 3,
    spacing: 1.0,
    theme: {
      sky: 0x4895ef, skyHorizon: 0xbde0fe, fog: 0xd0e8ff, fogDensity: 0.0016,
      road: 0x4a5568, roadEdge: 0xffffff, offroad: 0xa0aec0, offroadDark: 0x718096,
      wall: 0x3182ce, scenery: 'metropolis',
      sun: 0xfffaed, sunIntensity: 1.50, ambient: 0xe2e8f0, ambientIntensity: 0.75,
    },
    points: [
      { x: 0, y: 0, z: 0, w: 22, runoff: 8 },
      { x: 45, y: 1, z: 50, w: 22, runoff: 8 },
      { x: 90, y: 3, z: 95, w: 22, runoff: 9 },
      { x: 135, y: 6, z: 125, w: 21, runoff: 9 },
      { x: 180, y: 9.5, z: 130, w: 20, runoff: 8 },
      { x: 220, y: 13, z: 105, w: 20, runoff: 7 },
      { x: 240, y: 16, z: 65, w: 19, runoff: 6 },
      { x: 230, y: 18, z: 20, w: 18, runoff: 5 },
      { x: 195, y: 18.5, z: -10, w: 18, runoff: 5 },
      { x: 155, y: 17.5, z: -28, w: 18, runoff: 4 },
      { x: 110, y: 16.5, z: -30, w: 18, runoff: 3 },
      { x: 65, y: 15, z: -20, w: 18, runoff: 4 },
      { x: 30, y: 12.5, z: 10, w: 19, runoff: 5 },
      { x: 10, y: 9.5, z: 48, w: 24, runoff: 6 },
      { x: -25, y: 7, z: 65, w: 22, runoff: 7 },
      { x: -65, y: 5, z: 50, w: 20, runoff: 6 },
      { x: -95, y: 3.5, z: 15, w: 18, runoff: 5 },
      { x: -110, y: 2.5, z: -25, w: 18, runoff: 4 },
      { x: -140, y: 1.8, z: -60, w: 18, runoff: 4 },
      { x: -175, y: 1.2, z: -75, w: 18, runoff: 4 },
      { x: -205, y: 0.8, z: -45, w: 18, runoff: 4 },
      { x: -195, y: 0.5, z: 0, w: 20, runoff: 5 },
      { x: -165, y: 0.3, z: 40, w: 21, runoff: 6 },
      { x: -120, y: 0.2, z: 65, w: 22, runoff: 8 },
      { x: -65, y: 0.1, z: 60, w: 22, runoff: 8 },
      { x: -15, y: 0.1, z: 35, w: 21, runoff: 7 },
      { x: 35, y: 0.2, z: 5, w: 20, runoff: 6 },
      { x: 110, y: 0.5, z: -30, w: 20, runoff: 5 },
      { x: 135, y: 0.6, z: -70, w: 22, runoff: 7 },
      { x: 110, y: 0.5, z: -110, w: 25, runoff: 8 },
      { x: 60, y: 0.3, z: -105, w: 24, runoff: 8 },
      { x: 15, y: 0.1, z: -60, w: 23, runoff: 8 },
    ],
    gripZones: [],
    structures: [
      {
        kind: 'bridge', startFrac: 0.28, endFrac: 0.40,
        mainStartFrac: 0.31, mainEndFrac: 0.37,
      },
      {
        kind: 'tunnel', startFrac: 0.80, endFrac: 0.91, ceiling: 8.0,
        openings: [{ startFrac: 0.84, endFrac: 0.87 }],
      },
    ],
    boostPads: [
      { sFrac: 0.18, lateral: 0, width: 6, length: 9 },
      { sFrac: 0.44, lateral: -2.8, width: 5, length: 8 },
      { sFrac: 0.44, lateral: 2.8, width: 5, length: 8 },
      { sFrac: 0.72, lateral: 0, width: 6, length: 10 },
      { sFrac: 0.93, lateral: 0, width: 6, length: 9 },
    ],
    itemBoxes: [
      ...boxRow(0.08, [-10, -6, -2, 2, 6, 10]),
      ...boxRow(0.32, [-8.1, -4.86, -1.62, 1.62, 4.86, 8.1]),
      ...boxRow(0.55, [-8.1, -4.86, -1.62, 1.62, 4.86, 8.1]),
      ...boxRow(0.74, [-9.5, -5.7, -1.9, 1.9, 5.7, 9.5]),
      ...boxRow(0.92, [-11, -6.6, -2.2, 2.2, 6.6, 11]),
    ],
  },
];

export const TRACKS_BY_ID = Object.fromEntries(TRACKS.map((t) => [t.id, t]));

export function getTrackDef(id) {
  return TRACKS_BY_ID[id] || TRACKS[0];
}
