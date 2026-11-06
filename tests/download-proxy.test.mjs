import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {downloadAsset,downloadProxy} from '../lib/platform-backend.js';

const SOURCE='https://github.com/astral-sh/uv/releases/download/test/runtime.tar.gz';
const PROXY='http://127.0.0.1:7897';
const BYTES=Buffer.alloc(1200,42);
function target(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'c2a-download-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return path.join(root,'asset.tar.gz')}
function curlRunner(replies,calls){
  return (bin,args,options)=>{
    calls.push({bin,args,options});
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.kill=()=>{child.stdout.destroy();child.stderr.end();child.emit('close',1)};
    queueMicrotask(()=>{
      const reply=replies.shift();
      fs.writeFileSync(args[args.indexOf('--dump-header')+1],reply.headers);
      child.stdout.end(reply.body||'');child.stderr.end(reply.stderr||'');child.emit('close',reply.code||0);
    });
    return child;
  };
}

test('download proxy honors explicit setting before standard environment aliases',()=>{
  assert.equal(downloadProxy({CHATGPT2API_DOWNLOAD_PROXY:'http://specific:1234',HTTPS_PROXY:'http://standard:5678'}),'http://specific:1234');
  assert.equal(downloadProxy({https_proxy:PROXY}),PROXY);
  assert.equal(downloadProxy({HTTP_PROXY:PROXY}),PROXY);
  assert.equal(downloadProxy({CHATGPT2API_DOWNLOAD_PROXY:'',HTTPS_PROXY:PROXY}),'');
});

test('proxy download validates every redirect and checks archive checksum',async t=>{
  const file=target(t),calls=[];
  const runner=curlRunner([
    {headers:'HTTP/1.1 200 Connection established\r\n\r\nHTTP/2 302\r\nLocation: https://release-assets.githubusercontent.com/asset\r\n\r\n'},
    {headers:'HTTP/2 200\r\nContent-Length: 1200\r\n\r\n',body:BYTES}
  ],calls);
  await downloadAsset(SOURCE,file,{proxy:PROXY,runner,maxBytes:2000,sha256:crypto.createHash('sha256').update(BYTES).digest('hex')});
  assert.equal(calls.length,2);
  assert.ok(calls.every(call=>!call.args.includes('-L')&&!call.args.includes('--location')));
  assert.equal(calls[1].args.at(-1),'https://release-assets.githubusercontent.com/asset');
  assert.deepEqual(fs.readFileSync(file),BYTES);
  assert.equal(fs.existsSync(file+'.part.headers'),false);
});

test('proxy download refuses unknown or non-HTTPS redirect destinations before contacting them',async t=>{
  for(const destination of ['https://attacker.example/asset','http://github.com/asset']){
    const file=target(t),calls=[];
    const runner=curlRunner([{headers:`HTTP/2 302\r\nLocation: ${destination}\r\n\r\n`}],calls);
    await assert.rejects(downloadAsset(SOURCE,file,{proxy:PROXY,runner}),/受信任.*HTTPS/);
    assert.equal(calls.length,1);
    assert.equal(fs.existsSync(file+'.part'),false);
  }
});

test('proxy download enforces streaming size and SHA256 without retaining partial files',async t=>{
  for(const options of [{maxBytes:1000},{sha256:'0'.repeat(64)}]){
    const file=target(t),calls=[];
    const runner=curlRunner([{headers:'HTTP/2 200\r\n\r\n',body:BYTES}],calls);
    await assert.rejects(downloadAsset(SOURCE,file,{proxy:PROXY,runner,...options}),/过大|SHA256/);
    assert.equal(fs.existsSync(file),false);
    assert.equal(fs.existsSync(file+'.part'),false);
    assert.equal(fs.existsSync(file+'.part.headers'),false);
  }
});

test('invalid proxy addresses are rejected without spawning a command',async t=>{
  for(const proxy of ['ftp://127.0.0.1:1234','http://127.0.0.1:1234/private','broken']){
    await assert.rejects(downloadAsset(SOURCE,target(t),{proxy,runner:()=>assert.fail('must not spawn')}),/代理/);
  }
});
