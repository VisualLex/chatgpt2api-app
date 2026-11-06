/** Optional standalone smoke test. No account data, key, or tokens are printed. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createProvider} from '../lib/provider.js';
import {managedPaths,DEFAULT_PORT,validatePort} from '../lib/platform-backend.js';
const p=managedPaths({root:process.env.CHATGPT2API_HOME||process.env.DSH_CHATGPT2API_HOME||path.join(os.homedir(),'.chatgpt2api')});
const key=process.env.CHATGPT2API_KEY || process.env.DSH_CHATGPT2API_KEY || (fs.existsSync(p.key)?fs.readFileSync(p.key,'utf8').trim():'');
const port=validatePort(process.env.CHATGPT2API_PORT||process.env.DSH_CHATGPT2API_PORT||DEFAULT_PORT);
const api=createProvider({baseUrl:process.env.CHATGPT2API_URL||process.env.DSH_CHATGPT2API_URL||`http://127.0.0.1:${port}`,apiKey:key,timeoutMs:12000});
try{
  const status=await api.health();
  console.log(`后端连通：${api.baseUrl}; version=${status.version||'未知'}; healthy=${status.healthy}; 账号=${status.accounts.total}; 可用=${status.accounts.active}`);
  try{console.log('可用模型：',(await api.models()).join(', ')||'(空)')}
  catch(e){console.error('模型认证失败：',e.message);process.exitCode=2}
}catch(e){console.error('后端未连接：',e.message);process.exitCode=1}
