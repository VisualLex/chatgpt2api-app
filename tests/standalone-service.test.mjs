import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ChatGPT2APIService} from '../lib/index.js';
import {PlatformBackend} from '../lib/platform-backend.js';

const NEW_KEY='standalone-machine-secret-12345';
const LEGACY_KEY='legacy-dsh-machine-secret-12345';
const CUSTOM_KEY='custom-environment-machine-secret-12345';

function environment(t,values={}) {
  const names=['CHATGPT2API_KEY','DSH_CHATGPT2API_KEY','CHATGPT2API_PORT','DSH_CHATGPT2API_PORT','CHATGPT2API_URL','DSH_CHATGPT2API_URL','TEST_CUSTOM_C2A_KEY'];
  const before=Object.fromEntries(names.map(name=>[name,process.env[name]]));
  for(const name of names) {
    if(values[name]===undefined) delete process.env[name];
    else process.env[name]=values[name];
  }
  t.after(()=>{for(const name of names){if(before[name]===undefined)delete process.env[name];else process.env[name]=before[name];}});
}
function temporary(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'c2a-service-keys-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return root;
}
function context() {
  const effects=[];
  return {effects,reflect:{provide(){}},effect:setup=>effects.push(setup)};
}
async function verifyServiceKey(t, values, configuration, expected) {
  environment(t,values);
  const headers=[];
  t.mock.method(globalThis,'fetch',async (_url,options)=>{
    headers.push(options.headers.Authorization);
    return Response.json({data:[{id:'test-model'}]});
  });
  const ctx=context();
  const service=new ChatGPT2APIService(ctx,{dataDir:temporary(t),...configuration});
  assert.equal(ctx.effects.length,1);
  assert.equal(service.manager.phase,'idle','DSH effects are registered without starting the backend');
  assert.equal(service.manager.child,null);
  assert.equal(service._adminKey,expected);
  // Adoption checks use the same selected key while avoiding any actual child
  // process, source download or Python provisioning in these unit tests.
  service.manager._probeExisting=async()=>({auth:true,health:{status:'ok'}});
  await service.manager.start();
  assert.equal(service.manager.key,service._adminKey);
  assert.equal(service.manager.child,null);
  assert.deepEqual(await service.models(),['test-model']);
  assert.deepEqual(headers,['Bearer '+expected]);
  await service.manager.stop();
  return service;
}

test('DSH service and managed backend choose the new key consistently when both aliases exist',async t=>{
  const service=await verifyServiceKey(t,{
    CHATGPT2API_KEY:NEW_KEY,DSH_CHATGPT2API_KEY:LEGACY_KEY,
    CHATGPT2API_PORT:'39710',DSH_CHATGPT2API_PORT:'39711',
  },{},NEW_KEY);
  assert.equal(service.manager.port,39710);
  assert.equal(service.baseUrl,'http://127.0.0.1:39710');
});

test('custom apiKeyEnv overrides both generic aliases for service and managed backend',async t=>{
  await verifyServiceKey(t,{
    CHATGPT2API_KEY:NEW_KEY,DSH_CHATGPT2API_KEY:LEGACY_KEY,TEST_CUSTOM_C2A_KEY:CUSTOM_KEY,
  },{apiKeyEnv:'TEST_CUSTOM_C2A_KEY'},CUSTOM_KEY);
});

test('legacy key and port continue to configure DSH when new aliases are absent',async t=>{
  const service=await verifyServiceKey(t,{DSH_CHATGPT2API_KEY:LEGACY_KEY,DSH_CHATGPT2API_PORT:'39712'}, {},LEGACY_KEY);
  assert.equal(service.manager.port,39712);
});

test('an unset custom key environment uses the persisted machine key instead of unrelated aliases',async t=>{
  environment(t,{CHATGPT2API_KEY:NEW_KEY,DSH_CHATGPT2API_KEY:LEGACY_KEY});
  const root=temporary(t);
  fs.writeFileSync(path.join(root,'admin-key'),CUSTOM_KEY+'\n');
  const ctx=context();
  const service=new ChatGPT2APIService(ctx,{dataDir:root,apiKeyEnv:'TEST_CUSTOM_C2A_KEY'});
  assert.equal(service._adminKey,CUSTOM_KEY);
  assert.equal(service.manager.phase,'idle');
  service.manager._probeExisting=async()=>({auth:true});
  await service.manager.start();
  assert.equal(service.manager.key,CUSTOM_KEY);
  await service.manager.stop();
});

test('explicit PlatformBackend apiKey takes priority over both environment aliases',async t=>{
  environment(t,{CHATGPT2API_KEY:NEW_KEY,DSH_CHATGPT2API_KEY:LEGACY_KEY});
  const manager=new PlatformBackend({dataDir:temporary(t),apiKey:CUSTOM_KEY});
  manager._probeExisting=async()=>({auth:true});
  await manager.start();
  assert.equal(manager.key,CUSTOM_KEY);
  await manager.stop();
});

test('external URL aliases keep new-name priority and skip DSH backend lifecycle setup',t=>{
  environment(t,{
    CHATGPT2API_URL:'http://127.0.0.1:39713',DSH_CHATGPT2API_URL:'http://127.0.0.1:39714',
    CHATGPT2API_KEY:NEW_KEY,DSH_CHATGPT2API_KEY:LEGACY_KEY,
  });
  const ctx=context();
  const service=new ChatGPT2APIService(ctx,{externalBaseUrl:'http://127.0.0.1:39715'});
  assert.equal(service.baseUrl,'http://127.0.0.1:39713');
  assert.equal(service._adminKey,NEW_KEY);
  assert.equal(service.manager,null);
  assert.equal(ctx.effects.length,0);
});
