export const DEFAULT_MENU_BGM = 'rainbow-drift';
export const DEFAULT_RACE_BGM = 'default';

export const MENU_BGM_CHOICES = Object.freeze([
  Object.freeze({ value: 'rainbow-drift', label: 'Rainbow Drift' }),
  Object.freeze({ value: 'neon-kart-groove', label: 'Neon Kart Groove' }),
]);

export const RACE_BGM_CHOICES = Object.freeze([
  Object.freeze({ value: 'default', label: 'Default (By Track)' }),
  Object.freeze({ value: 'rainbow-lap-rush', label: 'Rainbow Lap Rush' }),
  Object.freeze({ value: 'rainbow-kart-parade', label: 'Rainbow Kart Parade (0.90x)' }),
  Object.freeze({ value: 'rainbow-kart-dash', label: 'Rainbow Kart Dash' }),
]);

const TRACKS = Object.freeze({
  'rainbow-drift': Object.freeze({
    id: 'rainbow-drift',
    label: 'Rainbow Drift',
    url: new URL('../../sound/Rainbow Drift.mp3', import.meta.url).href,
  }),
  'neon-kart-groove': Object.freeze({
    id: 'neon-kart-groove',
    label: 'Neon Kart Groove',
    url: new URL('../../sound/Neon Kart Groove.mp3', import.meta.url).href,
  }),
  'rainbow-lap-rush': Object.freeze({
    id: 'rainbow-lap-rush',
    label: 'Rainbow Lap Rush',
    url: new URL('../../sound/Rainbow Lap Rush.mp3', import.meta.url).href,
  }),
  'rainbow-kart-parade': Object.freeze({
    id: 'rainbow-kart-parade',
    label: 'Rainbow Kart Parade (0.90x)',
    url: new URL('../../sound/Rainbow Kart Parade (0.90x).mp3', import.meta.url).href,
  }),
  'rainbow-kart-dash': Object.freeze({
    id: 'rainbow-kart-dash',
    label: 'Rainbow Kart Dash',
    url: new URL('../../sound/Rainbow Kart Dash.mp3', import.meta.url).href,
  }),
});

export const DEFAULT_RACE_BGM_BY_TRACK = Object.freeze({
  'sunset-circuit': 'rainbow-lap-rush',
  'harbor-loop': 'rainbow-kart-parade',
  'summit-raceway': 'rainbow-kart-dash',
});

const MENU_BGM_IDS = new Set(MENU_BGM_CHOICES.map((choice) => choice.value));
const RACE_BGM_IDS = new Set(RACE_BGM_CHOICES.map((choice) => choice.value));

export function sanitizeMenuBgm(value) {
  return MENU_BGM_IDS.has(value) ? value : DEFAULT_MENU_BGM;
}

export function sanitizeRaceBgm(value) {
  return RACE_BGM_IDS.has(value) ? value : DEFAULT_RACE_BGM;
}

export function getBgmTrack(id) {
  return TRACKS[id] || TRACKS[DEFAULT_MENU_BGM];
}

export function resolveMenuBgm(preference) {
  return getBgmTrack(sanitizeMenuBgm(preference));
}

export function resolveRaceBgm(preference, trackId) {
  const selected = sanitizeRaceBgm(preference);
  const id = selected === DEFAULT_RACE_BGM
    ? (DEFAULT_RACE_BGM_BY_TRACK[trackId] || DEFAULT_RACE_BGM_BY_TRACK['sunset-circuit'])
    : selected;
  return getBgmTrack(id);
}
