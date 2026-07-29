import { ERROR_CODES } from '../src/net/protocol.js';

export class GameError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'GameError';
    this.code = code || ERROR_CODES.INTERNAL_ERROR;
    this.details = details;
  }
}

export function gameError(code, message, details) {
  return new GameError(code, message, details);
}

export function asErrorMessage(error, fallbackMessage = 'The server could not process that request.') {
  if (error instanceof GameError) {
    return { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) };
  }
  return { code: ERROR_CODES.INTERNAL_ERROR, message: fallbackMessage };
}
