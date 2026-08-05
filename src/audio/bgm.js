export const DEFAULT_MENU_BGM = 'rainbow-drift';
export const DEFAULT_RACE_BGM = 'default';
export const RANDOM_BGM = 'random';
// Increment when any bundled BGM file changes. The versioned URL lets the
// static server cache audio for a long time without serving stale music.
export const BGM_ASSET_VERSION = '20260803-1';

function bgmUrl(path) {
  const url = new URL(path, import.meta.url);
  url.searchParams.set('v', BGM_ASSET_VERSION);
  return url.href;
}

export const MENU_BGM_CHOICES = Object.freeze([
  Object.freeze({ value: RANDOM_BGM, label: 'Random' }),
  Object.freeze({ value: 'rainbow-drift', label: 'Rainbow Drift' }),
  Object.freeze({ value: 'neon-kart-groove', label: 'Neon Kart Groove' }),
]);

export const RACE_BGM_CHOICES = Object.freeze([
  Object.freeze({ value: 'default', label: 'Default (By Track)' }),
  Object.freeze({ value: RANDOM_BGM, label: 'Random' }),
  Object.freeze({ value: 'rainbow-lap-rush', label: 'Rainbow Lap Rush' }),
  Object.freeze({ value: 'rainbow-kart-parade', label: 'Rainbow Kart Parade (0.90x)' }),
  Object.freeze({ value: 'rainbow-kart-dash', label: 'Rainbow Kart Dash' }),
]);

const TRACKS = Object.freeze({
  'rainbow-drift': Object.freeze({
    id: 'rainbow-drift',
    label: 'Rainbow Drift',
    url: bgmUrl('../../sound/Rainbow Drift.mp3'),
  }),
  'neon-kart-groove': Object.freeze({
    id: 'neon-kart-groove',
    label: 'Neon Kart Groove',
    url: bgmUrl('../../sound/Neon Kart Groove.mp3'),
  }),
  'rainbow-lap-rush': Object.freeze({
    id: 'rainbow-lap-rush',
    label: 'Rainbow Lap Rush',
    url: bgmUrl('../../sound/Rainbow Lap Rush.mp3'),
  }),
  'rainbow-kart-parade': Object.freeze({
    id: 'rainbow-kart-parade',
    label: 'Rainbow Kart Parade (0.90x)',
    url: bgmUrl('../../sound/Rainbow Kart Parade (0.90x).mp3'),
  }),
  'rainbow-kart-dash': Object.freeze({
    id: 'rainbow-kart-dash',
    label: 'Rainbow Kart Dash',
    url: bgmUrl('../../sound/Rainbow Kart Dash.mp3'),
  }),
});

export const DEFAULT_RACE_BGM_BY_TRACK = Object.freeze({
  'sunset-circuit': 'rainbow-lap-rush',
  'harbor-loop': 'rainbow-kart-parade',
  'summit-raceway': 'rainbow-kart-dash',
  'aurora-icefall': 'rainbow-lap-rush',
  'monaco-gp': 'rainbow-kart-parade',
  'metropolis-highway': 'rainbow-kart-dash',
});

const MENU_TRACK_IDS = Object.freeze(MENU_BGM_CHOICES
  .map((choice) => choice.value)
  .filter((id) => id !== RANDOM_BGM));
const RACE_TRACK_IDS = Object.freeze(RACE_BGM_CHOICES
  .map((choice) => choice.value)
  .filter((id) => id !== DEFAULT_RACE_BGM && id !== RANDOM_BGM));
const MENU_BGM_IDS = new Set(MENU_BGM_CHOICES.map((choice) => choice.value));
const RACE_BGM_IDS = new Set(RACE_BGM_CHOICES.map((choice) => choice.value));

function randomTrackId(trackIds, random) {
  const sample = Number(random());
  const normalized = Number.isFinite(sample)
    ? Math.min(Math.max(sample, 0), 0.999999999)
    : 0;
  return trackIds[Math.floor(normalized * trackIds.length)];
}

export function sanitizeMenuBgm(value) {
  return MENU_BGM_IDS.has(value) ? value : DEFAULT_MENU_BGM;
}

export function sanitizeRaceBgm(value) {
  return RACE_BGM_IDS.has(value) ? value : DEFAULT_RACE_BGM;
}

export function getBgmTrack(id) {
  return TRACKS[id] || TRACKS[DEFAULT_MENU_BGM];
}

export function resolveMenuBgm(preference, options = {}) {
  const selected = sanitizeMenuBgm(preference);
  if (selected !== RANDOM_BGM) return getBgmTrack(selected);

  const currentTrackId = options.currentTrackId;
  if (!options.reroll && MENU_TRACK_IDS.includes(currentTrackId)) {
    return getBgmTrack(currentTrackId);
  }
  return getBgmTrack(randomTrackId(
    MENU_TRACK_IDS,
    options.random || Math.random,
  ));
}

export function resolveRaceBgm(preference, trackId, options = {}) {
  const selected = sanitizeRaceBgm(preference);
  if (selected === RANDOM_BGM) {
    const currentTrackId = options.currentTrackId;
    if (!options.reroll && RACE_TRACK_IDS.includes(currentTrackId)) {
      return getBgmTrack(currentTrackId);
    }
    return getBgmTrack(randomTrackId(
      RACE_TRACK_IDS,
      options.random || Math.random,
    ));
  }
  const id = selected === DEFAULT_RACE_BGM
    ? (DEFAULT_RACE_BGM_BY_TRACK[trackId] || DEFAULT_RACE_BGM_BY_TRACK['sunset-circuit'])
    : selected;
  return getBgmTrack(id);
}
