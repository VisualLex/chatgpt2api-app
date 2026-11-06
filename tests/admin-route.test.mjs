import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createAdminHandler,createAdminRoute,ADMIN_ROUTE,UserKeyStore} from '../lib/admin-route.js';
import {TaskHistory} from '../lib/task-history.js';
import {CredentialVault} from '../lib/credential-vault.js';

const SECRET='host-private-secret-which-client-never-sees';
const TOKEN='upstream_access_token_supersecret';
const headerStore=[];
const calls=[];
const fetcher=async (url,opts)=>{
  calls.push({url,method:opts.method,body:opts.body&&JSON.parse(opts.body)});
  headerStore.push(opts.headers.Authorization);
  const route=new URL(url).pathname;
  let data;
  if(route==='/api/accounts'&&opts.method==='GET')data={items:[{access_token:TOKEN,refresh_token:'refreshsecret',id_token:'idsecret',email:'a@example.com',status:'normal',type:'plus',quota:10}]};
  else if(route==='/api/accounts'&&opts.method==='DELETE')data={removed:1,items:[]};
  else if(route==='/api/accounts/refresh')data={progress_id:'progress123',items:[]};
  else if(route==='/api/accounts'&&opts.method==='POST')data={added:1,skipped:0,items:[{access_token:TOKEN}],errors:['oops with '+TOKEN]};
  else if(route==='/api/auth/users'&&opts.method==='GET')data={items:[{id:'abcdef012345',name:'Cherry Studio',enabled:true,created_at:'2026-11-04',key_hash:'secret-hash'}]};
  else if(route==='/api/auth/users'&&opts.method==='POST')data={key:'userkey123456',items:[{id:'abcdef012345',name:'Cherry Studio',enabled:true}]};
  else if(route==='/api/auth/users/abcdef012345')data={items:[]};
  else if(route==='/health')data={status:'ok',healthy:true,version:'test',accounts:{total:1,active:1}};
  else if(route==='/api/cpa/pools')data={pools:[{id:'cpa1',name:'pool',base_url:'https://service.test',secret_key:'hidden'}]};
  else if(route==='/api/sub2api/servers')data={servers:[{id:'sub1',name:'srv',base_url:'https://service.test',api_key:'hidden'}]};
  else if(route==='/v1/images/generations')data={data:[{b64_json:'aW1hZ2U='}]};
  else throw new Error('mock unhandled: '+route);
  return {status:200,ok:true,headers:{get:()=>null},text:async()=>JSON.stringify(data)};
};
const backend=createAdminHandler({baseUrl:'http://127.0.0.1:38650',secret:SECRET,fetcher});
function req(body){return new Request('http://localhost/api/chatgpt2api-native/manage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})}
async function call(payload){let res=await backend.route(req(payload));return {status:res.status,body:await res.json(),cache:res.headers.get('Cache-Control')}}
function accountDeletionFixture({size=2,removed=size,deleteStatus=200,deleteResult}={}){
  const accounts=Array.from({length:size},(_,i)=>({access_token:`private_batch_token_${i}`,email:`batch${i}@example.test`}));
  const observed=[];
  const handler=createAdminHandler({baseUrl:'http://127.0.0.1:38650',secret:SECRET,fetcher:async(url,opts)=>{
    const route=new URL(url).pathname;
    observed.push({path:route,method:opts.method,body:opts.body&&JSON.parse(opts.body)});
    assert.equal(route,'/api/accounts');
    if(opts.method==='GET')return Response.json({items:accounts});
    assert.equal(opts.method,'DELETE');
    return Response.json(deleteResult??{removed,items:accounts},{status:deleteStatus});
  }});
  return {handler,accounts,observed,refs:async()=>{
    const result=await handler.execute({path:'/api/accounts'});
    observed.length=0;
    return result.items.map(item=>item.ref);
  }};
}

test('register passwordless management only via DSH exact authenticated Connection route',()=>{
  const route=createAdminRoute({_adminKey:SECRET,baseUrl:'http://127.0.0.1:38650'});
  assert.equal(route.path,ADMIN_ROUTE);
  assert.deepEqual(route.methods,['POST']);
  assert.equal(route.requestBody,'buffered');
  assert.equal(typeof route.fetch,'function');
});
test('fetch health and accounts without browser admin key, never leak upstream credentials',async()=>{
  let res=await call({path:'/health?format=json'});
  assert.equal(res.body.accounts.active,1);assert.equal(res.body.baseUrl,'http://127.0.0.1:38650');assert.equal(res.cache,'no-store');
  res=await call({path:'/api/accounts'});
  assert.equal(res.body.items.length,1);
  assert.match(res.body.items[0].ref,/^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(res.body),/upstream_access_token|refreshsecret|idsecret/);
  assert.ok(headerStore.every(x=>x===`Bearer ${SECRET}`));
});
test('account deletion and refresh use opaque reference resolved by Host only',async()=>{
  const res=await call({path:'/api/accounts'});const ref=res.body.items[0].ref;
  const removed=await call({path:'/api/accounts',method:'DELETE',body:{tokens:[ref]}});
  assert.equal(removed.body.ok,true);
  const lastDelete=calls.filter(x=>x.method==='DELETE').at(-1);
  assert.equal(lastDelete.body.tokens[0],TOKEN);
  const refresh=await call({path:'/api/accounts/refresh',method:'POST',body:{access_tokens:[ref]}});
  assert.equal(refresh.body.progress_id,'progress123');
});
test('batch deletion resolves all opaque references once, deduplicates, and strips private upstream fields',async()=>{
  const fixture=accountDeletionFixture();
  const refs=await fixture.refs();
  const result=await fixture.handler.execute({path:'/api/accounts',method:'DELETE',body:{tokens:[refs[0],refs[1],refs[0]]}});
  assert.deepEqual(result,{ok:true,removed:2});
  assert.equal(fixture.observed.filter(call=>call.method==='GET').length,1);
  const deletions=fixture.observed.filter(call=>call.method==='DELETE');
  assert.equal(deletions.length,1);
  assert.deepEqual(deletions[0].body,{tokens:fixture.accounts.map(item=>item.access_token)});
  assert.doesNotMatch(JSON.stringify(result),/private_batch_token_|access_token|items/);
});
test('batch deletion permits 100 references and rejects empty, malformed, or oversized batches before forwarding',async()=>{
  const fixture=accountDeletionFixture({size:100});
  const refs=await fixture.refs();
  const result=await fixture.handler.execute({path:'/api/accounts',method:'DELETE',body:{tokens:refs}});
  assert.equal(result.removed,100);
  assert.equal(fixture.observed.filter(call=>call.method==='DELETE').length,1);
  fixture.observed.length=0;
  for(const tokens of [undefined,null,[],refs[0],[refs[0],null],[refs[0],{}],[refs[0],'private_batch_token_0'],[...refs,refs[0]]]){
    await assert.rejects(()=>fixture.handler.execute({path:'/api/accounts',method:'DELETE',body:{tokens}}),err=>err.status===400);
  }
  assert.equal(fixture.observed.length,0,'invalid requests cannot read or mutate the upstream pool');
});
test('a stale reference prevents every deletion in the batch',async()=>{
  const fixture=accountDeletionFixture();
  const refs=await fixture.refs();
  await assert.rejects(()=>fixture.handler.execute({path:'/api/accounts',method:'DELETE',body:{tokens:[refs[0],'0'.repeat(64)]}}),err=>err.status===404&&/刷新账号列表/.test(err.message));
  assert.equal(fixture.observed.filter(call=>call.method==='GET').length,1);
  assert.equal(fixture.observed.filter(call=>call.method==='DELETE').length,0);
});
test('batch deletion reports actual removed counts and rejects invalid upstream results',async()=>{
  for(const removed of [0,1]){
    const fixture=accountDeletionFixture({removed});
    const refs=await fixture.refs();
    assert.deepEqual(await fixture.handler.execute({path:'/api/accounts',method:'DELETE',body:{tokens:refs}}),{ok:true,removed});
  }
  for(const deleteResult of [{},{removed:'2'},{removed:-1},{removed:3}]){
    const fixture=accountDeletionFixture({deleteResult});
    const refs=await fixture.refs();
    await assert.rejects(()=>fixture.handler.execute({path:'/api/accounts',method:'DELETE',body:{tokens:refs}}),err=>err.status===502&&/刷新账号列表确认/.test(err.message));
  }
});
test('batch deletion upstream failures reach the UI without exposing account tokens',async()=>{
  const fixture=accountDeletionFixture({deleteStatus:500,deleteResult:{error:'private_batch_token_0 '+SECRET}});
  const refs=await fixture.refs();
  const res=await fixture.handler.route(req({path:'/api/accounts',method:'DELETE',body:{tokens:refs}}));
  assert.equal(res.status,500);
  const result=await res.json();
  assert.match(result.error,/HTTP 500/);
  assert.doesNotMatch(JSON.stringify(result),/private_batch_token_|host-private-secret/);
});
test('independent user API keys stay separate from Host admin secret',async()=>{
  const created=await call({path:'/api/auth/users',method:'POST',body:{name:'Cherry Studio'}});
  assert.equal(created.body.key,'userkey123456');assert.ok(!JSON.stringify(created.body).includes(SECRET));
  const listed=await call({path:'/api/auth/users'});
  assert.equal(listed.body.items[0].id,'abcdef012345');
  assert.ok(!JSON.stringify(listed.body).includes('key_hash'));
});
test('generic or malicious paths are not forwarded to upstream',async()=>{
  const n=calls.length;
  for(const path of ['/api/settings','/api/accounts/oauth/start','http://attacker/','/api/../../api/settings']){
    const res=await call({path});assert.equal(res.status,404);
  }
  assert.equal(calls.length,n);
});
test('CPA/sub2api connection secrets are stripped from UI response',async()=>{
  const cpa=await call({path:'/api/cpa/pools'}),sub=await call({path:'/api/sub2api/servers'});
  assert.doesNotMatch(JSON.stringify(cpa.body),/secret_key/);
  assert.doesNotMatch(JSON.stringify(sub.body),/api_key/);
});
test('image generation uses protected Host bridge, not upstream auth in browser',async()=>{
  const result=await call({path:'/v1/images/generations',method:'POST',body:{model:'gpt-image-2',prompt:'An original scene',n:1}});
  assert.equal(result.body.data[0].b64_json,'aW1hZ2U=');
});
test('sensitive import errors and upstream items are not returned to browser',async()=>{
  const result=await call({path:'/api/accounts',method:'POST',body:{tokens:[TOKEN]}});
  assert.equal(result.body.added,1);
  assert.equal(result.body.errorCount,1);
  assert.doesNotMatch(JSON.stringify(result.body),/upstream_access_token/);
});
test('direct text authentication converts credentials to tokens and enrolls to upstream',async()=>{
  let registered=null;
  const mockFetcher=async (url,opts)=>{
    if(url.endsWith('/api/accounts')&&opts.method==='POST'){
      registered=JSON.parse(opts.body);
      return {status:200,ok:true,headers:{get:()=>null},text:async()=>JSON.stringify({added:1,skipped:0,refreshed:1,errors:[]})};
    }
    return {status:200,ok:true,headers:{get:()=>null},text:async()=>JSON.stringify({})};
  };
  const mockAuth=async ({accounts})=>({
    results: accounts.map(a=>({
      id: a.id,
      email: a.email,
      ok: true,
      access_token: 'secret_token_12345',
      refresh_token: 'rt_secret_67890',
      id_token: 'id_secret_abc'
    }))
  });
  const mockVault={list:()=>({count:0,items:[]}),getAll:()=>[],get:()=>null,delete:()=>{},updateStatus:()=>{},importText:()=>{}};
  const handler=createAdminHandler({
    baseUrl:'http://127.0.0.1:38650',
    secret:SECRET,
    fetcher:mockFetcher,
    vault:mockVault,
    authenticator:mockAuth
  });
  const request=new Request('http://localhost/api/chatgpt2api-native/manage',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      path:'/local/credential-vault/authenticate',
      method:'POST',
      body:{text:'direct@example.com----p@ssword----TOTPSECRET123'}
    })
  });
  const res=await handler.route(request);
  const data=await res.json();
  assert.equal(data.total,1);
  assert.equal(data.succeeded,1);
  assert.equal(data.enrolled.added,1);
  assert.equal(registered.tokens[0],'secret_token_12345');
  assert.equal(registered.accounts[0].email,'direct@example.com');
  assert.equal(registered.accounts[0].totp_secret,'TOTPSECRET123');
  assert.doesNotMatch(JSON.stringify(data),/secret_token|rt_secret|p@ssword|TOTPSECRET/);
});

test('UserKeyStore persists keys to disk and reloads them', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2a-test-keys-'));
  try {
    const store1 = new UserKeyStore({root: tmpDir});
    store1.set('key1', 'sk-test123456');
    assert.equal(store1.get('key1'), 'sk-test123456');

    // Reload from same dir
    const store2 = new UserKeyStore({root: tmpDir});
    assert.equal(store2.get('key1'), 'sk-test123456');

    store2.delete('key1');
    assert.equal(store2.get('key1'), '');

    const store3 = new UserKeyStore({root: tmpDir});
    assert.equal(store3.get('key1'), '');
  } finally {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  }
});

test('user API key creation retains plain key and exposes it in user list', async () => {
  let userItems = [];
  const testFetcher = async (url, opts) => {
    const route = new URL(url).pathname;
    if (route === '/api/auth/users' && opts.method === 'POST') {
      const createdItem = {id: 'usr_abc123', name: 'Test Key', enabled: true, created_at: '2026-11-04T12:00:00Z'};
      userItems = [createdItem];
      return {status: 200, ok: true, headers: {get: () => null}, text: async () => JSON.stringify({item: createdItem, key: 'sk-plaintext-key-xyz', items: userItems})};
    }
    if (route === '/api/auth/users' && opts.method === 'GET') {
      return {status: 200, ok: true, headers: {get: () => null}, text: async () => JSON.stringify({items: userItems})};
    }
    if (route.startsWith('/api/auth/users/') && opts.method === 'DELETE') {
      userItems = [];
      return {status: 200, ok: true, headers: {get: () => null}, text: async () => JSON.stringify({items: []})};
    }
    throw new Error('unhandled ' + route);
  };
  const keyStore = new UserKeyStore();
  const testHandler = createAdminHandler({baseUrl: 'http://127.0.0.1:38650', secret: SECRET, fetcher: testFetcher, keyStore});
  const exec = async (payload) => {
    const res = await testHandler.route(new Request('http://localhost/api/chatgpt2api-native/manage', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)}));
    return res.json();
  };

  const createRes = await exec({path: '/api/auth/users', method: 'POST', body: {name: 'Test Key'}});
  assert.equal(createRes.key, 'sk-plaintext-key-xyz');
  assert.equal(createRes.id, 'usr_abc123');
  assert.equal(createRes.items[0].key, 'sk-plaintext-key-xyz');

  const listRes = await exec({path: '/api/auth/users', method: 'GET'});
  assert.equal(listRes.items.length, 1);
  assert.equal(listRes.items[0].id, 'usr_abc123');
  assert.equal(listRes.items[0].key, 'sk-plaintext-key-xyz');

  const delRes = await exec({path: '/api/auth/users/usr_abc123', method: 'DELETE'});
  assert.equal(delRes.items.length, 0);
  assert.equal(keyStore.get('usr_abc123'), '');
});

test('opening the local image history folder only accepts the fixed Host path', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2a-test-images-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.png'), 'x');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'x');
    let opened = null;
    const handler = createAdminHandler({
      baseUrl: 'http://127.0.0.1:38650',
      secret: SECRET,
      fetcher,
      imagesDir: dir,
      openFolder: async (target) => { opened = target; },
    });
    const exec = async (payload) => {
      const res = await handler.route(new Request('http://localhost/api/chatgpt2api-native/manage', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)}));
      return {status: res.status, body: await res.json()};
    };

    const ok = await exec({path: '/local/open-images-dir', method: 'POST'});
    assert.equal(ok.status, 200);
    assert.equal(ok.body.opened, true);
    assert.equal(ok.body.count, 1);
    assert.equal(ok.body.dir, path.resolve(dir));
    assert.equal(opened, path.resolve(dir));

    // GET only reports the copyable path, never launches anything.
    const get = await exec({path: '/local/open-images-dir', method: 'GET'});
    assert.equal(get.status, 200);
    assert.equal(get.body.dir, path.resolve(dir));
    assert.equal(get.body.count, 1);
    assert.equal(get.body.opened, false);

    // A failed launch still returns the path so the UI can offer copy/paste.
    let launchError = null;
    const failing = createAdminHandler({
      baseUrl: 'http://127.0.0.1:38650',
      secret: SECRET,
      fetcher,
      imagesDir: dir,
      openFolder: async () => { throw new Error('opener exploded'); },
    });
    const failRes = await failing.route(new Request('http://localhost/api/chatgpt2api-native/manage', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({path: '/local/open-images-dir', method: 'POST'})}));
    launchError = await failRes.json();
    assert.equal(failRes.status, 200);
    assert.equal(launchError.opened, false);
    assert.equal(launchError.dir, path.resolve(dir));
    assert.match(launchError.error, /opener exploded/);

    const external = createAdminHandler({baseUrl: 'http://127.0.0.1:38650', secret: SECRET, fetcher});
    const res = await external.route(new Request('http://localhost/api/chatgpt2api-native/manage', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({path: '/local/open-images-dir', method: 'POST'})}));
    assert.equal(res.status, 503);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});



test('authenticate route deduplicates identical accounts in input text and correctly aggregates skipped count', async () => {
  let registered = null;
  let authTargets = [];
  const mockFetcher = async (url, opts) => {
    if (url.endsWith('/api/accounts') && opts.method === 'POST') {
      registered = JSON.parse(opts.body);
      return {status: 200, ok: true, headers: {get: () => null}, text: async () => JSON.stringify({added: 1, skipped: 0, refreshed: 0, errors: []})};
    }
    return {status: 200, ok: true, headers: {get: () => null}, text: async () => JSON.stringify({})};
  };
  const mockAuth = async ({accounts}) => {
    authTargets = accounts;
    return {
      results: accounts.map(a => ({
        id: a.id,
        email: a.email,
        ok: true,
        access_token: 'secret_token_dup_test',
        refresh_token: 'rt_secret_dup_test',
        id_token: 'id_secret_dup_test'
      }))
    };
  };
  const mockVault = {list: () => ({count: 0, items: []}), getAll: () => [], get: () => null, delete: () => {}, updateStatus: () => {}, importText: () => {}};
  const handler = createAdminHandler({
    baseUrl: 'http://127.0.0.1:38650',
    secret: SECRET,
    fetcher: mockFetcher,
    vault: mockVault,
    authenticator: mockAuth
  });

  const dupText = [
    'repeat@example.com----pass1----2FASECRET1',
    'repeat@example.com----pass2----2FASECRET2'
  ].join('\n');

  const request = new Request('http://localhost/api/chatgpt2api-native/manage', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      path: '/local/credential-vault/authenticate',
      method: 'POST',
      body: {text: dupText}
    })
  });
  const res = await handler.route(request);
  const data = await res.json();

  assert.equal(data.total, 2);
  assert.equal(data.duplicates, 1);
  assert.equal(data.succeeded, 1);
  assert.equal(data.enrolled.added, 1);
  assert.equal(data.enrolled.skipped, 1);
  assert.equal(authTargets.length, 1);
  assert.equal(authTargets[0].email, 'repeat@example.com');
  assert.equal(registered.accounts.length, 1);
});

test('a non-JSON backend reply reports status and a redacted body snippet', async () => {  // uvicorn answers an unhandled ASGI exception with plain text. Reporting only
  // "not valid JSON" hides both the status and the real cause from the user.
  const plainTextFetcher = async () => ({
    status: 500,
    ok: false,
    headers: {get: name => (name === 'content-type' ? 'text/plain; charset=utf-8' : null)},
    text: async () => `Internal Server Error: No module named 'anyio._backends' ${SECRET} sk-abcdef123456`
  });
  const handler = createAdminHandler({baseUrl: 'http://127.0.0.1:38650', secret: SECRET, fetcher: plainTextFetcher});
  const res = await handler.route(new Request('http://localhost/api/chatgpt2api-native/manage', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({path: '/health?format=json'})
  }));
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.match(body.error, /HTTP 500/);
  assert.match(body.error, /text\/plain/);
  assert.match(body.error, /anyio\._backends/);
  assert.doesNotMatch(body.error, new RegExp(SECRET));
  assert.doesNotMatch(body.error, /sk-abcdef123456/);
});


test('zero-quota proxy controls do not expose other settings or credentials',async()=>{
  let savedProxy='';
  const observed=[];
  const mock=async (url,opts)=>{
    const route=new URL(url).pathname;
    const dataIn=opts.body?JSON.parse(opts.body):null;
    observed.push({route,method:opts.method,dataIn});
    let data;
    if(route==='/api/settings'&&opts.method==='GET')data={config:{proxy:savedProxy,'auth-key':'never-expose',backup:{password:'private'}}};
    else if(route==='/api/settings'&&opts.method==='POST'){savedProxy=dataIn.proxy;data={config:{proxy:savedProxy,secret:'hidden'}}}
    else if(route==='/api/proxy/test')data={result:{ok:true,status:200,latency_ms:393,proxy_source:'input',has_proxy:true,error:null,debug_token:TOKEN}};
    else if(route==='/api/accounts'&&opts.method==='GET')data={items:[{access_token:TOKEN,quota:0,status:'正常',last_refresh_error:'secret '+TOKEN}]};
    else if(route==='/api/accounts/refresh'&&opts.method==='POST')data={progress_id:'11111111-1111-1111-1111-111111111111'};
    else if(route==='/api/accounts/refresh/progress/11111111-1111-1111-1111-111111111111')
      data={done:true,total:1,processed:1,total_quota:27,result:{refreshed:1,errors:[{token:TOKEN,error:'supersecret'}],items:[{access_token:TOKEN}]}};
    else throw Error('unexpected upstream request '+route);
    return {ok:true,status:200,headers:{get:()=>null},text:async()=>JSON.stringify(data)};
  };
  const handler=createAdminHandler({baseUrl:'http://127.0.0.1:38650',secret:SECRET,fetcher:mock});
  const original=await handler.execute({path:'/local/proxy'});
  assert.equal(original.configured,false);
  const saved=await handler.execute({path:'/local/proxy',method:'POST',body:{url:'http://127.0.0.1:7897'}});
  assert.equal(saved.url,'http://127.0.0.1:7897');
  const loaded=await handler.execute({path:'/local/proxy'});
  assert.equal(loaded.configured,true);
  assert.doesNotMatch(JSON.stringify(loaded),/never-expose|private/);
  assert.deepEqual(observed.find(x=>x.route==='/api/settings'&&x.method==='POST').dataIn,{proxy:'http://127.0.0.1:7897'});
  const tested=await handler.execute({path:'/local/proxy/test',method:'POST',body:{url:'http://127.0.0.1:7897'}});
  assert.equal(tested.result.status,200);
  assert.doesNotMatch(JSON.stringify(tested),/debug_token|upstream_access_token/);
  const accounts=await handler.execute({path:'/api/accounts'});
  assert.equal(accounts.items[0].quota,0);
  assert.equal(accounts.items[0].quota_check_failed,true);
  const refresh=await handler.execute({path:'/local/accounts/refresh-all',method:'POST'});
  assert.equal(refresh.total,1);
  assert.deepEqual(observed.find(x=>x.route==='/api/accounts/refresh').dataIn,{access_tokens:[]});
  const progress=await handler.execute({path:'/api/accounts/refresh/progress/'+refresh.progress_id});
  assert.deepEqual(progress,{done:true,total:1,processed:1,total_quota:27,errorCount:1,refreshed:1});
  assert.doesNotMatch(JSON.stringify(progress),/upstream_access_token|supersecret/);
  for(const invalid of ['file:///tmp/evil','http://name:pass@127.0.0.1:7897','http://127.0.0.1:7897/path','http://127.0.0.1:7897?x=1']){
    await assert.rejects(()=>handler.execute({path:'/local/proxy',method:'POST',body:{url:invalid}}));
  }
  const socks=await handler.execute({path:'/local/proxy',method:'POST',body:{url:'socks5://127.0.0.1:1080'}});
  assert.equal(socks.url,'socks5://127.0.0.1:1080');
  await assert.rejects(()=>handler.execute({path:'/api/settings'}));
  await assert.rejects(()=>handler.execute({path:'/api/accounts/refresh/progress/not-a-uuid'}));
});

test('proxy URLs with credentials are not returned to the browser',async()=>{
  const handler=createAdminHandler({
    baseUrl:'http://127.0.0.1:38650',secret:SECRET,
    fetcher:async()=>({ok:true,status:200,headers:{get:()=>null},text:async()=>JSON.stringify({config:{proxy:'http://user:password@127.0.0.1:7897'}})})
  });
  const proxy=await handler.execute({path:'/local/proxy'});
  assert.equal(proxy.configured,true);
  assert.equal(proxy.hasCredentials,true);
  assert.equal(proxy.url,'');
  assert.doesNotMatch(JSON.stringify(proxy),/password|user:/);
});

test('GIF requests carry the animation flags and translate an all-still reply into advice', async () => {
  const sent=[];
  const gifFetcher=async (url,opts)=>{
    const route=new URL(url).pathname;
    if(route!=='/v1/images/generations')throw new Error('unexpected '+route);
    sent.push(JSON.parse(opts.body));
    return {status:502,ok:false,headers:{get:()=>null},text:async()=>JSON.stringify({detail:{error:'upstream did not return an animated GIF'}})};
  };
  const handler=createAdminHandler({baseUrl:'http://127.0.0.1:38650',secret:SECRET,fetcher:gifFetcher});
  const res=await handler.route(req({path:'/v1/images/generations',method:'POST',body:{model:'gpt-image-2.6',prompt:'橘猫追蝴蝶循环动画',output_format:'gif',frame_count:8,frame_duration_ms:120}}));
  assert.equal(res.status,502);
  const body=await res.json();
  assert.match(body.error,/静态图/);
  assert.doesNotMatch(body.error,/upstream did not return/);
  assert.equal(sent.length,1);
  assert.deepEqual({f:sent[0].output_format,c:sent[0].frame_count,d:sent[0].frame_duration_ms},{f:'gif',c:8,d:120});
  assert.equal(sent[0].n,1);assert.equal(sent[0].response_format,'b64_json');
});

test('GIF parameters are rejected before reaching the backend', async () => {
  const handler=createAdminHandler({baseUrl:'http://127.0.0.1:38650',secret:SECRET,fetcher:async()=>{throw new Error('must not call upstream')}});
  const send=async body=>{const res=await handler.route(req({path:'/v1/images/generations',method:'POST',body}));return {status:res.status,body:await res.json()}};
  let r=await send({model:'gpt-image-2.6',prompt:'x',output_format:'gif',frame_count:1});
  assert.equal(r.status,400);assert.match(r.body.error,/2–16/);
  r=await send({model:'gpt-image-2.6',prompt:'x',output_format:'gif',frame_count:8,frame_duration_ms:205});
  assert.equal(r.status,400);assert.match(r.body.error,/10 毫秒/);
  r=await send({model:'gpt-image-2',prompt:'x',output_format:'gif',frame_count:8});
  assert.equal(r.status,400);assert.match(r.body.error,/GPT Image 2\.6/);
});

const TASK_PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=','base64');
function historyFixture(t,options={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'c2a-history-routes-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const taskHistory=new TaskHistory({root});
  const handler=createAdminHandler({baseUrl:'http://127.0.0.1:38650',secret:SECRET,taskHistory,taskPollIntervalMs:0,...options});
  return {root,taskHistory,handler};
}
const submitHistory=(handler,type,params,requestId)=>handler.execute({path:'/local/tasks',method:'POST',body:{type,params,requestId}});

test('history image submission returns before upstream completion and saves protected result files',async t=>{
  let finishImage,started;
  const startedPromise=new Promise(resolve=>{started=resolve});
  const {handler,taskHistory,root}=historyFixture(t,{fetcher:async(url,options)=>{
    assert.equal(new URL(url).pathname,'/v1/images/generations');
    assert.equal(options.signal.aborted,false);started();
    return new Promise(resolve=>{finishImage=()=>resolve(Response.json({data:[{b64_json:TASK_PNG.toString('base64')}]}))});
  }});
  const response=await handler.route(req({path:'/local/tasks',method:'POST',body:{type:'image',params:{prompt:'本机测试图片',model:'gpt-image-2'},requestId:'history-image-quick'}}));
  assert.equal(response.status,200);
  const submitted=(await response.json()).task;
  assert.equal(submitted.status,'queued');
  await startedPromise;
  assert.equal(taskHistory.get(submitted.id).status,'running');
  finishImage();await taskHistory.waitForIdle();
  const {task}=await handler.execute({path:'/local/tasks/'+submitted.id});
  assert.equal(task.status,'succeeded');assert.equal(task.result.files.length,1);
  assert.doesNotMatch(JSON.stringify(task),/b64_json|host-private-secret|filePath/);
  const file=await handler.execute({path:'/local/task-files/'+task.result.files[0].id});
  assert.equal(file.mimeType,'image/png');assert.deepEqual(Buffer.from(file.b64_json,'base64'),TASK_PNG);
  assert.equal(fs.readFileSync(path.join(root,'task-history.json'),'utf8').includes(TASK_PNG.toString('base64')),false);
  const duplicate=await submitHistory(handler,'image',{model:'gpt-image-2',prompt:'本机测试图片'},'history-image-quick');
  assert.equal(duplicate.task.id,task.id,'object key ordering does not change idempotency');
  await assert.rejects(()=>submitHistory(handler,'image',{prompt:'other'},'history-image-quick'),error=>error.status===409);
});

test('reference files survive failed generation and retry copies only registered inputs',async t=>{
  let requests=0;
  const {handler,taskHistory}=historyFixture(t,{fetcher:async(_url,options)=>{
    const body=JSON.parse(options.body);requests++;
    assert.equal(body.images[0].b64_json,TASK_PNG.toString('base64'));
    if(requests===1)return Response.json({error:SECRET+' upstream_access_token private_password'},{status:502});
    return Response.json({data:[{b64_json:TASK_PNG.toString('base64')}]});
  }});
  const {task}=await submitHistory(handler,'image',{prompt:'带参考图',images:[{b64_json:TASK_PNG.toString('base64'),mime_type:'image/png'}]},'history-reference-first');
  assert.equal(task.params.referenceFiles.length,1);
  assert.ok(task.params.referenceFiles[0].id);
  await taskHistory.waitForIdle();
  const failed=taskHistory.get(task.id);assert.equal(failed.status,'failed');
  assert.doesNotMatch(JSON.stringify(failed),/upstream_access_token|private_password|host-private-secret/);
  const retry=await handler.execute({path:'/local/tasks/'+task.id+'/retry',method:'POST',body:{requestId:'history-reference-retry'}});
  assert.notEqual(retry.task.id,task.id);assert.equal(retry.task.parentTaskId,task.id);
  await taskHistory.waitForIdle();
  assert.equal(taskHistory.get(retry.task.id).status,'succeeded');assert.equal(requests,2);
  const deleted=await handler.execute({path:'/local/tasks/'+task.id,method:'DELETE'});assert.equal(deleted.ok,true);
  assert.ok(await handler.execute({path:'/local/task-files/'+task.params.referenceFiles[0].id}),'deleting metadata does not delete image files');
});

test('invalid reference images fail preparation without calling upstream',async t=>{
  let calls=0;
  const {handler,taskHistory}=historyFixture(t,{fetcher:async()=>{calls++;throw Error('must not run')}});
  await assert.rejects(()=>submitHistory(handler,'image',{prompt:'x',images:[{b64_json:Buffer.from('not an image').toString('base64'),mime_type:'image/png'}]},'history-invalid-file'),/参考图片/);
  await taskHistory.waitForIdle();
  assert.equal(calls,0);assert.equal(taskHistory.list().items[0].status,'failed');
  const failed=taskHistory.list().items[0];
  await assert.rejects(()=>handler.execute({path:'/local/tasks/'+failed.id+'/retry',method:'POST',body:{requestId:'invalid-file-retry'}}),/参考图片未完整保存/);
  assert.equal(calls,0,'a failed preparation cannot be retried as text-only generation');
  for(const referenceFiles of [[{id:'../../etc/passwd'}],[{id:'11111111-1111-1111-1111-111111111111'}]]){
    await assert.rejects(()=>submitHistory(handler,'image',{prompt:'x',referenceFiles},'invalid-file-'+referenceFiles[0].id.replaceAll('/','_')));
  }
});

test('queued image edits reload registered files when execution starts instead of retaining raw references',async t=>{
  let finishFirst;let edits=0;
  const {handler,taskHistory,root}=historyFixture(t,{fetcher:async(url)=>{
    if(new URL(url).pathname==='/v1/images/edits'){edits++;return Response.json({data:[{b64_json:TASK_PNG.toString('base64')}]});}
    return new Promise(resolve=>{finishFirst=()=>resolve(Response.json({data:[{b64_json:TASK_PNG.toString('base64')}]}))});
  }});
  await submitHistory(handler,'image',{prompt:'occupy the runner'},'queued-image-first');
  const {task}=await submitHistory(handler,'image',{prompt:'queued edit',images:[{b64_json:TASK_PNG.toString('base64'),mime_type:'image/png'}]},'queued-image-edit');
  assert.equal(task.status,'queued');
  fs.rmSync(path.join(root,'task-files',task.params.referenceFiles[0].id+'.png'));
  finishFirst();await taskHistory.waitForIdle();
  assert.equal(edits,0,'a missing registered reference cannot fall back to a captured base64 copy');
  assert.equal(taskHistory.get(task.id).status,'failed');
});

test('GIF history saves actual GIF output and refuses a still PNG result',async t=>{
  const gif=Buffer.from('R0lGODlhAQABAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAQABAAAIBAABBAQAIfkEAQoAAQAsAAAAAAEAAQCBAAD/AAAAAAAAAAAACAQAAQQEADs=','base64');
  let requests=0;
  const {handler,taskHistory}=historyFixture(t,{fetcher:async(_url,options)=>{
    const input=JSON.parse(options.body);assert.equal(input.output_format,'gif');assert.equal(input.frame_count,2);
    return Response.json({data:[{b64_json:(++requests===1?gif:TASK_PNG).toString('base64')}]});
  }});
  const params={prompt:'two color animation',model:'gpt-image-2.6',frame_count:2,frame_duration_ms:100};
  const {task}=await submitHistory(handler,'gif',params,'history-gif-real');await taskHistory.waitForIdle();
  const completed=taskHistory.get(task.id);assert.equal(completed.status,'succeeded');assert.equal(completed.result.frame_count,2);assert.equal(completed.result.files[0].mimeType,'image/gif');
  const {task:still}=await submitHistory(handler,'gif',params,'history-gif-still');await taskHistory.waitForIdle();
  assert.equal(taskHistory.get(still.id).status,'failed');assert.match(taskHistory.get(still.id).error,/未返回 GIF/);
});

test('authorization history stores no credentials and retry processes only failed vault records',async t=>{
  let run=0;const emails=[];
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'c2a-history-auth-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const vault=new CredentialVault({root,secret:SECRET});
  const {handler,taskHistory}=historyFixture(t,{vault,authenticator:async({accounts})=>{
    const account=accounts[0];emails.push(account.email);run++;
    return {results:[account.email==='bad@example.test'&&run<=2?{...account,ok:false,error:'password private-password TOTP ABCDEFGHIJKLMNOP'}:{...account,ok:true,access_token:'new-private-token'}]};
  },fetcher:async()=>Response.json({added:1,skipped:0,refreshed:0,errors:[]})});
  const text='good@example.test----private-password----ABCDEFGHIJKLMNOP\nbad@example.test----another-password----ABCDEFGHIJKLMNOP\ninvalid-private-password-ABCDEFGHIJKLMNOP';
  const {task}=await submitHistory(handler,'authorize',{text},'history-auth-first');
  assert.equal(task.params.ids.length,2);assert.equal(task.params.text,undefined);
  await taskHistory.waitForIdle();
  const completed=taskHistory.get(task.id);
  assert.equal(completed.status,'partial');assert.equal(completed.result.succeeded,1);assert.equal(completed.result.failed,1);
  assert.deepEqual(completed.result.errors,[{line:3,reason:'应为邮箱----密码----第三字段（恰好三个字段）'}]);
  assert.equal(vault.list().count,1);
  assert.doesNotMatch(JSON.stringify(completed),/private-password|another-password|ABCDEFGHIJKLMNOP|new-private-token|totp_secret|password/);
  const repeated=await submitHistory(handler,'authorize',{text},'history-auth-first');
  assert.equal(repeated.task.id,task.id);assert.equal(vault.list().count,1,'a duplicate submission cannot re-stage successful credentials');
  const {task:retry}=await handler.execute({path:'/local/tasks/'+task.id+'/retry',method:'POST',body:{requestId:'history-auth-retry'}});
  await taskHistory.waitForIdle();
  assert.equal(taskHistory.get(retry.id).status,'succeeded');
  assert.deepEqual(emails,['good@example.test','bad@example.test','bad@example.test']);assert.equal(vault.list().count,0);
});

test('failed enrollment preserves encrypted credentials for an explicit retry',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'c2a-history-enroll-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const vault=new CredentialVault({root,secret:SECRET});
  const {handler,taskHistory}=historyFixture(t,{vault,authenticator:async({accounts})=>({results:accounts.map(account=>({...account,ok:true,access_token:'private-token'}))}),fetcher:async()=>Response.json({added:0,errors:['private-token was rejected']})});
  const {task}=await submitHistory(handler,'authorize',{text:'fail@example.test----private-password----ABCDEFGHIJKLMNOP'},'history-enroll-failure');
  await taskHistory.waitForIdle();
  assert.equal(taskHistory.get(task.id).status,'failed');assert.equal(vault.list().count,1);
  assert.doesNotMatch(JSON.stringify(taskHistory.get(task.id)),/private-token|private-password/);
});

test('quota history follows backend progress and records partial query failures',async t=>{
  const progressId='12345678-1234-1234-1234-123456789abc';let reads=0,submissions=0;
  const {handler,taskHistory}=historyFixture(t,{fetcher:async(url,options)=>{
    const route=new URL(url).pathname;
    if(route==='/api/accounts')return Response.json({items:[{access_token:TOKEN},{access_token:'another-token'}]});
    if(route==='/api/accounts/refresh'){submissions++;return Response.json({progress_id:progressId});}
    assert.equal(route,'/api/accounts/refresh/progress/'+progressId);reads++;
    return Response.json(reads===1?{done:false,total:2,processed:1}:{done:true,total:2,processed:2,result:{errors:['a private-token error'],refreshed:1}});
  }});
  const {task}=await submitHistory(handler,'quota',{},'history-quota-first');await taskHistory.waitForIdle();
  const completed=taskHistory.get(task.id);
  assert.equal(submissions,1);assert.equal(reads,2);assert.equal(completed.status,'partial');
  assert.equal(completed.progress.progressId,progressId);assert.equal(completed.result.processed,2);assert.equal(completed.result.errorCount,1);
  assert.doesNotMatch(JSON.stringify(completed),/private-token|upstream_access_token/);
});

test('quota submissions with untrackable progress become interrupted without automatic resubmission',async t=>{
  let submissions=0;
  const {handler,taskHistory}=historyFixture(t,{fetcher:async(url)=>{
    if(new URL(url).pathname==='/api/accounts')return Response.json({items:[{access_token:TOKEN}]});
    submissions++;return Response.json({});
  }});
  const {task}=await submitHistory(handler,'quota',{},'history-quota-unknown');await taskHistory.waitForIdle();
  assert.equal(taskHistory.get(task.id).status,'interrupted');assert.equal(submissions,1);
});

test('history routes filter and paginate summaries, reject invalid input, and never forward arbitrary file paths',async t=>{
  const {handler,taskHistory}=historyFixture(t,{fetcher:async()=>Response.json({data:[{b64_json:TASK_PNG.toString('base64')}]})});
  const {task}=await submitHistory(handler,'image',{prompt:'a'},'history-list-image');await taskHistory.waitForIdle();
  const list=await handler.execute({path:'/local/tasks?type=image&status=succeeded&page=1&pageSize=1'});
  assert.equal(list.total,1);assert.equal(list.items[0].id,task.id);assert.equal(list.items[0].params,undefined);
  await assert.rejects(()=>handler.execute({path:'/local/tasks?pageSize=101'}),error=>error.status===400);
  await assert.rejects(()=>handler.execute({path:'/local/tasks?status=not-a-state'}),error=>error.status===400);
  for(const pathname of ['/local/task-files/../../etc/passwd','/local/task-files/not-a-uuid','/local/tasks/../../other']){
    await assert.rejects(()=>handler.execute({path:pathname}),error=>error.status===404);
  }
  await assert.rejects(()=>handler.execute({path:'/local/tasks/'+task.id+'/retry',method:'POST',body:{requestId:'cannot-retry-success'}}),error=>error.status===409);
  await assert.rejects(()=>submitHistory(handler,'shell',{command:'bad'},'unknown-task-type'),error=>error.status===400);
  await assert.rejects(()=>submitHistory(handler,'image',{prompt:'x',images:{}},'bad-reference-list'),error=>error.status===400);
  await assert.rejects(()=>submitHistory(handler,'quota',{ref:42},'bad-quota-reference'),error=>error.status===400);
  assert.equal(taskHistory.list().total,1);
});

test('API history uses existing management routes and refuses to replay incomplete request summaries',async t=>{
  const {handler,taskHistory}=historyFixture(t,{fetcher:async()=>assert.fail('API history must not replay requests')});
  const stamp=new Date().toISOString(),id=crypto.randomUUID();
  const task={id,type:'api_request',summary:'POST /v1/responses',status:'failed',params:{method:'POST',path:'/v1/responses',model:'test-model',stream:false,prompt:'你好'},progress:{},result:{httpStatus:429},files:[],createdAt:stamp,startedAt:stamp,finishedAt:stamp,error:'API 请求失败（HTTP 429）',parentTaskId:null};
  fs.mkdirSync(taskHistory.apiHistoryDir,{recursive:true});fs.writeFileSync(path.join(taskHistory.apiHistoryDir,id+'.json'),JSON.stringify(task));
  const list=await handler.execute({path:'/local/tasks?type=api_request'});
  assert.equal(list.total,1);assert.equal(list.items[0].result.httpStatus,429);
  assert.deepEqual((await handler.execute({path:'/local/tasks/'+id})).task,task);
  await assert.rejects(()=>handler.execute({path:'/local/tasks/'+id+'/retry',method:'POST'}),error=>error.status===409&&/原客户端/.test(error.message));
  assert.deepEqual(await handler.execute({path:'/local/tasks/'+id,method:'DELETE'}),{ok:true});
  assert.equal(taskHistory.list().total,0);
});
