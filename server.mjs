// Minimal static file server for Turbo Kart.
// ES modules require an http:// origin, so `npm start` and open the printed URL.
import { createServer } from 'node:http';
import { createReadStream, promises as fs, realpathSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || '127.0.0.1';

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

function isPublicPath(root, filePath) {
  if (!isInside(root, filePath)) return false;

  const rel = relative(root, filePath);
  const parts = rel.split(sep);
  if (!rel || parts.some(part => part.startsWith('.'))) return false;
  if (rel === 'index.html') return true;
  return parts[0] === 'src' || parts[0] === 'vendor' || parts[0] === 'sound';
}

export function createStaticServer(root = ROOT) {
  const staticRoot = realpathSync(resolve(root));

  return createServer(async (req, res) => {
    let filePath;
    try {
      filePath = safeJoin(staticRoot, req.url === '/' ? '/index.html' : req.url);
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

      res.writeHead(200, {
        'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'no-cache',
        // Keep the dev server isolated; also enables high-resolution timers.
        'Cross-Origin-Opener-Policy': 'same-origin',
      });
      createReadStream(filePath).pipe(res);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createStaticServer();
  server.listen(PORT, HOST, () => {
    console.log(`\n  🏁  Turbo Kart running at  http://${HOST}:${PORT}/\n`);
    console.log('  Press Ctrl+C to stop.\n');
  });
}
