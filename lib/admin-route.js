/**
 * Authenticated, passwordless DSH owner UI -> local upstream bridge.
 * The route is registered via ctx.connection.fetch.register, which applies
 * DSH browser-session cookie + same-origin/Host trust checks. NEVER mount
 * it directly on the public upstream HTTP listener.
 *
 * The Python backend continues to require an internal machine-generated
 * secret. No user needs to see, copy, or enter it, and the browser never
 * receives it. Third-party /v1 clients still use independently revocable
 * user API keys.
 */
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import crypto, {createHmac} from 'node:crypto';
import {CredentialVault, parseCredentialLines} from './credential-vault.js';
import {managedPaths, resolvePlatform, detectLinuxLibc} from './platform-backend.js';
import {DEFAULT_IMAGE_PREFERENCES, validateImageTier, validateModel, resolveImageSize} from './image-options.js';
import {TaskHistory} from './task-history.js';

export const ADMIN_ROUTE='/api/chatgpt2api-native/manage';

export class UserKeyStore {
  constructor({root, filePath} = {}) {
    this.filePath = filePath || (root ? path.join(path.resolve(root), 'user-api-keys.json') : null);
    this.keys = new Map();
    if (this.filePath && fs.existsSync(this.filePath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        if (parsed && typeof parsed === 'object') {
          for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === 'string') this.keys.set(k, v);
          }
        }
      } catch {}
    }
  }
  get(id) {
    if (!id) return '';
    return this.keys.get(String(id)) || '';
  }
  set(id, key) {
    if (!id || !key) return;
    this.keys.set(String(id), String(key));
    this._save();
  }
  delete(id) {
    if (!id) return;
    if (this.keys.delete(String(id))) {
      this._save();
    }
  }
  _save() {
    if (!this.filePath) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), {recursive: true, mode: 0o700});
      const data = Object.fromEntries(this.keys.entries());
      const tmp = this.filePath + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), {mode: 0o600});
      fs.renameSync(tmp, this.filePath);
    } catch {}
  }
}

/** Persists only non-secret image choices in the DSH-owned data directory. */
export class ImagePreferencesStore {
  constructor({root, filePath} = {}) {
    this.filePath = filePath || (root ? path.join(path.resolve(root), 'image-preferences.json') : null);
  }
  get() {
    let raw = {};
    if (this.filePath) {
      try { raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')); } catch {}
    }
    try {
      return {
        defaultModel: validateModel(raw?.defaultModel || DEFAULT_IMAGE_PREFERENCES.defaultModel),
        defaultImageTier: validateImageTier(raw?.defaultImageTier || DEFAULT_IMAGE_PREFERENCES.defaultImageTier)
      };
    } catch { return {...DEFAULT_IMAGE_PREFERENCES}; }
  }
  set(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('图片偏好配置无效');
    const old = this.get();
    const next = {
      defaultModel: validateModel(input.defaultModel === undefined ? old.defaultModel : input.defaultModel),
      defaultImageTier: validateImageTier(input.defaultImageTier === undefined ? old.defaultImageTier : input.defaultImageTier)
    };
    if (!this.filePath) throw new Error('图片配置存储尚未启用');
    fs.mkdirSync(path.dirname(this.filePath), {recursive:true, mode:0o700});
    const tmp = this.filePath + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), {mode:0o600});
    fs.renameSync(tmp, this.filePath);
    return next;
  }
}
const MAX_BODY_BYTES=70*1024*1024;
const MAX_REPLY_BYTES=42*1024*1024;
const safeText=x=>typeof x==='string'?x:'';
const safeId=x=>{const value=safeText(x);if(!/^[\w-]{1,100}$/.test(value))throw new Error('无效的管理对象 ID');return value};
const asArray=x=>Array.isArray(x)?x:[];
function fail(message,status=400){const err=new Error(message);err.status=status;return err;}
function jsonResponse(value,status=200){return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}})}
const IMAGE_EXTENSIONS=new Set(['.png','.jpg','.jpeg','.webp','.gif']);
function countImages(dir){
  let count=0;
  try{
    for(const entry of fs.readdirSync(dir,{recursive:true,withFileTypes:true})){
      if(entry.isFile()&&IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))count++;
    }
  }catch{}
  return count;
}
/** Reveal one Host-owned directory in the OS file manager; never takes a path from the browser. */
export async function openLocalFolder(dir){
  // Inside the DSH desktop app the Host runs in Electron's main process:
  // shell.openPath is the supported opener and reports a real error string.
  if(process.versions.electron){
    try{
      const {shell}=await import('electron');
      if(shell&&typeof shell.openPath==='function'){
        const error=await shell.openPath(dir);
        if(!error)return;
        throw new Error(error);
      }
    }catch{}
  }
  const [command,args]=process.platform==='win32'?['explorer.exe',[dir]]
    :process.platform==='darwin'?['open',[dir]]:['xdg-open',[dir]];
  await new Promise((resolve,reject)=>{
    let child;
    try{child=spawn(command,args,{detached:true,stdio:'ignore',windowsHide:true})}catch(e){reject(e);return}
    child.once('error',reject);
    child.once('spawn',()=>{child.unref();resolve()});
  });
}
// Only a narrow, Host-authenticated proxy configuration surface is exposed to
// the panel. Never relay all of /api/settings (which may contain secrets).
function validatedProxyUrl(input){
  const raw=safeText(input).trim();
  if(!raw)return '';
  if(raw.length>255||/\s/.test(raw))throw fail('代理地址格式无效：请填写完整 URL（如 http://127.0.0.1:7897）');
  let parsed;
  try{parsed=new URL(raw)}catch{throw fail('代理地址不是有效 URL')}
  if(!['http:','https:','socks5:','socks5h:'].includes(parsed.protocol)
    ||!parsed.hostname||!parsed.port||parsed.username||parsed.password
    ||(parsed.pathname&&parsed.pathname!=='/')||parsed.search||parsed.hash){
    throw fail('代理仅支持无账号密码的 HTTP(S)/SOCKS5 URL（含端口），不能带路径或参数');
  }
  return raw;
}
function publicProxyConfig(rawValue){
  const raw=safeText(rawValue).trim();
  if(!raw)return {url:'',configured:false,hasCredentials:false};
  // Never return proxy authentication or query data configured outside this UI.
  try{
    const url=new URL(raw);
    const hasCredentials=!!(url.username||url.password);
    const valid=['http:','https:','socks5:','socks5h:'].includes(url.protocol)
      &&!!url.hostname&&!!url.port&&!url.search&&!url.hash
      &&(!url.pathname||url.pathname==='/');
    return {url:!hasCredentials&&valid?raw.slice(0,255):'',configured:true,hasCredentials};
  }catch{return {url:'',configured:true,hasCredentials:false}}
}
function cleanAccount(item,key){
  const token=safeText(item?.access_token||item?.accessToken);
  if(!token)return null;
  const ref=createHmac('sha256',key).update(token).digest('hex');
  return {
    ref,email:safeText(item.email),name:safeText(item.name),type:safeText(item.type||item.plan),
    status:safeText(item.status),quota:Number(item.quota??item.image_quota??0)||0,
    quota_check_failed:!!safeText(item.last_refresh_error),
    image_inflight:Number(item.image_inflight||0)||0
  };
}
function cleanUserKeys(value, keyStore=null){
  return asArray(value).map(x=>{
    const id=safeText(x.id);
    const plain=keyStore?.get(id)||safeText(x.key);
    return {
      id,
      name:safeText(x.name),
      enabled:x.enabled!==false,
      created_at:safeText(x.created_at),
      key:plain
    };
  });
}
function cleanPools(value,fields){return asArray(value).map(x=>Object.fromEntries(fields.map(k=>[k,safeText(x?.[k])])));}
function cleanRemoteAccounts(value){return asArray(value).map(x=>({id:String(x?.id||x?.account_id||''),account_id:String(x?.account_id||''),name:safeText(x?.name),email:safeText(x?.email)}));}
const PUBLIC_UPSTREAM_ERRORS=new Map([
  ['missing_reference_image','缺少参考图片，请上传原图后重试，或改用纯文生图提示词。'],
  ['empty_image_result','上游未返回图片，请稍后重试。'],
  ['content_policy_violation','上游以内容安全策略拒绝了本次生成，请调整提示词。'],
  ['image_generation_timeout','任务请求超时，请核对当前结果后再决定是否重试。'],
  ['request_timeout','任务请求超时，请核对当前结果后再决定是否重试。'],
  ['insufficient_quota','当前账号没有可用额度，请检查号池。'],
  ['quota_exceeded','当前账号没有可用额度，请检查号池。'],
  ['rate_limit_exceeded','上游请求被限流，请稍后重试。'],
  ['rate_limit_error','上游请求被限流，请稍后重试。'],
  ['invalid_api_key','接口认证失败，请检查 API 密钥。']
]);
function publicUpstreamError(value){
  // Keep only fixed advice. Upstream messages may contain credentials or URLs.
  for(let depth=0;depth<4&&value&&typeof value==='object';depth++){
    for(const key of ['code','type'])if(PUBLIC_UPSTREAM_ERRORS.has(value[key]))return PUBLIC_UPSTREAM_ERRORS.get(value[key]);
    const nested=value.error??value.detail;
    if(nested===undefined)break;
    value=nested;
  }
  const message=typeof value==='string'?value:typeof value?.message==='string'?value.message:'';
  if(/^(?:ChatGPT 生图超时（已等待 \d+(?:\.\d+)? 秒）|图片生成流已超过硬上限 \d+ 秒)/.test(message)
    ||/^upstream connection timed out, please retry later$/i.test(message.trim()))return PUBLIC_UPSTREAM_ERRORS.get('image_generation_timeout');
  if(/^(?:no available image quota|quota exceeded)$/i.test(message.trim()))return PUBLIC_UPSTREAM_ERRORS.get('insufficient_quota');
  return '';
}
function acceptedImagePayload(input,edit){
  if(!input||typeof input!=='object'||Array.isArray(input))throw fail('生图参数无效');
  const prompt=safeText(input.prompt).trim();if(!prompt||prompt.length>12000)throw fail('提示词长度不符合要求');
  const model=validateModel(input.model||'gpt-image-2');
  const out={model,prompt,n:1,response_format:'b64_json'};
  if(input.output_format!==undefined){
    if(edit||input.output_format!=='gif')throw fail('GIF 只支持文生图，output_format 仅允许 gif');
    const count=Number(input.frame_count??9),duration=Number(input.frame_duration_ms??200);
    if(!Number.isInteger(count)||count<2||count>16)throw fail('GIF 帧数必须在 2–16 之间');
    if(!Number.isInteger(duration)||duration<20||duration>2000||duration%10)throw fail('每帧时长须为 20–2000 毫秒且为 10 毫秒的整数倍');
    if(!['gpt-image-2.6','gpt-image-2.6-flare','gpt-image-2.6-sunburst'].includes(model))throw fail('号池 GIF 需要选择 GPT Image 2.6 模型');
    out.output_format='gif';out.frame_count=count;out.frame_duration_ms=duration;
  }
  if(input.size)out.size=resolveImageSize({size:input.size});
  if(input.quality!==undefined){
    if(!['auto','low','medium','high'].includes(input.quality))throw fail('图片质量设置不合法');
    out.quality=input.quality;
  }
  if(edit){
    const list=asArray(input.images);
    if(!list.length||list.length>4)throw fail('需上传 1–4 张参考图片');
    out.images=list.map((ref,i)=>{
      const b64=safeText(ref?.b64_json),mime=safeText(ref?.mime_type||'image/png');
      if(!/^image\/(png|jpeg|webp)$/.test(mime)||!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)||b64.length%4!==0||!b64||b64.length>16*1024*1024)throw fail(`第 ${i+1} 张参考图无效或超过12MB`);
      return {b64_json:b64,mime_type:mime,filename:`reference-${i+1}.${mime.split('/')[1]==='jpeg'?'jpg':mime.split('/')[1]}`};
    });
  }
  return out;
}
export function createAdminHandler({baseUrl,secret,fetcher=globalThis.fetch,vault=null,authenticator=null,keyStore=null,preferencesStore=null,taskHistory=null,taskPollIntervalMs=1000,gifPoolEnabled=false,imagesDir=null,openFolder=openLocalFolder}={}){
  const resolvedKeyStore=keyStore||new UserKeyStore();
  const resolvedPreferences=preferencesStore||new ImagePreferencesStore();
  const resolvedImagesDir=imagesDir?path.resolve(String(imagesDir)):null;
  const history=taskHistory||new TaskHistory();
  if(!/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d{2,5}$/.test(String(baseUrl)))throw Error('管理接口只允许回环地址的上游服务');
  if(!secret||secret.length<12)throw Error('未配置仅 Host 可访问的后端内部凭据');
  async function call(path,method='GET',body=undefined,timeoutMs=15000){
    const ac=new AbortController(),tm=setTimeout(()=>ac.abort(),timeoutMs);
    try{
      const r=await fetcher(baseUrl+path,{method,headers:{'Authorization':`Bearer ${secret}`,'Accept':'application/json',...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:ac.signal,redirect:'error'});
      if(Number(r.headers?.get?.('content-length')||0)>MAX_REPLY_BYTES)throw fail('上游响应过大',502);
      const raw=await r.text();if(Buffer.byteLength(raw)>MAX_REPLY_BYTES)throw fail('上游响应过大',502);
      let data;try{data=JSON.parse(raw)}catch{
        // Field reports of this message are undiagnosable without the upstream
        // status and body: an ASGI crash answers with plain-text "Internal Server
        // Error" while the real cause (e.g. a missing site-packages) stays in the
        // backend log. Surface a redacted snippet instead.
        const contentType=String(r.headers?.get?.('content-type')||'unknown');
        const snippet=String(raw).replace(/\s+/g,' ').trim().slice(0,140)
          .replaceAll(String(secret),'[REDACTED]')
          .replace(/\b(sk-[A-Za-z0-9_-]{6,})/g,'sk-[REDACTED]');
        throw fail(`号池后端返回了非 JSON 响应（HTTP ${r.status}，Content-Type: ${contentType}）${snippet?`：${snippet}`:''}`,502)
      }
      if(!r.ok){const message=String(data?.detail?.error||data?.detail?.message||data?.error?.message||data?.detail||data?.error||'');
        // Actionable upstream failures deserve the real reason, not only "check logs".
        const detail=message.trim();
        const reason=publicUpstreamError(data);
        const known=/^(no available image quota|rate limit|quota exceeded|invalid api key)$/i.test(detail);
        const gifMiss=/upstream did not return an animated GIF/i.test(detail);
        const publicDetail=reason?`：${reason}`:gifMiss?'：上游这次只返回了静态图，没有生成 GIF，请重试或调整提示词（详情请看 Host 日志）'
          :known?`：${detail}`:'';
        throw Object.assign(fail(`号池请求失败 HTTP ${r.status}${publicDetail}${publicDetail?'':'（详情请看 Host 日志）'}`,r.status>=400&&r.status<600?r.status:502),{publicReason:reason})}
      return data;
    }catch(e){if(ac.signal.aborted)throw fail('后端请求超时',504);throw e}finally{clearTimeout(tm)}
  }
  function accountRef(t){return createHmac('sha256',secret).update(t).digest('hex')}
  async function resolveAccountRefs(refs){
    if(refs.some(ref=>!/^[a-f0-9]{64}$/.test(safeText(ref))))throw fail('账号引用无效');
    const accounts=asArray((await call('/api/accounts')).items);
    const tokensByRef=new Map(accounts.map(account=>{
      const token=safeText(account.access_token||account.accessToken);
      return [accountRef(token),token];
    }));
    return refs.map(ref=>{
      const token=tokensByRef.get(ref);
      if(!token)throw fail('账号已改变，请刷新账号列表',404);
      return token;
    });
  }
  async function resolveAccountRef(ref){return (await resolveAccountRefs([ref]))[0]}
  const taskTypes=new Set(['image','gif','authorize','quota']);
  const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function taskError(error){
    if([...PUBLIC_UPSTREAM_ERRORS.values()].includes(error?.publicReason))return error.publicReason;
    const value=String(error?.message||error||'');
    if(/content[_ ]policy|moderation|内容安全|内容政策/i.test(value))return '上游以内容安全策略拒绝了本次生成，请调整提示词。';
    if(/timeout|超时|timed out/i.test(value))return '任务请求超时，请核对当前结果后再决定是否重试。';
    if(/no available image quota|quota exceeded|额度不足/i.test(value))return '当前账号没有可用额度，请检查号池。';
    if(/totp|2fa|二次验证/i.test(value))return '二次验证失败，请检查密钥与本机时间。';
    if(/password|credential|登录|认证/i.test(value))return '账号登录失败，请检查凭据及账号权限。';
    if(/proxy|network|fetch failed|代理|网络/i.test(value))return '网络或代理请求失败，请检查代理连接。';
    const http=value.match(/\bHTTP (\d{3})\b/);
    if(http)return `任务请求失败（HTTP ${http[1]}），请检查运行日志。`;
    return '任务执行失败，请检查运行日志或重试。';
  }
  function publicTask(task){
    if(!task)throw fail('未找到指定任务',404);
    const keys=['id','type','summary','status','params','progress','result','files','createdAt','startedAt','finishedAt','error','parentTaskId'];
    return Object.fromEntries(keys.filter(key=>task[key]!==undefined).map(key=>[key,task[key]]));
  }
  function canonical(value){
    if(Array.isArray(value))return value.map(canonical);
    if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
    return value;
  }
  function imageMime(data){
    if(data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
    if(data[0]===255&&data[1]===216&&data[2]===255)return 'image/jpeg';
    if(/^GIF8[79]a$/.test(data.subarray(0,6).toString('ascii')))return 'image/gif';
    if(data.subarray(0,4).toString('ascii')==='RIFF'&&data.subarray(8,12).toString('ascii')==='WEBP')return 'image/webp';
    throw fail('上游未返回可保存的图片',502);
  }
  async function runImageTask({task}){
    try{
      // Rehydrate only when the queued job starts; queued runners retain IDs,
      // rather than one base64 copy of every potentially large reference image.
      const input={...task.params};
      const references=asArray(input.referenceFiles);delete input.referenceFiles;delete input.referenceCount;
      if(references.length)input.images=references.map(reference=>{const file=history.file(reference.id);return {b64_json:file.data.toString('base64'),mime_type:file.mimeType}});
      const result=await execute({path:input.images?.length?'/v1/images/edits':'/v1/images/generations',method:'POST',body:input});
      const b64=safeText(result?.data?.[0]?.b64_json);
      if(!b64||!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)||b64.length%4)throw fail('上游未返回可保存的图片',502);
      const data=Buffer.from(b64,'base64'),mimeType=imageMime(data);
      if(task.type==='gif'&&mimeType!=='image/gif')return {status:'failed',error:'上游这次未返回 GIF 动画，请检查模型能力或调整提示词。'};
      const file=history.addFile(task.id,{data,mimeType,role:'result'});
      return {status:'succeeded',result:{files:[file],format:mimeType.split('/')[1],count:1,...(task.type==='gif'?{frame_count:result.frame_count||input.frame_count,frame_duration_ms:result.frame_duration_ms||input.frame_duration_ms}:{})}};
    }catch(error){return {status:'failed',error:taskError(error)}}
  }
  async function runAuthorizeTask({task,updateProgress}){
    const params=task.params;
    const result={total:params.ids.length,processed:0,succeeded:0,failed:0,duplicates:params.duplicates||0,invalid:params.invalid||0,errors:asArray(params.errors),enrolled:{added:0,skipped:0,refreshed:0,errorCount:0},failures:[]};
    for(const id of params.ids){
      let record;
      try{
        record=vault.get(id);
        if(!record)throw Error('暂存账号已移除');
        const target={id:record.id,email:record.email,password:record.password,totp_secret:record.auxiliary,access_token:record.accessToken||'',refresh_token:record.refreshToken||''};
        const response=await authenticator({accounts:[target],proxy:''});
        const item=asArray(response?.results).find(item=>item?.id===id||safeText(item?.email).toLowerCase()===record.email.toLowerCase());
        if(!item?.ok||!safeText(item.access_token))throw Error(safeText(item?.error)||'账号认证失败');
        const account={email:record.email,password:record.password,totp_secret:record.auxiliary,access_token:item.access_token,refresh_token:safeText(item.refresh_token)||target.refresh_token,id_token:safeText(item.id_token),source_type:'oauth_password_2fa',type:'oauth'};
        const enrolled=await call('/api/accounts','POST',{accounts:[account],tokens:[account.access_token]},180000);
        if(asArray(enrolled.errors).length){result.enrolled.errorCount+=enrolled.errors.length;throw Error('账号入池失败');}
        for(const key of ['added','skipped','refreshed'])result.enrolled[key]+=Math.max(0,Number(enrolled[key])||0);
        vault.delete(id);result.succeeded++;
      }catch(error){
        const reason=taskError(error);
        result.failed++;result.failures.push({id,email:record?.email||'',error:reason});
        if(record)try{vault.updateStatus(id,{state:'auth_failed',lastError:reason})}catch{}
      }
      result.processed++;updateProgress({processed:result.processed,total:result.total,succeeded:result.succeeded,failed:result.failed});
    }
    return {status:result.failed?(result.succeeded?'partial':'failed'):(result.invalid?'partial':'succeeded'),result,...(result.failed&&!result.succeeded?{error:'账号授权失败，请查看失败明细。'}:{})};
  }
  async function runQuotaTask({task,updateProgress}){
    let progressId='';
    try{
      const ref=task.params.ref;
      const job=await execute({path:ref?'/api/accounts/refresh':'/local/accounts/refresh-all',method:'POST',body:ref?{access_tokens:[ref]}:{}});
      progressId=safeText(job.progress_id);
      if(!uuidPattern.test(progressId))return {status:'interrupted',error:'刷新请求已提交，但未返回可跟踪的进度，请核对号池后再重试。'};
      updateProgress({progressId,total:job.total||1,processed:0});
      const deadline=Date.now()+15*60*1000;
      let misses=0;
      while(Date.now()<deadline){
        let progress;
        try{progress=await execute({path:'/api/accounts/refresh/progress/'+progressId})}
        catch(error){if(Number(error.status)===404&&misses++<4){await new Promise(resolve=>setTimeout(resolve,taskPollIntervalMs));continue}throw error}
        updateProgress({progressId,...progress});
        if(progress.done){
          const errorCount=Number(progress.errorCount)||0,total=Number(progress.total)||0;
          return {status:errorCount?(errorCount>=total?'failed':'partial'):'succeeded',result:progress,...(errorCount?{error:`额度查询有 ${errorCount} 项异常，请核对账号及网络。`}:{})};
        }
        await new Promise(resolve=>setTimeout(resolve,taskPollIntervalMs));
      }
      return {status:'interrupted',error:'刷新任务仍可能在上游执行，请核对号池后再重试。'};
    }catch(error){return {status:progressId?'interrupted':'failed',error:taskError(error)}}
  }
  async function submitTask(input){
    if(!input||!taskTypes.has(input.type))throw fail('任务类型无效');
    const params=input.params||{};
    if(!params||typeof params!=='object'||Array.isArray(params))throw fail('任务参数无效');
    const requestId=safeText(input.requestId);
    if(!/^[A-Za-z0-9_-]{8,100}$/.test(requestId))throw fail('请提供有效的任务请求 ID');
    const parentTaskId=input.parentTaskId||null;
    if(parentTaskId){const parent=history.get(parentTaskId);if(!parent||parent.type!==input.type)throw fail('关联任务无效');}
    const requestHash=createHmac('sha256',secret).update(JSON.stringify(canonical({type:input.type,params,parentTaskId}))).digest('hex');
    const existing=history.findByRequestId(requestId,requestHash);
    if(existing)return {task:publicTask(existing)};
    let cleanParams,summary,runner,referenceInputs=[];
    if(input.type==='image'||input.type==='gif'){
      if((params.images!==undefined&&!Array.isArray(params.images))||(params.referenceFiles!==undefined&&!Array.isArray(params.referenceFiles)))throw fail('参考图片必须为数组');
      const pref=resolvedPreferences.get();
      let references=asArray(params.images);
      if(references.length&&asArray(params.referenceFiles).length)throw fail('请使用参考图片或历史文件其中一种来源');
      if(asArray(params.referenceFiles).length){
        if(params.referenceFiles.length>4)throw fail('最多选择 4 张参考图');
        references=params.referenceFiles.map(file=>{const value=history.file(typeof file==='string'?file:file?.id);return {b64_json:value.data.toString('base64'),mime_type:value.mimeType}});
      }
      const selected={...params,model:params.model||pref.defaultModel,...(references.length?{images:references}:{})};
      if(input.type==='gif'){if(references.length)throw fail('GIF 暂不支持参考图');selected.output_format='gif';selected.size=params.size||'auto';}
      else if(params.output_format)throw fail('图片任务不能指定 GIF 输出');
      selected.size=input.type==='gif'?selected.size:resolveImageSize(selected,pref);
      const imageInput=acceptedImagePayload(selected,references.length>0);
      referenceInputs=asArray(imageInput.images).map(file=>({data:Buffer.from(file.b64_json,'base64'),mimeType:file.mime_type,role:'input'}));
      cleanParams={...imageInput,resolution:validateImageTier(params.resolution||pref.defaultImageTier)};
      delete cleanParams.images;delete cleanParams.n;delete cleanParams.response_format;cleanParams.referenceFiles=[];
      if(referenceInputs.length)cleanParams.referenceCount=referenceInputs.length;
      summary=imageInput.prompt.slice(0,100);
      runner=runImageTask;
    }else if(input.type==='authorize'){
      if(!vault||!authenticator)throw fail('账号授权功能尚未就绪',503);
      if(params.all!==undefined&&typeof params.all!=='boolean')throw fail('全部授权参数无效');
      let ids=[],duplicates=0,invalid=0,errors=[];
      if(safeText(params.text).trim()){
        const parsed=parseCredentialLines(params.text);
        if(!parsed.accounts.length)throw fail('没有可授权的有效账号，请检查导入格式');
        if(parsed.accounts.length>100)throw fail('单次最多授权 100 个账号');
        vault.importText(params.text);duplicates=parsed.duplicates;invalid=parsed.errors.length;
        const safeReasons=new Set(['应为邮箱----密码----第三字段（恰好三个字段）','邮箱格式不正确','密码为空或长度超限','第三字段为空或长度超限','Token 格式不正确或长度超限','RefreshToken 格式不正确或长度超限']);
        errors=parsed.errors.slice(0,100).map(error=>({line:error.line,reason:safeReasons.has(error.reason)?error.reason:'账号行格式不正确，请检查导入格式'}));
        const records=vault.getAll(),emails=new Set(parsed.accounts.map(item=>item.email));
        ids=records.filter(record=>emails.has(record.email.toLowerCase())).map(record=>record.id);
      }else if(params.id)ids=[params.id];
      else if(params.all)ids=vault.getAll().map(record=>record.id);
      else ids=asArray(params.ids);
      ids=[...new Set(ids)];
      if(!ids.length||ids.length>100||ids.some(id=>!uuidPattern.test(safeText(id))))throw fail('单次须选择 1–100 个有效的暂存账号');
      if(ids.some(id=>!vault.get(id)))throw fail('部分暂存账号已移除，请刷新后重试',404);
      cleanParams={ids,duplicates,invalid,errors};summary=`授权 ${ids.length} 个账号`;runner=runAuthorizeTask;
    }else{
      if(params.ref!==undefined&&typeof params.ref!=='string')throw fail('账号引用无效');
      const ref=safeText(params.ref);
      if(ref&&!/^[a-f0-9]{64}$/.test(ref))throw fail('账号引用无效');
      cleanParams=ref?{ref}:{};summary=ref?'刷新单个账号额度':'刷新全部账号额度';runner=runQuotaTask;
    }
    const task=history.submit({type:input.type,summary,params:cleanParams,requestId,requestHash,parentTaskId},runner);
    try{
      if(referenceInputs.length){
        const referenceFiles=referenceInputs.map(file=>history.addFile(task.id,file));
        history.updateParams(task.id,{...cleanParams,referenceFiles});
      }
    }catch(error){history.failQueued(task.id,'参考图片保存失败，请重新提交。');throw fail('参考图片无效或无法保存，请检查图片后重新提交');}
    return {task:publicTask(history.get(task.id))};
  }
  async function execute({path,method='GET',body}={}){
    if(typeof path!=='string'||typeof method!=='string')throw fail('请求格式无效');
    method=method.toUpperCase();
    if(path==='/local/tasks'&&method==='POST')return submitTask(body);
    if((path==='/local/tasks'||path.startsWith('/local/tasks?'))&&method==='GET'){
      const query=new URL(path,'http://localhost').searchParams;
      const list=history.list(Object.fromEntries(query));
      return {...list,items:list.items.map(publicTask)};
    }
    const taskMatch=path.match(/^\/local\/tasks\/([0-9a-f-]{36})(\/retry)?$/i);
    if(taskMatch){
      const task=history.get(taskMatch[1]);if(!task)throw fail('未找到指定任务',404);
      if(!taskMatch[2]&&method==='GET')return {task:publicTask(task)};
      if(!taskMatch[2]&&method==='DELETE'){history.delete(task.id);return {ok:true};}
      if(taskMatch[2]&&method==='POST'){
        if(task.type==='api_request')throw fail('API 请求未保存完整输入，请在原客户端重新提交',409);
        if(!['failed','partial','interrupted'].includes(task.status))throw fail('此任务当前不能重试',409);
        if(['image','gif'].includes(task.type)&&task.params.referenceCount&&asArray(task.params.referenceFiles).length!==task.params.referenceCount)throw fail('参考图片未完整保存，请重新选择图片后提交');
        const failedIds=asArray(task.result?.failures).map(item=>item.id);
        const params=task.type==='authorize'?{ids:failedIds.length?failedIds:!task.result?asArray(task.params.ids).filter(id=>vault?.get(id)):[]}:task.params;
        if(task.type==='authorize'&&!params.ids.length)throw fail('没有可重试的失败账号，请重新选择待授权记录');
        return submitTask({type:task.type,params,requestId:body?.requestId,parentTaskId:task.id});
      }
    }
    const taskFileMatch=path.match(/^\/local\/task-files\/([0-9a-f-]{36})$/i);
    if(taskFileMatch&&method==='GET'){
      const file=history.file(taskFileMatch[1]);
      return {id:file.id,mimeType:file.mimeType,b64_json:file.data.toString('base64')};
    }
    // Fixed Host-owned directory only: the browser cannot pass a path here.
    if(path==='/local/open-images-dir'){
      if(method!=='GET'&&method!=='POST')throw fail('接口方法不允许',405);
      if(!resolvedImagesDir)throw fail('当前使用外部后端，没有本机历史图片目录',503);
      try{fs.mkdirSync(resolvedImagesDir,{recursive:true})}catch(e){throw fail(`历史图片目录不可用：${e.message}`,500)}
      const count=countImages(resolvedImagesDir);
      // GET only reports the path so the UI can show a copyable address.
      if(method==='GET')return {dir:resolvedImagesDir,count,opened:false};
      try{await openFolder(resolvedImagesDir)}
      catch(e){return {dir:resolvedImagesDir,count,opened:false,error:String(e?.message||e).slice(0,200)}}
      return {dir:resolvedImagesDir,count,opened:true};
    }
    if(path==='/local/credential-vault'){
      if(!vault)throw fail('本地加密账号暂存功能不可用',503);
      if(method==='GET')return vault.list();
      if(method==='POST'){
        if(!body||typeof body.text!=='string')throw fail('请输入账号行文本');
        if(body.autoAuth){
          if(!authenticator)throw fail('账号自动认证功能不可用',503);
          const parsed=parseCredentialLines(body.text);
          if(!parsed.accounts.length){
            const reason=parsed.errors?.[0]?.reason||'格式不匹配';
            throw fail(`未包含有效的账号数据（第 ${parsed.errors?.[0]?.line||1} 行：${reason}）`);
          }
          const targets=parsed.accounts.map(a=>({id:'',email:a.email,password:a.password,totp_secret:a.auxiliary,access_token:a.accessToken||'',refresh_token:a.refreshToken||''}));
          if(targets.length>100)throw fail('单次最多认证 100 个账号');
          const authResult=await authenticator({accounts:targets,proxy:safeText(body?.proxy)});
          const results=asArray(authResult?.results);
          const successes=results.filter(x=>x?.ok&&safeText(x?.access_token));
          const failures=results.filter(x=>!x?.ok);
          let enrolled={added:0,skipped:parsed.duplicates,refreshed:0,errorCount:0};
          if(successes.length>0){
            const accountItems=successes.map(s=>{
              const orig=targets.find(t=>t.email.toLowerCase()===String(s.email).toLowerCase())||{};
              return {
                email:safeText(s.email),
                password:safeText(s.password||orig.password),
                totp_secret:safeText(s.totp_secret||orig.totp_secret),
                access_token:safeText(s.access_token),
                refresh_token:safeText(s.refresh_token||orig.refresh_token),
                id_token:safeText(s.id_token),
                source_type:'oauth_password_2fa',
                type:'oauth'
              };
            });
            const tokens=successes.map(s=>safeText(s.access_token));
            const r=await call('/api/accounts','POST',{accounts:accountItems,tokens},180000);
            enrolled={added:Number(r.added)||0,skipped:(Number(r.skipped)||0)+parsed.duplicates,refreshed:Number(r.refreshed)||0,errorCount:asArray(r.errors).length};
          }
          if(failures.length>0){
            const failLines=failures.map(f=>{
              const orig=targets.find(t=>t.email.toLowerCase()===String(f.email).toLowerCase());
              return orig?`${orig.email}----${orig.password}----${orig.totp_secret}${orig.access_token?'----'+orig.access_token:''}`:'';
            }).filter(Boolean).join('\n');
            if(failLines)vault.importText(failLines);
            for(const f of failures){
              const match=vault.getAll().find(r=>r.email.toLowerCase()===String(f.email).toLowerCase());
              if(match)try{vault.updateStatus(match.id,{state:'auth_failed',lastError:safeText(f.error||'认证失败')})}catch{}
            }
          }
          return {
            autoAuth:true,
            total:targets.length+parsed.duplicates,
            succeeded:successes.length,
            failed:failures.length,
            duplicates:parsed.duplicates,
            enrolled,
            failures:failures.map(f=>({email:safeText(f.email),error:safeText(f.error).slice(0,100)})),
            invalid:parsed.errors.length,
            errors:parsed.errors.slice(0,100),
            vaultCount:vault.list().count
          };
        }
        return vault.importText(body.text);
      }
    }
    if(path==='/local/credential-vault/authenticate'&&method==='POST'){
      if(!vault)throw fail('本地账号暂存功能不可用',503);
      if(!authenticator)throw fail('账号自动认证功能不可用',503);
      let targets=[];
      const text=safeText(body?.text);
      const id=safeText(body?.id);
      const all=Boolean(body?.all);
      let duplicateCount=0;
      let parseErrors=[];
      if(text.trim()){
        const parsed=parseCredentialLines(text);
        if(!parsed.accounts.length){
          const reason=parsed.errors?.[0]?.reason||'格式不匹配';
          throw fail(`未包含有效的账号数据（第 ${parsed.errors?.[0]?.line||1} 行：${reason}）`);
        }
        targets=parsed.accounts.map(a=>({id:'',email:a.email,password:a.password,totp_secret:a.auxiliary,access_token:a.accessToken||'',refresh_token:a.refreshToken||''}));
        duplicateCount=parsed.duplicates;
        parseErrors=parsed.errors;
      }else if(id){
        const record=vault.get(id);
        if(!record)throw fail('未找到指定的暂存账号',404);
        targets=[{id:record.id,email:record.email,password:record.password,totp_secret:record.auxiliary,access_token:record.accessToken||'',refresh_token:record.refreshToken||''}];
      }else if(all){
        const records=vault.getAll();
        if(!records.length)throw fail('没有待授权的暂存账号');
        targets=records.map(r=>({id:r.id,email:r.email,password:r.password,totp_secret:r.auxiliary,access_token:r.accessToken||'',refresh_token:r.refreshToken||''}));
      }else{
        throw fail('请提供待授权账号文本、账号 ID 或指定全部授权');
      }
      if(targets.length>100)throw fail('单次最多认证 100 个账号');
      const authResult=await authenticator({accounts:targets,proxy:safeText(body?.proxy)});
      const results=asArray(authResult?.results);
      const successes=results.filter(x=>x?.ok&&safeText(x?.access_token));
      const failures=results.filter(x=>!x?.ok);
      let enrolled={added:0,skipped:duplicateCount,refreshed:0,errorCount:0};
      if(successes.length>0){
        const accountItems=successes.map(s=>{
          const orig=targets.find(t=>t.email.toLowerCase()===String(s.email).toLowerCase())||{};
          return {
            email:safeText(s.email),
            password:safeText(s.password||orig.password),
            totp_secret:safeText(s.totp_secret||orig.totp_secret),
            access_token:safeText(s.access_token),
            refresh_token:safeText(s.refresh_token||orig.refresh_token),
            id_token:safeText(s.id_token),
            source_type:'oauth_password_2fa',
            type:'oauth'
          };
        });
        const tokens=successes.map(s=>safeText(s.access_token));
        const r=await call('/api/accounts','POST',{accounts:accountItems,tokens},180000);
        enrolled={added:Number(r.added)||0,skipped:(Number(r.skipped)||0)+duplicateCount,refreshed:Number(r.refreshed)||0,errorCount:asArray(r.errors).length};
        for(const s of successes){
          if(s.id)try{vault.delete(s.id)}catch{}
          else{
            const match=vault.getAll().find(r=>r.email.toLowerCase()===String(s.email).toLowerCase());
            if(match)try{vault.delete(match.id)}catch{}
          }
        }
      }
      for(const f of failures){
        const targetId=f.id||vault.getAll().find(r=>r.email.toLowerCase()===String(f.email).toLowerCase())?.id;
        if(targetId)try{vault.updateStatus(targetId,{state:'auth_failed',lastError:safeText(f.error||'认证失败')})}catch{}
      }
      return {
        total:targets.length+duplicateCount,
        succeeded:successes.length,
        failed:failures.length,
        duplicates:duplicateCount,
        enrolled,
        failures:failures.map(f=>({email:safeText(f.email),error:safeText(f.error).slice(0,100)})),
        invalid:parseErrors.length,
        errors:parseErrors.slice(0,100),
        vaultCount:vault.list().count
      };
    }
    const vaultDelete=path.match(/^\/local\/credential-vault\/([0-9a-f-]{36})$/i);
    if(vaultDelete&&method==='DELETE'){
      if(!vault)throw fail('本地加密账号暂存功能不可用',503);
      return vault.delete(vaultDelete[1]);
    }
    if(path==='/health?format=json'&&method==='GET'){
      const x=await call(path);return {status:x.status,healthy:x.healthy,version:x.version,accounts:x.accounts,baseUrl};
    }
    if(path==='/local/image-preferences') {
      if(method==='GET') return resolvedPreferences.get();
      if(method==='POST') return resolvedPreferences.set(body);
      throw fail('接口方法不允许',405);
    }
    if(path==='/local/gif-capabilities' && method==='GET') {
      const fallback={enabled:false,mode:'chatgpt_account_pool',requiresApiKey:false,
        supportedModels:['gpt-image-2.6','gpt-image-2.6-flare','gpt-image-2.6-sunburst'],supportsReferenceImages:false};
      if(!gifPoolEnabled)return fallback;
      try {
        const active=await call('/dsh/pool-gif-status','GET',undefined,5000);
        return {...fallback,enabled:active?.enabled===true};
      }catch{return fallback}
    }
    if(path==='/local/models' && method==='GET') {
      const result=await call('/v1/models');
      if(!Array.isArray(result?.data))throw fail('上游模型列表格式不正确',502);
      return {models:[...new Set(result.data.map(x=>safeText(x?.id)).filter(x=>/^[a-zA-Z0-9._-]{1,80}$/.test(x)))].slice(0,200)};
    }
    if(path==='/local/proxy'){
      if(method==='GET'){
        const settings=await call('/api/settings');
        return publicProxyConfig(settings?.config?.proxy);
      }
      if(method==='POST'){
        const url=validatedProxyUrl(body?.url);
        // Upstream config.update merges keys. We update ONLY the global proxy;
        // we do not touch OAuth credentials, runtime clearance or other settings.
        await call('/api/settings','POST',{proxy:url});
        return publicProxyConfig(url);
      }
    }
    if(path==='/local/proxy/test'&&method==='POST'){
      const url=validatedProxyUrl(body?.url);
      const response=await call('/api/proxy/test','POST',{url},30000);
      const result=response?.result||{};
      return {result:{
        ok:result.ok===true,
        status:Number.isInteger(result.status)?result.status:0,
        latency_ms:Number.isFinite(result.latency_ms)?Math.max(0,result.latency_ms):0,
        has_proxy:result.has_proxy===true,
        proxy_source:['input','global','runtime','account','explicit','direct'].includes(result.proxy_source)?result.proxy_source:'unknown',
        error:result.ok===true?'':result.error==='no active proxy configured'?'尚未配置代理':result.error==='invalid proxy url'?'代理地址格式无效':'连接失败，请检查代理程序、端口和网络'
      }};
    }
    if(path==='/local/accounts/refresh-all'&&method==='POST'){
      const items=asArray((await call('/api/accounts')).items);
      if(!items.length)throw fail('号池为空，请先导入账号');
      if(items.length>200)throw fail('为避免大量并发请求，一次最多刷新 200 个账号');
      const response=await call('/api/accounts/refresh','POST',{access_tokens:[]},30000);
      return {progress_id:safeText(response.progress_id),total:items.length};
    }
    const progressMatch=path.match(/^\/api\/accounts\/refresh\/progress\/([0-9a-f-]{36})$/i);
    if(progressMatch&&method==='GET'){
      const progress=await call(path);
      const result=progress?.result;
      return {
        done:progress?.done===true,
        total:Math.max(0,Number(progress?.total)||0),
        processed:Math.max(0,Number(progress?.processed)||0),
        total_quota:Math.max(0,Number(progress?.total_quota)||0),
        errorCount:asArray(result?.errors).length+(progress?.error?1:0),
        refreshed:Math.max(0,Number(result?.refreshed)||0)
      };
    }
    if(path==='/api/accounts'){
      if(method==='GET')return {items:asArray((await call(path)).items).map(x=>cleanAccount(x,secret)).filter(Boolean)};
      if(method==='POST'){
        const tokens=asArray(body?.tokens).map(safeText).filter(Boolean),accounts=asArray(body?.accounts);
        if((tokens.length+accounts.length)<1||(tokens.length+accounts.length)>100)throw fail('每次只能导入 1–100 个账号');
        if(tokens.some(x=>x.length>12000)||accounts.some(x=>!safeText(x?.access_token||x?.accessToken)))throw fail('账号数据无效');
        const r=await call(path,'POST',{tokens,accounts},160000);
        return {added:r.added,skipped:r.skipped,refreshed:r.refreshed,errorCount:asArray(r.errors).length};
      }
      if(method==='DELETE'){
        const refs=asArray(body?.tokens);if(!refs.length||refs.length>100)throw fail('每次只能删除 1–100 个已显示的账号');
        const tokens=await resolveAccountRefs([...new Set(refs)]);
        const result=await call(path,'DELETE',{tokens});
        if(!Number.isInteger(result?.removed)||result.removed<0||result.removed>tokens.length)throw fail('后端未返回有效的删除结果，请刷新账号列表确认',502);
        return {ok:true,removed:result.removed};
      }
    }
    if(path==='/api/accounts/refresh'&&method==='POST'){
      const refs=asArray(body?.access_tokens);if(refs.length!==1)throw fail('每次仅刷新一个已显示的账号');
      const token=await resolveAccountRef(refs[0]);
      const r=await call(path,'POST',{access_tokens:[token]},30000);
      return {progress_id:r.progress_id||null,refreshed:r.refreshed||0};
    }
    if(path==='/api/auth/users'){
      if(method==='GET')return {items:cleanUserKeys((await call(path)).items, resolvedKeyStore)};
      if(method==='POST'){
        const name=safeText(body?.name).trim().slice(0,100)||'本机应用';
        const r=await call(path,'POST',{name});
        const rawKey=safeText(r.key);
        let createdId=safeText(r.item?.id);
        const cleaned=cleanUserKeys(r.items, resolvedKeyStore);
        if(!createdId && cleaned.length){
          const match=cleaned.find(x=>x.name===name)||cleaned[cleaned.length-1];
          createdId=safeText(match?.id);
        }
        if(createdId && rawKey){
          resolvedKeyStore.set(createdId, rawKey);
          const found=cleaned.find(x=>x.id===createdId);
          if(found)found.key=rawKey;
        }
        return {key:rawKey,id:createdId,items:cleaned};
      }
    }
    const keyId=path.match(/^\/api\/auth\/users\/([a-zA-Z0-9_-]{1,100})$/);
    if(keyId&&method==='DELETE'){
      const r=await call(path,'DELETE');
      resolvedKeyStore.delete(keyId[1]);
      return {items:cleanUserKeys(r.items, resolvedKeyStore)};
    }
    if(keyId&&method==='POST'){
      const r=await call(path,'POST',body);
      if(body?.key){
        resolvedKeyStore.set(keyId[1], safeText(body.key));
      }
      return {item:r.item,key:safeText(body?.key),items:cleanUserKeys(r.items, resolvedKeyStore)};
    }
    if(path==='/api/cpa/pools'){
      if(method==='GET')return {pools:cleanPools((await call(path)).pools,['id','name','base_url'])};
      if(method==='POST'){
        const url=safeText(body?.base_url).trim();if(!/^https?:\/\//.test(url)||!safeText(body?.secret_key))throw fail('CPA 地址或密钥为空');
        const r=await call(path,'POST',{name:safeText(body?.name),base_url:url,secret_key:safeText(body.secret_key)});
        return {pools:cleanPools(r.pools,['id','name','base_url'])};
      }
    }
    const cpa=path.match(/^\/api\/cpa\/pools\/([\w-]{1,100})\/(files|import)$/);
    if(cpa){safeId(cpa[1]);if(cpa[2]==='files'&&method==='GET'){
      const r=await call(path);return {files:asArray(r.files).map(x=>typeof x==='string'?x:{name:safeText(x.name||x.filename)}).slice(0,200)};
    }
    if(cpa[2]==='import'&&method==='POST'){
      const names=asArray(body?.names).map(safeText).filter(Boolean).slice(0,100);
      return {import_job:(await call(path,'POST',{names},30000)).import_job||null};
    }}
    if(path==='/api/sub2api/servers'){
      if(method==='GET')return {servers:cleanPools((await call(path)).servers,['id','name','base_url'])};
      if(method==='POST'){
        const url=safeText(body?.base_url).trim();if(!/^https?:\/\//.test(url)||!safeText(body?.api_key))throw fail('sub2api 地址或密钥为空');
        const r=await call(path,'POST',{name:safeText(body?.name),base_url:url,api_key:safeText(body?.api_key)});
        return {servers:cleanPools(r.servers,['id','name','base_url'])};
      }
    }
    const sub=path.match(/^\/api\/sub2api\/servers\/([\w-]{1,100})\/(accounts|import)$/);
    if(sub){safeId(sub[1]);if(sub[2]==='accounts'&&method==='GET')return {accounts:cleanRemoteAccounts((await call(path)).accounts).slice(0,200)};
      if(sub[2]==='import'&&method==='POST'){
        const ids=asArray(body?.account_ids).map(safeText).filter(Boolean).slice(0,100);return {import_job:(await call(path,'POST',{account_ids:ids},30000)).import_job||null};
      }
    }
    if(method==='POST'&&(path==='/v1/images/generations'||path==='/v1/images/edits')){
      const pref=resolvedPreferences.get();
      const selected={...body,model:body?.model||pref.defaultModel};
      // GIF has a separate total-frame pixel budget: static-image 2K/4K defaults
      // are not automatically applied to GIF requests.
      const size=selected.output_format==='gif'
        ? (body?.size||'auto')
        : resolveImageSize(selected,pref);
      if(size)selected.size=size;
      const input=acceptedImagePayload(selected,path==='/v1/images/edits');
      const isGif=input.output_format==='gif';
      const result=await call(path,'POST',input,isGif?900000:240000);
      return {
        data:asArray(result.data).slice(0,1).map(x=>({b64_json:safeText(x.b64_json),url:safeText(x.url)})),
        created:result.created||null,output_format:isGif?'gif':'png',
        ...(isGif?{frame_count:result.frame_count,frame_duration_ms:result.frame_duration_ms,generation_mode:result.generation_mode||'chatgpt_account_pool'}:{})
      };
    }
    throw fail('未授权的管理操作或接口路径',404);
  }
  async function route(req){
    try{
      if(req.method!=='POST')return jsonResponse({error:'Method Not Allowed'},405);
      const raw=await req.text();if(Buffer.byteLength(raw)>MAX_BODY_BYTES)return jsonResponse({error:'请求体过大'},413);
      let payload;try{payload=JSON.parse(raw)}catch{throw fail('请求 JSON 格式无效')}
      return jsonResponse(await execute(payload));
    }catch(e){return jsonResponse({error:String(e?.message||e).replaceAll(secret,'[REDACTED]').slice(0,350)},Number.isInteger(e.status)?e.status:502)}
  }
  return {route,execute,taskHistory:history};
}
export function createNativeAuthenticator(service){
  return async function authenticateAccounts({accounts=[],proxy=''}={}){
    if(!Array.isArray(accounts)||!accounts.length)return {results:[]};
    const manager=service?.manager;
    const paths=manager?.paths||managedPaths();
    const osName=manager?.os||process.platform;
    const archName=manager?.arch||process.arch;
    const libcName=manager?.spec?.libc||detectLinuxLibc();
    const spec=resolvePlatform(osName,archName,libcName);
    const pythonBin=path.join(paths.source,'.venv',spec.pythonRelative);
    if(!fs.existsSync(pythonBin)){
      throw fail('Python 后端运行环境尚未就绪，请等待服务初始化完成',503);
    }
    const __dirname=path.dirname(fileURLToPath(import.meta.url));
    const workerScript=path.resolve(__dirname,'../scripts/auth-worker.py');
    if(!fs.existsSync(workerScript)){
      throw fail('未找到账号认证工作脚本',500);
    }
    const inputJson=JSON.stringify({
      action:'authenticate',
      accounts:accounts.map(a=>({
        id:safeText(a.id),
        email:safeText(a.email),
        password:safeText(a.password),
        totp_secret:safeText(a.totp_secret||a.auxiliary),
        access_token:safeText(a.access_token),
        refresh_token:safeText(a.refresh_token)
      })),
      proxy:safeText(proxy)
    });
    const env={
      ...process.env,
      UV_PYTHON_INSTALL_DIR:paths.python,
      UV_CACHE_DIR:paths.uvCache,
      PYTHONDONTWRITEBYTECODE:'1',
      PYTHONUNBUFFERED:'1'
    };
    return new Promise((resolve,reject)=>{
      const child=spawn(pythonBin,[workerScript],{
        cwd:paths.source,
        env,
        windowsHide:true,
        stdio:['pipe','pipe','pipe']
      });
      let stdout='',stderr='';
      child.stdout.on('data',d=>{stdout+=String(d)});
      child.stderr.on('data',d=>{stderr+=String(d)});
      const timeoutMs=Math.max(60000,accounts.length*45000);
      const timer=setTimeout(()=>{
        try{child.kill()}catch{}
        reject(fail('账号认证执行超时',504));
      },timeoutMs);
      child.on('error',err=>{
        clearTimeout(timer);
        reject(fail(`启动认证进程失败：${err.message}`,500));
      });
      child.on('close',code=>{
        clearTimeout(timer);
        if(code!==0){
          reject(fail(`认证脚本退出异常（码 ${code}）：${(stderr||stdout).slice(-300)}`,502));
          return;
        }
        try{
          resolve(JSON.parse(stdout.trim()));
        }catch(e){
          reject(fail('认证脚本返回无效数据',502));
        }
      });
      child.stdin.write(inputJson);
      child.stdin.end();
    });
  };
}

export function createAdminRoute(service,options={}){
  const {baseUrl,secret,authenticator,keyStore}=options;
  const resolvedSecret=secret||service._adminKey;
  // Credentials are staged in the local DSH-owned data directory, independent
  // of upstream token-based accounts, and encrypted with the Host-only key.
  const root=service?.manager?.paths?.root||managedPaths().root;
  const vault=new CredentialVault({root,secret:resolvedSecret});
  const resolvedKeyStore=keyStore||new UserKeyStore({root});
  const preferencesStore=new ImagePreferencesStore({root});
  const taskHistory=options.taskHistory||new TaskHistory(service?.manager?.paths?.root?{root}:{});
  const resolvedAuthenticator=authenticator||createNativeAuthenticator(service);
  // Local image history lives in the managed backend's data dir; an external
  // backend has no folder on this machine.
  const dataDir=service?.manager?.paths?.data||null;
  const handler=createAdminHandler({baseUrl:baseUrl||service.baseUrl,secret:resolvedSecret,vault,authenticator:resolvedAuthenticator,keyStore:resolvedKeyStore,preferencesStore,taskHistory,gifPoolEnabled:!!service.manager,imagesDir:dataDir?path.join(dataDir,'images'):null});
  return {path:ADMIN_ROUTE,methods:['POST'],requestBody:'buffered',fetch:(req)=>handler.route(req)};
}
