// Local preview server that behaves like production (Cloudflare Pages +
// functions/_middleware.js): same resolver, same Page.html -> /Page mapping.
//   node scripts/serve.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { resolve } from '../src/redirects.js';

const DIST = path.join(import.meta.dirname, '..', 'dist');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.xml': 'application/xml', '.txt': 'text/plain', '.svg': 'image/svg+xml' };

export function createServer() {
  const data = JSON.parse(fs.readFileSync(path.join(DIST, '_routes-data.json'), 'utf8'));
  const routes = { ...data, pages: new Set(data.pages) };
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const r = resolve(url.pathname, routes);
    if (r) {
      res.writeHead(r.status, { Location: r.location + url.search });
      return res.end();
    }
    let p;
    try {
      p = decodeURI(url.pathname);
    } catch {
      p = url.pathname;
    }
    const candidates = routes.pages.has(p) ? [p === '/' ? 'index.html' : p.slice(1) + '.html'] : [p.slice(1)];
    for (const c of candidates) {
      const f = path.join(DIST, c);
      if (f.startsWith(DIST) && fs.existsSync(f) && fs.statSync(f).isFile()) {
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] ?? 'application/octet-stream' });
        return fs.createReadStream(f).pipe(res);
      }
    }
    res.writeHead(404, { 'Content-Type': TYPES['.html'] });
    fs.createReadStream(path.join(DIST, '404.html')).pipe(res);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = +(process.argv[2] ?? 4321);
  createServer().listen(port, () => console.log(`http://localhost:${port}`));
}
