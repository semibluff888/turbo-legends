// Minimal static file server for Turbo Legends.
// ES modules require an http:// origin, so `npm start` and open the printed URL.
import { createServer } from 'node:http';
import { createReadStream, promises as fs, realpathSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { brotliCompress, gzip } from 'node:zlib';

import { RoomManager } from './server/room-manager.js';
import { createDefaultRaceFactory } from './server/race-factory.js';
import { RuntimeMetrics } from './server/runtime-metrics.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || '127.0.0.1';
const compressBrotli = promisify(brotliCompress);
const compressGzip = promisify(gzip);
const COMPRESSIBLE_EXTENSIONS = new Set([
  '.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.map', '.md',
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.mp3': 'audio/mpeg',
};

function isInside(root, filePath) {
  const rel = relative(root, filePath);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const rel = decoded.replace(/^([/\\])+/, '');
  const full = resolve(root, rel);
  if (!isInside(root, full)) return null;
  return full;
}

function staticEntryPath(urlPath = '/') {
  const pathname = urlPath.split('?')[0].split('#')[0];
  return pathname === '/' ? '/index.html' : pathname;
}

function isPublicPath(root, filePath) {
  if (!isInside(root, filePath)) return false;

  const rel = relative(root, filePath);
  const parts = rel.split(sep);
  if (!rel || parts.some(part => part.startsWith('.'))) return false;
  if (rel === 'index.html') return true;
  return parts[0] === 'src' || parts[0] === 'vendor' || parts[0] === 'sound';
}

function weakEtag(stat) {
  return `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
}

function requestIsFresh(headers, etag, mtimeMs) {
  if (headers['if-none-match'] !== undefined) {
    return String(headers['if-none-match'])
      .split(',')
      .map((value) => value.trim())
      .some((value) => value === '*' || value === etag);
  }
  const modifiedSince = headers['if-modified-since'];
  if (!modifiedSince) return false;
  const parsed = Date.parse(String(modifiedSince));
  return Number.isFinite(parsed) && Math.floor(mtimeMs / 1000) * 1000 <= parsed;
}

function ifRangeMatches(value, etag, mtimeMs) {
  if (!value) return true;
  const text = String(value).trim();
  if (text.startsWith('"') || text.startsWith('W/')) return text === etag;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) && Math.floor(mtimeMs / 1000) * 1000 <= parsed;
}

function parseSingleRange(header, size) {
  if (!header || !String(header).startsWith('bytes=')) return null;
  const spec = String(header).slice(6).trim();
  if (!spec || spec.includes(',')) return { invalid: true };
  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (!match || (!match[1] && !match[2]) || size <= 0) return { invalid: true };
  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { invalid: true };
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
      return { invalid: true };
    }
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

function acceptedCompression(header) {
  const accepted = new Map();
  for (const part of String(header ?? '').split(',')) {
    const [rawName, ...parameters] = part.trim().toLowerCase().split(';');
    if (!rawName) continue;
    let quality = 1;
    for (const parameter of parameters) {
      const match = /^q\s*=\s*([0-9.]+)$/.exec(parameter.trim());
      if (match) quality = Number(match[1]);
    }
    accepted.set(rawName, Number.isFinite(quality) ? quality : 0);
  }
  const quality = (encoding) => accepted.get(encoding) ?? accepted.get('*') ?? 0;
  if (quality('br') > 0) return 'br';
  if (quality('gzip') > 0) return 'gzip';
  return null;
}

class CompressionCache {
  constructor(maxBytes) {
    this.maxBytes = Math.max(0, Number(maxBytes) || 0);
    this.totalBytes = 0;
    this.entries = new Map();
  }

  async getOrCreate(key, create) {
    let entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
      return entry.promise;
    }
    entry = { size: 0, promise: Promise.resolve().then(create) };
    this.entries.set(key, entry);
    try {
      const buffer = await entry.promise;
      if (this.maxBytes === 0 || buffer.byteLength > this.maxBytes) {
        this.entries.delete(key);
        return buffer;
      }
      entry.size = buffer.byteLength;
      this.totalBytes += entry.size;
      while (this.totalBytes > this.maxBytes && this.entries.size > 0) {
        const oldestKey = this.entries.keys().next().value;
        const oldest = this.entries.get(oldestKey);
        this.entries.delete(oldestKey);
        this.totalBytes -= oldest?.size ?? 0;
      }
      return buffer;
    } catch (error) {
      this.entries.delete(key);
      throw error;
    }
  }
}

export function createStaticServer(root = ROOT, {
  healthProvider = null,
  metadataProvider = null,
  statsProvider = null,
  metricsProvider = null,
  metricsToken = '',
  compressionCacheBytes = Number(process.env.STATIC_COMPRESSION_CACHE_BYTES) || 16_777_216,
} = {}) {
  const staticRoot = realpathSync(resolve(root));
  const compressionCache = new CompressionCache(compressionCacheBytes);

  return createServer(async (req, res) => {
    const [pathname = '/', rawQuery = ''] = (req.url || '/').split('?', 2);
    const assetVersion = new URLSearchParams(rawQuery).get('v');
    if (statsProvider && req.method === 'GET' && pathname === '/api/stats') {
      const body = JSON.stringify(statsProvider());
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'public, max-age=5, stale-while-revalidate=10',
      }).end(body);
      return;
    }
    if (req.method === 'GET' && pathname === '/api/metrics') {
      if (!metricsProvider || !metricsToken) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
        return;
      }
      if (req.headers.authorization !== `Bearer ${metricsToken}`) {
        res.writeHead(401, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
          'WWW-Authenticate': 'Bearer',
        }).end('401 Unauthorized');
        return;
      }
      const body = JSON.stringify(metricsProvider());
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
      }).end(body);
      return;
    }
    if (metadataProvider && req.method === 'GET' && pathname === '/api/meta') {
      const body = JSON.stringify(metadataProvider());
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
      }).end(body);
      return;
    }
    if (healthProvider && req.method === 'GET' && pathname === '/healthz') {
      const body = JSON.stringify({ status: 'ok', ...healthProvider() });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
      }).end(body);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, {
        'Content-Type': 'text/plain; charset=utf-8',
        Allow: 'GET, HEAD',
      }).end('405 Method Not Allowed');
      return;
    }

    let filePath;
    try {
      filePath = safeJoin(staticRoot, staticEntryPath(req.url));
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('400 Bad Request');
      return;
    }

    if (!filePath) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('403 Forbidden');
      return;
    }
    if (!isPublicPath(staticRoot, filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
      return;
    }

    try {
      let stat = await fs.stat(filePath);
      if (stat.isDirectory()) filePath = join(filePath, 'index.html');

      // Resolve symlinks before serving so an allowed directory cannot point
      // outside the public project files.
      filePath = await fs.realpath(filePath);
      if (!isPublicPath(staticRoot, filePath)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('403 Forbidden');
        return;
      }
      stat = await fs.stat(filePath);
      if (!stat.isFile()) throw new Error('Not a regular file.');

      const extension = extname(filePath).toLowerCase();
      const etag = weakEtag(stat);
      const lastModified = stat.mtime.toUTCString();
      const relativePath = relative(staticRoot, filePath).replaceAll('\\', '/');
      const versionedSound = pathname.startsWith('/sound/') && Boolean(assetVersion);
      const cacheControl = relativePath === 'index.html'
        ? 'no-cache'
        : versionedSound
          ? 'public, max-age=31536000, immutable'
          : 'public, max-age=0, must-revalidate';
      const baseHeaders = {
        'Content-Type': MIME[extension] || 'application/octet-stream',
        'Cache-Control': cacheControl,
        ETag: etag,
        'Last-Modified': lastModified,
        'Accept-Ranges': 'bytes',
        // Keep the dev server isolated; also enables high-resolution timers.
        'Cross-Origin-Opener-Policy': 'same-origin',
      };
      const compressible = COMPRESSIBLE_EXTENSIONS.has(extension) && stat.size > 1024;
      if (compressible) baseHeaders.Vary = 'Accept-Encoding';

      if (requestIsFresh(req.headers, etag, stat.mtimeMs)) {
        res.writeHead(304, baseHeaders).end();
        return;
      }

      const requestedRange = req.headers.range && ifRangeMatches(
        req.headers['if-range'], etag, stat.mtimeMs,
      ) ? parseSingleRange(req.headers.range, stat.size) : null;
      if (requestedRange?.invalid) {
        res.writeHead(416, {
          ...baseHeaders,
          'Content-Range': `bytes */${stat.size}`,
          'Content-Length': 0,
        }).end();
        return;
      }
      if (requestedRange) {
        const contentLength = requestedRange.end - requestedRange.start + 1;
        res.writeHead(206, {
          ...baseHeaders,
          'Content-Range': `bytes ${requestedRange.start}-${requestedRange.end}/${stat.size}`,
          'Content-Length': contentLength,
        });
        if (req.method === 'HEAD') res.end();
        else createReadStream(filePath, requestedRange).pipe(res);
        return;
      }

      const encoding = compressible ? acceptedCompression(req.headers['accept-encoding']) : null;
      if (encoding) {
        const key = `${filePath}\0${stat.mtimeMs}\0${stat.size}\0${encoding}`;
        const body = await compressionCache.getOrCreate(key, async () => {
          const source = await fs.readFile(filePath);
          return encoding === 'br' ? compressBrotli(source) : compressGzip(source);
        });
        res.writeHead(200, {
          ...baseHeaders,
          'Content-Encoding': encoding,
          'Content-Length': body.byteLength,
        });
        res.end(req.method === 'HEAD' ? undefined : body);
        return;
      }

      res.writeHead(200, { ...baseHeaders, 'Content-Length': stat.size });
      if (req.method === 'HEAD') res.end();
      else createReadStream(filePath).pipe(res);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
    }
  });
}

/** Create the in-memory room service with the production race adapter. */
export function createRoomManager(options = {}) {
  return new RoomManager({
    ...options,
    raceFactory: options.raceFactory ?? createDefaultRaceFactory(),
  });
}

/** Create the combined static HTTP and authoritative WebSocket server. */
export async function createGameServer({
  root = ROOT,
  roomManager = null,
  roomManagerOptions = {},
  allowedOrigins = process.env.ALLOWED_ORIGINS || '',
  logger = console,
  webSocketOptions = {},
  metricsToken = process.env.METRICS_TOKEN || '',
  metricsLogIntervalMs = Number(process.env.METRICS_LOG_INTERVAL_MS) || 60_000,
  maintenanceIntervalMs = Number(process.env.MAINTENANCE_INTERVAL_MS) || 500,
} = {}) {
  const packageMetadata = JSON.parse(await fs.readFile(join(root, 'package.json'), 'utf8'));
  const version = String(packageMetadata.version || '').trim();
  if (!version) throw new Error('package.json must define a non-empty version.');

  const metrics = new RuntimeMetrics({ logger, logIntervalMs: metricsLogIntervalMs });
  const manager = roomManager ?? createRoomManager({
    ...roomManagerOptions,
    metrics: roomManagerOptions.metrics ?? metrics,
  });
  if (roomManager && !roomManager.metrics) roomManager.metrics = metrics;
  let gateway = null;
  const server = createStaticServer(root, {
    metadataProvider: () => ({ version }),
    statsProvider: () => ({
      version,
      serverTime: Date.now(),
      onlineCount: gateway?.connectionCount ?? 0,
      rooms: manager.roomCount,
      activeRaces: manager.activeRaceCount,
    }),
    metricsProvider: () => metrics.snapshot(),
    metricsToken,
    healthProvider: () => ({
      uptimeSeconds: process.uptime(),
      rooms: manager.roomCount,
      races: manager.activeRaceCount,
      connections: gateway?.connectionCount ?? 0,
    }),
  });
  const { attachGameWebSocket } = await import('./server/websocket-game-server.js');
  gateway = attachGameWebSocket(server, {
    roomManager: manager,
    allowedOrigins,
    logger,
    metrics,
    ...webSocketOptions,
  });

  let disposed = false;
  const tickTimer = setInterval(() => {
    const startedAt = performance.now();
    try {
      const result = manager.tick();
      metrics.recordTick({
        durationMs: performance.now() - startedAt,
        catchUpSteps: result?.catchUpSteps ?? 0,
        catchUpCapped: result?.catchUpCapped ?? 0,
      });
    } catch (error) {
      logger.error?.('[multiplayer] authoritative tick failed', error);
      metrics.recordTick({ durationMs: performance.now() - startedAt, roomErrors: 1 });
    }
  }, 1000 / 60);
  tickTimer.unref?.();
  const maintenanceTimer = setInterval(() => {
    try {
      const now = manager.now?.() ?? performance.now();
      manager.maintenance?.(now);
      gateway?.maintenance(Date.now());
    } catch (error) {
      logger.error?.('[multiplayer] maintenance failed', error);
    }
  }, maintenanceIntervalMs);
  maintenanceTimer.unref?.();

  const onManagerError = (error) => logger.error?.('[multiplayer] room error', error);
  manager.on('managerError', onManagerError);

  async function disposeGameServices() {
    if (disposed) return;
    disposed = true;
    clearInterval(tickTimer);
    clearInterval(maintenanceTimer);
    manager.off('managerError', onManagerError);
    await gateway.close();
    manager.close();
    metrics.close();
  }

  server.once('close', () => { void disposeGameServices(); });
  server.roomManager = manager;
  server.webSocketGateway = gateway;
  server.runtimeMetrics = metrics;
  server.shutdown = async () => {
    await disposeGameServices();
    if (!server.listening) return;
    await new Promise((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    });
  };
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await createGameServer();
  server.listen(PORT, HOST, () => {
    console.log(`\n  🏁  Turbo Legends running at  http://${HOST}:${PORT}/\n`);
    console.log(`  Multiplayer WebSocket:    ws://${HOST}:${PORT}/ws\n`);
    console.log('  Press Ctrl+C to stop.\n');
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await server.shutdown();
      process.exitCode = 0;
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
