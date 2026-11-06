import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createStandaloneServer} from '../lib/standalone-server.js';
import {ADMIN_ROUTE} from '../lib/admin-route.js';

const SECRET = 'backend-admin-secret-never-for-the-browser';

async function fixture(t, {adminFetch} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt2api-web-test-'));
  const webRoot = path.join(root, 'web');
  fs.mkdirSync(path.join(webRoot, 'vendor'), {recursive:true});
  fs.mkdirSync(path.join(root, 'backend', 'data'), {recursive:true});
  for (const [name, value] of Object.entries({
    'index.html':'<!doctype html><title>Independent dashboard</title>',
    'app.js':'export const ready = true;',
    'dashboard.js':'export const dashboard = true;',
    'dashboard.css':'body { margin: 0; }',
    'logo.svg':'<svg xmlns="http://www.w3.org/2000/svg"><title>ChatGPT2API</title></svg>',
    'private.svg':'<svg xmlns="http://www.w3.org/2000/svg"><title>Private</title></svg>',
    'vendor/preact.mjs':'export const preact = true;',
    '.env':'PRIVATE_WEB_FILE=never-publish',
  })) fs.writeFileSync(path.join(webRoot, name), value);
  fs.writeFileSync(path.join(root, 'admin-key'), SECRET);
  const requests = [];
  let starts = 0;
  const manager = {
    baseUrl:'http://127.0.0.1:38650',
    paths:{root:path.join(root, 'backend'),data:path.join(root, 'backend', 'data')},
    status:()=>({managed:true,phase:'installing',message:'Preparing Python',baseUrl:'http://127.0.0.1:38650'}),
    async start() { starts += 1; return this.status(); },
    async stop() {},
  };
  const adminRoute = {path:ADMIN_ROUTE, async fetch(request) {
    requests.push({method:request.method,headers:Object.fromEntries(request.headers),body:await request.json()});
    return adminFetch ? adminFetch(request) : Response.json({items:[{ref:'redacted-account-reference',email:'test@example.com'}]});
  }};
  const app = createStandaloneServer({manager,secret:SECRET,webPort:0,webRoot,adminRoute});
  let address;
  try { address = await app.listen(); } catch (error) { fs.rmSync(root,{recursive:true,force:true}); throw error; }
  t.after(async()=>{await app.close();fs.rmSync(root,{recursive:true,force:true});});
  const url = address.url.replace(/\/$/, '');
  const token = new URL(address.loginUrl).hash.replace(/^#token=/, '');
  function request(route, {method='GET',body,headers={},cookie,origin}={}) {
    return fetch(url + route, {
      method,
      headers:{...(cookie?{Cookie:cookie}:{}),...(origin?{Origin:origin}:{}),...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},
      body:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body),
      redirect:'manual',
    });
  }
  async function login() {
    const response = await request('/api/session',{method:'POST',body:{token},origin:url});
    assert.equal(response.status,200,await response.clone().text());
    const setCookie = response.headers.get('set-cookie');
    assert.ok(setCookie);
    return {cookie:setCookie.split(';')[0],setCookie,response};
  }
  return {app,url,token,manager,requests,request,login,root,webRoot,get starts(){return starts;}};
}

function rawRequest(url, {pathname='/',method='GET',headers={},body}={}) {
  return new Promise((resolve,reject)=>{
    const target = new URL(url);
    const req = http.request({hostname:target.hostname,port:target.port,path:pathname,method,headers},response=>{
      const chunks=[];
      response.on('data',chunk=>chunks.push(chunk));
      response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,body:Buffer.concat(chunks).toString()}));
      response.on('error',reject);
    });
    req.on('error',reject);
    req.end(body);
  });
}

const rejected = (response, statuses=[400,403]) => assert.ok(statuses.includes(response.status), `expected rejection, got ${response.status}`);

test('independent management starts without DSH and requires its own browser session',async t=>{
  const f = await fixture(t);
  assert.match(f.token,/^[a-f0-9]{64}$/);
  assert.notEqual(f.token,SECRET);
  assert.equal(f.app.server.address().address,'127.0.0.1');
  const session = await f.request('/api/session');
  assert.equal(session.status,200);
  assert.deepEqual(await session.json(),{authenticated:false});
  assert.equal((await f.request('/api/runtime')).status,401);
  assert.equal((await f.request(ADMIN_ROUTE,{method:'POST',origin:f.url,body:{path:'/api/accounts'}})).status,401);
  assert.equal(f.requests.length,0);
  assert.equal(f.starts,0,'opening the HTTP listener must not initialize Python');

  const {cookie,setCookie} = await f.login();
  assert.match(setCookie,/HttpOnly/i);
  assert.match(setCookie,/SameSite=Strict/i);
  assert.match(setCookie,/Path=\//i);
  assert.ok(!cookie.includes(f.token),'session cookie is separate from the launch token');
  assert.ok(!cookie.includes(SECRET));
  const authenticated = await f.request('/api/session',{cookie});
  assert.deepEqual(await authenticated.json(),{authenticated:true});
});

test('login rejects missing/foreign origins and incorrect launch tokens',async t=>{
  const f = await fixture(t);
  rejected(await f.request('/api/session',{method:'POST',body:{token:f.token}}));
  rejected(await f.request('/api/session',{method:'POST',origin:'https://attacker.example',body:{token:f.token}}));
  rejected(await f.request('/api/session',{method:'POST',origin:'null',body:{token:f.token}}));
  rejected(await f.request('/api/session',{method:'POST',origin:f.url,body:{token:'bad-token'}}),[400,401,403]);
  rejected(await f.request('/api/session',{method:'POST',origin:f.url,body:{token:SECRET}}),[400,401,403]);
  rejected(await f.request('/api/session',{method:'POST',origin:f.url,body:{token:f.token},headers:{'Content-Type':'text/plain'}}),[400,403,415]);
  const malformed = await f.request('/api/session',{method:'POST',origin:f.url,body:'{'});
  assert.equal(malformed.status,400);
  assert.equal((await f.request('/api/session')).headers.get('access-control-allow-origin'),null);
});

test('Host validation prevents DNS rebinding for static files and management',async t=>{
  const f = await fixture(t);
  const {cookie} = await f.login();
  for (const host of ['attacker.example','localhost:'+new URL(f.url).port,'127.0.0.1:1']) {
    rejected(await rawRequest(f.url,{headers:{Host:host}}));
    rejected(await rawRequest(f.url,{pathname:ADMIN_ROUTE,method:'POST',headers:{Host:host,Origin:f.url,Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({path:'/api/accounts'})}));
  }
  assert.equal(f.requests.length,0);
});

test('authenticated management forwards only its explicit bridge without exposing the backend secret',async t=>{
  const f = await fixture(t);
  const {cookie} = await f.login();
  const payload = {path:'/api/accounts',method:'GET'};
  for (const origin of [undefined,'https://attacker.example','http://127.0.0.1:1']) {
    rejected(await f.request(ADMIN_ROUTE,{method:'POST',cookie,origin,body:payload}));
  }
  rejected(await f.request(ADMIN_ROUTE,{method:'POST',cookie,origin:f.url,body:payload,headers:{'Content-Type':'text/plain'}}),[400,403,415]);
  assert.equal(f.requests.length,0);
  const response = await f.request(ADMIN_ROUTE,{method:'POST',cookie,origin:f.url,body:payload});
  assert.equal(response.status,200);
  assert.match(response.headers.get('cache-control'),/no-store/);
  assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  const body = await response.text();
  assert.match(body,/test@example.com/);
  assert.ok(!body.includes(SECRET));
  assert.equal(f.requests.length,1);
  assert.equal(f.requests[0].method,'POST');
  assert.deepEqual(f.requests[0].body,payload);
  assert.ok(!JSON.stringify(f.requests[0].headers).includes(SECRET));
  assert.equal((await f.request('/api/settings',{cookie})).status,404);
  assert.equal((await f.request('/v1/models',{cookie})).status,404,'public API uses the independent backend and user API key');
});

test('runtime status and retry expose initialization progress within the owner session',async t=>{
  const f = await fixture(t);
  const {cookie} = await f.login();
  const runtime = await f.request('/api/runtime',{cookie});
  assert.equal(runtime.status,200);
  const status = await runtime.json();
  assert.equal(status.phase,'installing');
  assert.equal(status.apiBaseUrl,f.manager.baseUrl+'/v1');
  assert.equal(status.dataDir,f.manager.paths.root);
  assert.ok(!JSON.stringify(status).includes(SECRET));
  rejected(await f.request('/api/runtime/retry',{method:'POST',cookie,body:{}}));
  assert.equal(f.starts,0);
  const retry = await f.request('/api/runtime/retry',{method:'POST',cookie,origin:f.url,body:{}});
  assert.ok([200,202].includes(retry.status));
  // start() increments before its first async boundary.
  assert.equal(f.starts,1);
});

test('logout revokes the browser session and old cookies cannot be replayed',async t=>{
  const f = await fixture(t);
  const {cookie} = await f.login();
  rejected(await f.request('/api/logout',{method:'POST',cookie,body:{}}));
  assert.equal((await f.request('/api/runtime',{cookie})).status,200);
  const logout = await f.request('/api/logout',{method:'POST',cookie,origin:f.url,body:{}});
  assert.ok([200,204].includes(logout.status));
  assert.match(logout.headers.get('set-cookie'),/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
  assert.equal((await f.request('/api/runtime',{cookie})).status,401);
  assert.deepEqual(await (await f.request('/api/session',{cookie})).json(),{authenticated:false});
});

test('static files use an exact allowlist and cannot reveal local data or credentials',async t=>{
  const f = await fixture(t);
  const index = await f.request('/');
  assert.equal(index.status,200);
  assert.match(index.headers.get('content-type'),/text\/html/);
  assert.match(index.headers.get('content-security-policy'),/script-src 'self'/);
  assert.equal(index.headers.get('x-frame-options'),'DENY');
  assert.equal(index.headers.get('referrer-policy'),'no-referrer');
  assert.match(index.headers.get('cache-control'),/no-store/);
  assert.ok(!(await index.text()).includes(f.token));
  const head = await f.request('/app.js',{method:'HEAD'});
  assert.equal(head.status,200);
  assert.match(head.headers.get('content-type'),/javascript/);
  assert.equal(await head.text(),'');
  assert.equal((await f.request('/vendor/preact.mjs')).status,200);
  const logo = await f.request('/logo.svg');
  assert.equal(logo.status,200,'the browser icon is available before login');
  assert.match(logo.headers.get('content-type'),/^image\/svg\+xml/);
  assert.match(await logo.text(),/<title>ChatGPT2API<\/title>/);
  for (const pathname of ['/.env','/private.svg','/admin-key','/../admin-key','/%2e%2e/admin-key','/vendor/../../admin-key','/lib/index.js','/package.json','/source/data/accounts.json','/api/session/','//app.js']) {
    const response = await rawRequest(f.url,{pathname});
    rejected(response,[400,401,403,404]);
    assert.ok(!response.body.includes(SECRET));
  }
});

test('oversized request bodies are rejected before reaching account management',async t=>{
  const f = await fixture(t);
  const {cookie} = await f.login();
  const response = await rawRequest(f.url,{
    pathname:ADMIN_ROUTE,method:'POST',
    headers:{Origin:f.url,Cookie:cookie,'Content-Type':'application/json','Content-Length':String(71*1024*1024)},
  });
  assert.equal(response.status,413);
  assert.equal(f.requests.length,0);
});

test('sessions do not survive a standalone process restart',async t=>{
  const first = await fixture(t);
  const second = await fixture(t);
  const {cookie} = await first.login();
  assert.notEqual(first.token,second.token);
  assert.equal((await second.request('/api/runtime',{cookie})).status,401);
  rejected(await second.request('/api/session',{method:'POST',origin:second.url,body:{token:first.token}}),[400,401,403]);
});


test('whitelisted asset names cannot follow symlinks outside the web directory',async t=>{
  if(process.platform==='win32') return t.skip('creating file symlinks may require Windows developer mode');
  const f=await fixture(t);
  const appFile=path.join(f.webRoot,'app.js');
  fs.rmSync(appFile);
  fs.symlinkSync(path.join(f.root,'admin-key'),appFile);
  const response=await f.request('/app.js');
  assert.equal(response.status,404);
  assert.ok(!(await response.text()).includes(SECRET));
});

test('cross-site browser request metadata cannot bypass same-origin management checks',async t=>{
  const f=await fixture(t);
  const {cookie}=await f.login();
  const response=await f.request(ADMIN_ROUTE,{
    method:'POST',cookie,origin:f.url,body:{path:'/api/accounts'},headers:{'Sec-Fetch-Site':'cross-site'},
  });
  assert.equal(response.status,403);
  assert.equal(f.requests.length,0);
});

test('management errors redact both the backend secret and browser launch token',async t=>{
  let launchToken='';
  const f=await fixture(t,{adminFetch:()=>{throw new Error('Failure '+SECRET+' '+launchToken);}});
  launchToken=f.token;
  const {cookie}=await f.login();
  const response=await f.request(ADMIN_ROUTE,{method:'POST',cookie,origin:f.url,body:{path:'/api/accounts'}});
  assert.equal(response.status,500);
  const body=await response.text();
  assert.match(body,/REDACTED/);
  assert.ok(!body.includes(SECRET));
  assert.ok(!body.includes(f.token));
});

test('retry keeps an already-ready backend running without starting another process',async t=>{
  const f=await fixture(t);
  const {cookie}=await f.login();
  f.manager.status=()=>({managed:true,phase:'ready',message:'Ready'});
  const response=await f.request('/api/runtime/retry',{method:'POST',cookie,origin:f.url,body:{}});
  assert.equal(response.status,202);
  assert.equal(f.starts,0);
});
