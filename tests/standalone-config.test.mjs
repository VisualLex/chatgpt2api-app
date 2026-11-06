import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {spawnSync} from 'node:child_process';
import {PlatformBackend,managedPaths} from '../lib/platform-backend.js';

function envFor(t,values){
  const names=['CHATGPT2API_DOWNLOAD_PROXY','HTTPS_PROXY','https_proxy','HTTP_PROXY','http_proxy','CHATGPT2API_HOME','DSH_CHATGPT2API_HOME','CHATGPT2API_PORT','DSH_CHATGPT2API_PORT','CHATGPT2API_PYTHON','DSH_CHATGPT2API_PYTHON','CHATGPT2API_SYSTEM_SITE_PACKAGES','DSH_CHATGPT2API_SYSTEM_SITE_PACKAGES','CHATGPT2API_KEY','DSH_CHATGPT2API_KEY'];
  const before=Object.fromEntries(names.map(name=>[name,process.env[name]]));
  for(const name of names){delete process.env[name];if(values[name]!==undefined)process.env[name]=values[name]}
  t.after(()=>{for(const name of names){if(before[name]===undefined)delete process.env[name];else process.env[name]=before[name]}});
}
function temporary(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'c2a-standalone-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root}

test('new runtime environment names override legacy DSH aliases',async t=>{
  const root=temporary(t);
  envFor(t,{
    CHATGPT2API_HOME:root,DSH_CHATGPT2API_HOME:path.join(root,'legacy'),
    CHATGPT2API_PORT:'39812',DSH_CHATGPT2API_PORT:'39813',
    CHATGPT2API_PYTHON:'/configured/new/python',DSH_CHATGPT2API_PYTHON:'/configured/legacy/python',
    CHATGPT2API_SYSTEM_SITE_PACKAGES:'0',DSH_CHATGPT2API_SYSTEM_SITE_PACKAGES:'1',
    CHATGPT2API_KEY:'new-machine-secret-12345',DSH_CHATGPT2API_KEY:'legacy-machine-secret-12345'
  });
  const headers=[];
  const manager=new PlatformBackend({}, {fetcher:async(url,options)=>{
    if(new URL(url).pathname==='/health')return {ok:true,json:async()=>({status:'ok'})};
    headers.push(options.headers.Authorization);
    return {ok:true};
  }});
  assert.equal(manager.paths.root,root);
  assert.equal(manager.port,39812);
  assert.equal(manager.configPython,'/configured/new/python');
  assert.equal(manager.inheritSystemPackages,false);
  const status=await manager.start();
  assert.equal(status.adopted,true);
  assert.deepEqual(headers,['Bearer new-machine-secret-12345']);
  await manager.stop();
});

test('legacy aliases and original DSH default directory remain supported',t=>{
  const root=temporary(t);
  envFor(t,{DSH_CHATGPT2API_HOME:root,DSH_CHATGPT2API_PORT:'39814',DSH_CHATGPT2API_PYTHON:'/legacy/python',DSH_CHATGPT2API_SYSTEM_SITE_PACKAGES:'1'});
  const manager=new PlatformBackend({autoStart:false});
  assert.equal(manager.paths.root,root);
  assert.equal(manager.port,39814);
  assert.equal(manager.configPython,'/legacy/python');
  assert.equal(manager.inheritSystemPackages,true);
  delete process.env.DSH_CHATGPT2API_HOME;
  assert.equal(managedPaths().root,path.join(os.homedir(),'.dsh','chatgpt2api-native'));
});

test('maintenance CLI uses standalone directory and explicit data-dir overrides it',t=>{
  const root=temporary(t);
  const env={...process.env};
  delete env.CHATGPT2API_HOME;delete env.DSH_CHATGPT2API_HOME;
  const standalone=spawnSync(process.execPath,['scripts/manage-backend.mjs','log'],{encoding:'utf8',env});
  assert.equal(standalone.status,0);
  assert.ok(standalone.stdout.includes(path.join(os.homedir(),'.chatgpt2api','backend.log')));
  const custom=spawnSync(process.execPath,['scripts/manage-backend.mjs','log','--data-dir',root],{encoding:'utf8',env});
  assert.equal(custom.status,0);
  assert.ok(custom.stdout.includes(path.join(root,'backend.log')));
  const bad=spawnSync(process.execPath,['scripts/manage-backend.mjs','check','--port','80'],{encoding:'utf8',env});
  assert.equal(bad.status,2);
});

test('stopping owned backend waits for close and repeated stop shares cleanup',async t=>{
  const root=temporary(t);
  const signals=[];
  const child=new EventEmitter();child.pid=123456;child.exitCode=null;
  const manager=new PlatformBackend({dataDir:root},{platform:'linux',arch:'x64',groupKiller:(pid,signal)=>{
    signals.push([pid,signal]);
    setTimeout(()=>{child.exitCode=0;child.emit('close',0)},20);
  }});
  manager.child=child;
  let complete=false;
  const stopped=manager.stop().then(()=>{complete=true});
  await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(complete,false);
  await Promise.all([stopped,manager.stop()]);
  assert.deepEqual(signals,[[123456,'SIGTERM']]);
  assert.equal(manager.child,null);
  assert.equal(manager.phase,'stopped');
});

test('stopping an adopted backend never signals a process',async t=>{
  const manager=new PlatformBackend({dataDir:temporary(t)},{groupKiller:()=>assert.fail('must not signal adopted process')});
  manager.adopted=true;
  await manager.stop();
  assert.equal(manager.phase,'stopped');
  assert.match(manager.message,/未终止/);
});


test('stopping during provisioning terminates only tracked commands and prevents more spawns',async t=>{
  const manager=new PlatformBackend({dataDir:temporary(t)});
  const command=manager.executor(process.execPath,['-e','setInterval(()=>{},1000)']).catch(error=>error);
  assert.equal(manager.commands.size,1);
  const child=[...manager.commands][0];
  await manager.stop();
  const result=await command;
  assert.ok(result instanceof Error);
  assert.ok(child.exitCode!==null||child.signalCode!==null);
  assert.equal(manager.commands.size,0);
  await assert.rejects(()=>manager.executor(process.execPath,['-e','process.exit(0)']),/取消启动/);
});


test('explicit download proxy also configures Python downloads without replacing existing proxy settings',t=>{
  envFor(t,{CHATGPT2API_DOWNLOAD_PROXY:'http://127.0.0.1:7897',HTTPS_PROXY:'http://127.0.0.1:7898'});
  const manager=new PlatformBackend({dataDir:temporary(t)});
  assert.equal(manager.uvEnv.HTTPS_PROXY,'http://127.0.0.1:7898');
  assert.equal(manager.uvEnv.HTTP_PROXY,'http://127.0.0.1:7897');
});

test('a successful retry clears the previous startup error',async t=>{
  const manager=new PlatformBackend({dataDir:temporary(t)});
  let attempt=0;
  manager._start=async()=>{if(++attempt===1)throw Error('temporary download failure');manager.phase='ready';return manager.status()};
  await assert.rejects(manager.start(),/temporary download failure/);
  assert.equal(manager.phase,'error');
  assert.equal(manager.error,'temporary download failure');
  const status=await manager.start();
  assert.equal(status.phase,'ready');
  assert.equal(status.error,'');
});
