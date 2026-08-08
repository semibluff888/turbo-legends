export const DEFAULT_BOT_ROOM_READY_TIMEOUT_SECONDS = 30;
export const MIN_BOT_ROOM_READY_TIMEOUT_SECONDS = 10;
export const MAX_BOT_ROOM_READY_TIMEOUT_SECONDS = 600;
export const DEFAULT_BOT_ROOM_READY_TIMEOUT_MS =
  DEFAULT_BOT_ROOM_READY_TIMEOUT_SECONDS * 1000;

export function parseBotRoomReadyTimeoutSeconds(value) {
  const seconds = typeof value === 'number' ? value : Number(String(value || '').trim());
  if (!Number.isInteger(seconds)
    || seconds < MIN_BOT_ROOM_READY_TIMEOUT_SECONDS
    || seconds > MAX_BOT_ROOM_READY_TIMEOUT_SECONDS) {
    return null;
  }
  return seconds;
}

export function requireBotRoomReadyTimeoutSeconds(
  value,
  label = 'Bot room ready timeout',
) {
  const seconds = parseBotRoomReadyTimeoutSeconds(value);
  if (seconds === null) {
    throw new TypeError(
      `${label} must be an integer between ${MIN_BOT_ROOM_READY_TIMEOUT_SECONDS} and ${MAX_BOT_ROOM_READY_TIMEOUT_SECONDS} seconds.`,
    );
  }
  return seconds;
}
