import { scrypt as nodeScrypt } from 'node:crypto';

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function runNodeScrypt(password, salt, keyLength) {
  return new Promise((resolve, reject) => {
    nodeScrypt(password, salt, keyLength, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

export class ScryptQueueFullError extends Error {
  constructor() {
    super('The password hashing queue is full.');
    this.name = 'ScryptQueueFullError';
  }
}

/** A global bounded queue keeps CPU-heavy password work off the event loop. */
export class ScryptQueue {
  constructor({
    concurrency = positiveInteger(process.env.AUTH_SCRYPT_CONCURRENCY, 2),
    queueLimit = nonNegativeInteger(process.env.AUTH_SCRYPT_QUEUE_LIMIT, 32),
    scrypt = runNodeScrypt,
  } = {}) {
    this.concurrency = positiveInteger(concurrency, 2);
    this.queueLimit = nonNegativeInteger(queueLimit, 32);
    this.scrypt = scrypt;
    this.active = 0;
    this.waiting = [];
  }

  run(password, salt, keyLength) {
    return new Promise((resolve, reject) => {
      const task = { password, salt, keyLength, resolve, reject };
      if (this.active < this.concurrency) {
        this._start(task);
        return;
      }
      if (this.waiting.length >= this.queueLimit) {
        reject(new ScryptQueueFullError());
        return;
      }
      this.waiting.push(task);
    });
  }

  _start(task) {
    this.active++;
    Promise.resolve()
      .then(() => this.scrypt(task.password, task.salt, task.keyLength))
      .then(task.resolve, task.reject)
      .finally(() => {
        this.active--;
        const next = this.waiting.shift();
        if (next) this._start(next);
      });
  }
}

export const defaultScryptQueue = new ScryptQueue();

