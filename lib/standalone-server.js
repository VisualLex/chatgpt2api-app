/** Local management host. No Cordis, DSH session or public upstream proxy. */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {createAdminRoute, ADMIN_ROUTE} from './admin-route.js';

export const DEFAULT_WEB_PORT = 38651;
const MAX_BODY_BYTES = 70 * 1024 * 1024;
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ...['app.js', 'session.js', 'react.js', 'dashboard.js', 'vendor/preact.mjs', 'vendor/hooks.mjs'].map(file => ['/' + file, [file, 'text/javascript; charset=utf-8']]),
  ...['app.css', 'dashboard.css'].map(file => ['/' + file, [file, 'text/css; charset=utf-8']]),
  ['/logo.svg', ['logo.svg', 'image/svg+xml; charset=utf-8']],
  ['/vendor/LICENSE-preact.txt', ['vendor/LICENSE-preact.txt', 'text/plain; charset=utf-8']],
]);
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

function equalSecret(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function fault(message, status) { return Object.assign(new Error(message), {status}); }
function json(res, status, value, headers = {}) {
  res.writeHead(status, {...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...headers});
  res.end(JSON.stringify(value));
}
async function readBody(req, limit = MAX_BODY_BYTES) {
  if (Number(req.headers['content-length']) > limit) throw fault('请求体过大', 413);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw fault('请求体过大', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createStandaloneServer({manager, secret, webPort = DEFAULT_WEB_PORT,
  webRoot = fileURLToPath(new URL('../web/', import.meta.url)), adminRoute,
  sessionToken = randomBytes(32).toString('hex')} = {}) {
  if (!manager?.paths?.root || typeof manager.status !== 'function') throw new TypeError('缺少后端管理器');
  if (!Number.isInteger(Number(webPort)) || Number(webPort) < 0 || Number(webPort) > 65535) throw new TypeError('管理端口无效');
  if (typeof sessionToken !== 'string' || sessionToken.length < 32 || equalSecret(sessionToken, secret)) throw new TypeError('管理会话口令无效');
  const route = adminRoute || createAdminRoute({_adminKey: secret, manager, baseUrl: manager.baseUrl});
  const sessions = new Set();
  const root = path.resolve(webRoot);
  let origin = '', cookieName = '', listening;
  const cookie = (value, clear = false) => `${cookieName}=${value}; HttpOnly; SameSite=Strict; Path=/${clear ? '; Max-Age=0' : ''}`;
  const currentSession = req => {
    const entry = String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(cookieName + '='));
    return entry?.slice(cookieName.length + 1) || '';
  };
  function requireSession(req) {
    if (!sessions.has(currentSession(req))) throw fault('管理会话已失效，请使用启动终端中的登录链接重新打开', 401);
  }
  function requirePost(req) {
    if (req.method !== 'POST') throw fault('Method Not Allowed', 405);
    if (req.headers.origin !== origin) throw fault('只允许管理页面的同源请求', 403);
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw fault('需要 application/json 请求', 415);
  }
  function runtime() {
    return {...manager.status(), apiBaseUrl: manager.baseUrl + '/v1', dataDir: manager.paths.root, logs: manager.paths.logs || path.join(manager.paths.root, 'backend.log')};
  }
  const server = http.createServer(async (req, res) => {
    try {
      if (!origin || req.headers.host !== new URL(origin).host) throw fault('无效的本机 Host', 403);
      if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw fault('无效的请求路径', 400);
      const pathname = req.url.split('?')[0];
      if (pathname.startsWith('/api/')) {
        if ((req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') throw fault('禁止跨站管理请求', 403);
        if (pathname === '/api/session') {
          if (req.method === 'GET') return json(res, 200, {authenticated: sessions.has(currentSession(req))});
          requirePost(req);
          let payload;
          try { payload = JSON.parse((await readBody(req, 4096)).toString()); }
          catch (error) { throw error.status ? error : fault('请求 JSON 格式无效', 400); }
          if (!equalSecret(payload?.token, sessionToken)) throw fault('管理口令无效，请使用本次启动时的登录链接', 401);
          // New cookies never contain either the backend admin key or login token.
          const session = randomBytes(32).toString('hex');
          sessions.delete(currentSession(req));
          if (sessions.size >= 32) sessions.delete(sessions.values().next().value);
          sessions.add(session);
          return json(res, 200, {authenticated: true}, {'Set-Cookie': cookie(session)});
        }
        requireSession(req);
        if (pathname === '/api/runtime') {
          if (req.method !== 'GET') throw fault('Method Not Allowed', 405);
          return json(res, 200, runtime());
        }
        if (pathname === '/api/logout') {
          requirePost(req);
          await readBody(req, 4096);
          sessions.delete(currentSession(req));
          return json(res, 200, {authenticated: false}, {'Set-Cookie': cookie('', true)});
        }
        if (pathname === '/api/runtime/retry') {
          requirePost(req);
          await readBody(req, 4096);
          if (manager.status().phase !== 'ready') {
            // start() serializes initialization and records errors for /api/runtime.
            void Promise.resolve().then(() => manager.start()).catch(() => {});
          }
          return json(res, 202, {accepted: true});
        }
        if (pathname === ADMIN_ROUTE) {
          requirePost(req);
          const body = await readBody(req);
          const upstream = await route.fetch(new Request(origin + ADMIN_ROUTE, {
            method: 'POST', headers: {'Content-Type': 'application/json'}, body,
          }));
          res.writeHead(upstream.status, {...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8'});
          res.end(Buffer.from(await upstream.arrayBuffer()));
          return;
        }
        throw fault('接口不存在', 404);
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw fault('Method Not Allowed', 405);
      const entry = STATIC_FILES.get(pathname);
      if (!entry) throw fault('文件不存在', 404);
      const filename = await fs.realpath(path.join(root, entry[0])).catch(() => { throw fault('页面资源不存在，请运行 npm run build', 404); });
      const realRoot = await fs.realpath(root);
      if (!filename.startsWith(realRoot + path.sep)) throw fault('文件不存在', 404);
      const body = await fs.readFile(filename);
      res.writeHead(200, {...SECURITY_HEADERS, 'Content-Type': entry[1], 'Content-Length': body.length});
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (error) {
      if (res.destroyed || res.headersSent) return;
      const message = String(error?.message || '管理服务请求失败').replaceAll(String(secret || '\0'), '[REDACTED]').replaceAll(sessionToken, '[REDACTED]').slice(0, 350);
      json(res, Number.isInteger(error.status) ? error.status : 500, {error: message});
    }
  });
  server.requestTimeout = 300000;
  server.headersTimeout = 15000;
  return {
    server, sessionToken,
    listen() {
      if (listening) return listening;
      listening = new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({host: '127.0.0.1', port: Number(webPort), exclusive: true}, () => {
          server.removeListener('error', reject);
          const port = server.address().port;
          origin = `http://127.0.0.1:${port}`;
          cookieName = `c2a_session_${port}`;
          resolve({url: origin, loginUrl: origin + '/#token=' + sessionToken});
        });
      });
      return listening;
    },
    async close() {
      sessions.clear();
      if (!server.listening) return;
      await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    },
  };
}
