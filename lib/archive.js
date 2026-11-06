/** Portable, dependency-free extraction of the pinned ZIP source and uv tool.
 * Archive limits, path containment and symlink checks reduce archive traversal
 * and decompression-bomb risk. SHA-256 is verified on each uv release BEFORE use.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const MAX_TOTAL_BYTES = 500 * 1024 * 1024;
const MAX_FILE_BYTES = 160 * 1024 * 1024;
const MAX_ENTRIES = 20000;

function safePath(root, name) {
  if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name))
    throw Error('归档包含不安全路径');
  const components = name.replace(/\/$/, '').split('/');
  if (components.some(x => x === '..' || x === '.' || !x)) throw Error('归档路径不能包含相对跳转');
  const dest = path.resolve(root, components.join(path.sep));
  if (!dest.startsWith(path.resolve(root) + path.sep)) throw Error('归档文件超出解压目录');
  return dest;
}

export function extractZipSafe(archivePath, destination) {
  const data = fs.readFileSync(archivePath);
  if (data.length > 60 * 1024 * 1024) throw Error('ZIP 文件过大');
  // ZIP end of central directory may contain up to 64KiB of archive comments.
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 65535); i--) {
    if (data.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw Error('不是有效的 ZIP 文件');
  const count = data.readUInt16LE(eocd + 10);
  let pos = data.readUInt32LE(eocd + 16);
  if (count > MAX_ENTRIES || pos >= data.length) throw Error('ZIP 目录非法');
  const seen = new Set();
  let total = 0;
  fs.mkdirSync(destination, {recursive:true});
  for (let i=0; i<count; i++) {
    if (pos + 46 > data.length || data.readUInt32LE(pos) !== 0x02014b50) throw Error('ZIP 目录损坏');
    const flags = data.readUInt16LE(pos+8);
    const method = data.readUInt16LE(pos+10);
    const compSize = data.readUInt32LE(pos+20);
    const plainSize = data.readUInt32LE(pos+24);
    const nameLen = data.readUInt16LE(pos+28);
    const extraLen = data.readUInt16LE(pos+30);
    const commentLen = data.readUInt16LE(pos+32);
    const externalAttrs = data.readUInt32LE(pos+38);
    const localOffset = data.readUInt32LE(pos+42);
    if (flags & 1) throw Error('不支持加密 ZIP');
    if (method !== 0 && method !== 8) throw Error('不支持的 ZIP 压缩算法');
    if (compSize === 0xffffffff || plainSize === 0xffffffff || localOffset === 0xffffffff) throw Error('不支持 ZIP64');
    if (nameLen > 1024 || pos+46+nameLen+extraLen+commentLen>data.length) throw Error('ZIP 文件名损坏');
    const filename = data.subarray(pos+46,pos+46+nameLen).toString('utf8');
    pos += 46+nameLen+extraLen+commentLen;
    const target = safePath(destination, filename);
    if (seen.has(target)) throw Error('ZIP 含重复文件名');
    seen.add(target);
    const type = (externalAttrs >>> 16) & 0o170000;
    if (type === 0o120000) throw Error('ZIP 不允许符号链接');
    if (filename.endsWith('/')) {fs.mkdirSync(target,{recursive:true});continue;}
    if (plainSize > MAX_FILE_BYTES || (total += plainSize) > MAX_TOTAL_BYTES) throw Error('ZIP 解压量超过限制');
    if (localOffset + 30 > data.length || data.readUInt32LE(localOffset) !== 0x04034b50) throw Error('ZIP 本地文件头损坏');
    const start = localOffset + 30 + data.readUInt16LE(localOffset+26) + data.readUInt16LE(localOffset+28);
    if (start + compSize > data.length) throw Error('ZIP 压缩数据损坏');
    const bytes = data.subarray(start,start+compSize);
    const plain = method === 8 ? zlib.inflateRawSync(bytes,{maxOutputLength:MAX_FILE_BYTES}) : bytes;
    if (plain.length !== plainSize) throw Error('ZIP 解压长度不一致');
    fs.mkdirSync(path.dirname(target),{recursive:true});
    fs.writeFileSync(target,plain,{flag:'wx',mode:0o600});
  }
}

export function extractUvTarGz(archivePath, outputPath) {
  const zipped=fs.readFileSync(archivePath);
  if (zipped.length > 50 * 1024 * 1024) throw Error('uv tar.gz 文件过大');
  const tar=zlib.gunzipSync(zipped,{maxOutputLength:180 * 1024 * 1024});
  let off=0;
  while (off+512<=tar.length) {
    const block=tar.subarray(off,off+512);
    if (block.every(x=>x===0)) break;
    const name=block.subarray(0,100).toString('utf8').replace(/\0.*$/,'');
    const lenStr=block.subarray(124,136).toString('ascii').replace(/\0.*$/,'').trim();
    const size=parseInt(lenStr,8);
    const flag=String.fromCharCode(block[156]);
    if (!Number.isFinite(size) || size < 0 || size > MAX_FILE_BYTES || off+512+size>tar.length) throw Error('uv tar 头损坏');
    if ((flag==='0' || flag==='\0') && name.split('/').at(-1)==='uv') {
      const executable=tar.subarray(off+512,off+512+size);
      if (executable.length < 100000) throw Error('uv 可执行文件异常');
      fs.mkdirSync(path.dirname(outputPath),{recursive:true});
      fs.writeFileSync(outputPath,executable,{flag:'wx',mode:0o700});
      return;
    }
    off += 512 + Math.ceil(size/512)*512;
  }
  throw Error('uv tar.gz 中未找到 uv 可执行文件');
}
