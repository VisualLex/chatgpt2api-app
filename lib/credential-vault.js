/**
 * Local encrypted staging vault for owner-supplied email----password----auxiliary records.
 * This does NOT create upstream access tokens or automatically authenticate accounts.
 * All operations are available only through DSH's authenticated Host manage route.
 * No cleartext password / auxiliary field is ever returned to the browser.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_LINES = 1000;
const MAX_STAGED = 5000;
const FORMAT_VERSION = 1;

function safeError(code, line) { return {line, reason: code}; }
function validateLine(value, lineNo) {
  // Support standard multi-dash separators: 4 dashes (----), 3 dashes (---), or 3+ dashes.
  // Supports 3-field (email, password, 2fa), 4-field (+ token), and 5-field (+ refresh token).
  let segments = value.split('----');
  if (segments.length < 3) {
    const s3 = value.split('---');
    if (s3.length >= 3) {
      segments = s3;
    } else {
      const re = value.split(/-{3,}/);
      if (re.length >= 3) segments = re;
    }
  }
  if (segments.length < 3) return {error: safeError('应为邮箱----密码----第三字段（恰好三个字段）', lineNo)};
  const emailRaw = segments[0];
  const passwordRaw = segments[1];
  const auxRaw = segments[2];
  const tokenRaw = segments[3] ? segments[3].trim() : '';
  const refreshRaw = segments[4] ? segments[4].trim() : '';

  const email = emailRaw.trim().toLowerCase();
  const password = passwordRaw; const auxiliary = auxRaw.trim();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return {error:safeError('邮箱格式不正确',lineNo)};
  if (password.length < 1 || password.length > 512 || /[\r\n\0]/.test(password)) return {error:safeError('密码为空或长度超限',lineNo)};
  if (auxiliary.length < 1 || auxiliary.length > 512 || /[\r\n\0]/.test(auxiliary)) return {error:safeError('第三字段为空或长度超限',lineNo)};
  if (tokenRaw && (tokenRaw.length > 8192 || /[\r\n\0]/.test(tokenRaw))) return {error:safeError('Token 格式不正确或长度超限',lineNo)};
  if (refreshRaw && (refreshRaw.length > 8192 || /[\r\n\0]/.test(refreshRaw))) return {error:safeError('RefreshToken 格式不正确或长度超限',lineNo)};

  const account = {email, password, auxiliary};
  if (tokenRaw) {
    if (/^https?:\/\//i.test(tokenRaw)) {
      account.mailUrl = tokenRaw;
    } else {
      account.accessToken = tokenRaw;
    }
  }
  if (refreshRaw) {
    if (/^https?:\/\//i.test(refreshRaw)) {
      account.mailUrl = refreshRaw;
    } else {
      account.refreshToken = refreshRaw;
    }
  }
  return {account};
}

export function parseCredentialLines(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) throw Error('文本超过 1MB 限制');
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines.length > MAX_LINES + 1) throw Error('单次最多 1000 行');
  const accounts = [], errors = [], seen = new Set(); let duplicates = 0;
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    const {account,error} = validateLine(line, index + 1);
    if (error) { errors.push(error); return; }
    if (seen.has(account.email)) {duplicates++;return;}
    seen.add(account.email); accounts.push(account);
  });
  return {accounts, errors, duplicates};
}

export class CredentialVault {
  constructor({root, secret} = {}) {
    if (!root || typeof root !== 'string') throw Error('缺少凭据暂存目录');
    if (typeof secret !== 'string' || secret.length < 12) throw Error('缺少 Host 私有密钥');
    this.root = path.resolve(root);
    this.file = path.join(this.root, 'pending-credentials.enc.json');
    this.secret = secret;
  }
  _key(salt) { return crypto.scryptSync(this.secret, salt, 32, {N:16384, r:8, p:1}); }
  _load() {
    if (!fs.existsSync(this.file)) return [];
    let obj;
    try { obj = JSON.parse(fs.readFileSync(this.file,'utf8')); } catch {throw Error('加密暂存文件无法读取，请检查文件完整性');}
    if (obj?.version !== FORMAT_VERSION || !obj.salt || !obj.iv || !obj.tag || !obj.ciphertext) throw Error('暂存文件结构无效');
    try {
      const decipher=crypto.createDecipheriv('aes-256-gcm', this._key(Buffer.from(obj.salt,'base64')), Buffer.from(obj.iv,'base64'));
      decipher.setAuthTag(Buffer.from(obj.tag,'base64'));
      const decrypted = Buffer.concat([decipher.update(Buffer.from(obj.ciphertext,'base64')), decipher.final()]);
      const records=JSON.parse(decrypted.toString('utf8'));
      if(!Array.isArray(records) || records.length > MAX_STAGED) throw Error('暂存文件大小不合法');
      return records;
    } catch {throw Error('暂存文件验证失败（可能已损坏或内部密钥已更改）');}
  }
  _save(records) {
    fs.mkdirSync(this.root,{recursive:true,mode:0o700});
    const salt=crypto.randomBytes(16), iv=crypto.randomBytes(12), cipher=crypto.createCipheriv('aes-256-gcm',this._key(salt),iv);
    const blob=Buffer.from(JSON.stringify(records),'utf8');
    const encrypted=Buffer.concat([cipher.update(blob),cipher.final()]);
    const document={version:FORMAT_VERSION,salt:salt.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:encrypted.toString('base64')};
    const tmp=this.file+'.'+crypto.randomBytes(6).toString('hex')+'.tmp';
    try {fs.writeFileSync(tmp,JSON.stringify(document),{mode:0o600,flag:'wx'});fs.renameSync(tmp,this.file);} finally {try{fs.rmSync(tmp,{force:true})}catch{}}
  }
  list() {
    const records=this._load();
    return {count:records.length,items:records.map(({id,email,createdAt,state='pending_auth',lastError})=>({id,email,createdAt,state,lastError:lastError?String(lastError).slice(0,100):undefined}))};
  }
  get(id) {
    if(typeof id!=='string'||!/^[0-9a-f-]{36}$/i.test(id))return null;
    return this._load().find(x=>x.id===id)||null;
  }
  getAll() {
    return this._load();
  }
  updateStatus(id,{state='pending_auth',lastError=''}={}) {
    if(typeof id!=='string'||!/^[0-9a-f-]{36}$/i.test(id))return false;
    const records=this._load();
    const item=records.find(x=>x.id===id);
    if(!item)return false;
    item.state=state;
    if(lastError)item.lastError=String(lastError).slice(0,200);else delete item.lastError;
    this._save(records);
    return true;
  }
  importText(text, {existingEmails = null} = {}) {
    const parsed=parseCredentialLines(text);
    const records=this._load();
    const seen=new Set(records.map(x=>String(x.email).toLowerCase()));
    if(existingEmails){
      for(const em of existingEmails){
        if(em)seen.add(String(em).toLowerCase());
      }
    }
    let added=0,skipped=parsed.duplicates;
    for (const a of parsed.accounts) {
      if (seen.has(a.email)) {skipped++;continue;}
      if(records.length>=MAX_STAGED) throw Error('已达到 5000 条暂存账号上限');
      records.push({id:crypto.randomUUID(),...a,createdAt:new Date().toISOString()});seen.add(a.email);added++;
    }
    if(added)this._save(records);
    return {added,skipped,invalid:parsed.errors.length,errors:parsed.errors.slice(0,100),count:records.length};
  }
  delete(id) {
    if(typeof id!=='string'||!/^[0-9a-f-]{36}$/i.test(id)) throw Error('暂存账号 ID 无效');
    const old=this._load(),kept=old.filter(x=>x.id!==id);
    if(kept.length===old.length) return {removed:0,count:old.length};
    this._save(kept);return {removed:1,count:kept.length};
  }
}
