import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {extractZipSafe,extractUvTarGz} from '../lib/archive.js';
function temp(){return fs.mkdtempSync(path.join(os.tmpdir(),'dsh-c2a-archive-'))}
function put16(buf,off,x){buf.writeUInt16LE(x,off)}
function put32(buf,off,x){buf.writeUInt32LE(x,off)}
function miniZip(entries){
  const locals=[],central=[];let offset=0;
  for(const [name,value] of entries){
    const filename=Buffer.from(name),raw=Buffer.from(value),comp=zlib.deflateRawSync(raw);
    const lh=Buffer.alloc(30);put32(lh,0,0x04034b50);put16(lh,4,20);put16(lh,8,8);put32(lh,18,comp.length);put32(lh,22,raw.length);put16(lh,26,filename.length);
    locals.push(lh,filename,comp);
    const cd=Buffer.alloc(46);put32(cd,0,0x02014b50);put16(cd,4,0x031e);put16(cd,6,20);put16(cd,10,8);put32(cd,20,comp.length);put32(cd,24,raw.length);put16(cd,28,filename.length);put32(cd,42,offset);
    central.push(cd,filename);offset+=lh.length+filename.length+comp.length;
  }
  const cdb=Buffer.concat(central),e=Buffer.alloc(22);put32(e,0,0x06054b50);put16(e,8,entries.length);put16(e,10,entries.length);put32(e,12,cdb.length);put32(e,16,offset);
  return Buffer.concat([...locals,cdb,e]);
}
function miniTar(fileName,value){
  const header=Buffer.alloc(512);header.write(fileName,0,'ascii');header.write('0000700\0',100,'ascii');header.write('0000000\0',108,'ascii');header.write('0000000\0',116,'ascii');header.write(Buffer.byteLength(value).toString(8).padStart(11,'0')+'\0',124,'ascii');header.fill(32,148,156);header.write('0',156,'ascii');header.write('ustar\0',257,'ascii');
  const bytes=Buffer.from(value);
  return zlib.gzipSync(Buffer.concat([header,bytes,Buffer.alloc((512-bytes.length%512)%512),Buffer.alloc(1024)]));
}

test('portable ZIP extractor decodes deflate files with nested paths',t=>{
  const dir=temp();t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const src=path.join(dir,'archive.zip');fs.writeFileSync(src,miniZip([['root/README.md','你好'],['root/src/code.js','const ok = 1;']]));
  extractZipSafe(src,path.join(dir,'out'));
  assert.equal(fs.readFileSync(path.join(dir,'out','root','README.md'),'utf8'),'你好');
  assert.match(fs.readFileSync(path.join(dir,'out','root','src','code.js'),'utf8'),/ok/);
});

test('ZIP path traversal is rejected',t=>{
  const dir=temp();t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const src=path.join(dir,'archive.zip');fs.writeFileSync(src,miniZip([['../../outside','not okay']]));
  assert.throws(()=>extractZipSafe(src,path.join(dir,'out')),/路径/);
  assert.equal(fs.existsSync(path.join(dir,'outside')),false);
});

test('tar.gz extracts executable uv on Unix without system tar',t=>{
  const dir=temp();t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const src=path.join(dir,'uv.tar.gz'),out=path.join(dir,'bin','uv');
  fs.writeFileSync(src,miniTar('uv-x86_64-unknown-linux-gnu/uv','x'.repeat(120000)));
  extractUvTarGz(src,out);
  assert.equal(fs.statSync(out).size,120000);
  // Windows has no executable bit on files; the mode check only means something on Unix.
  if(process.platform!=='win32')assert.ok((fs.statSync(out).mode&0o100)!==0);
});
