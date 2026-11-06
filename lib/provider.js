/** ChatGPT2API HTTP provider. Pure ESM, no DSH runtime dependency. */
const MAX_INPUT_IMAGES = 4;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 36 * 1024 * 1024;

function validBaseUrl(raw) {
  const value = String(raw || 'http://127.0.0.1:38650').trim().replace(/\/+$/, '');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('baseUrl 只能是 http(s)://主机:端口，不含账号、路径和查询参数');
  }
  return url.origin;
}
function str(value) { return typeof value === 'string' ? value : ''; }
function asNumber(v, fallback=0) {const x = Number(v);return Number.isFinite(x) ? x : fallback;}
function nonnegative(v) {return Math.max(0, asNumber(v));}
function toBriefError(text) {
  const clean = String(text ?? '').replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]').slice(0,600);
  try {const obj=JSON.parse(clean);return String(obj?.detail?.error || obj?.detail?.message || obj?.error?.message || obj?.error || obj?.detail || clean).slice(0,300)} catch { return clean.slice(0,300); }
}
function validateImage(image, i) {
  if (!image || typeof image !== 'object') throw new TypeError(`第 ${i + 1} 张参考图不能为空`);
  const data = str(image.dataBase64 || image.b64_json).replace(/\s/g, '');
  const mime = str(image.mimeType || image.mime_type || 'image/png');
  if (!/^image\/(png|jpeg|webp)$/i.test(mime)) throw new TypeError('参考图仅支持 PNG/JPEG/WebP');
  if (!data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new TypeError(`第 ${i + 1} 张参考图需要有效 Base64`);
  const byteLen = data.length * 3 / 4 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
  if (byteLen < 1 || byteLen > MAX_IMAGE_BYTES) throw new RangeError(`第 ${i+1} 张图片须在 1B–12MB 之间`);
  const suffix = mime.split('/')[1] === 'jpeg' ? 'jpg' : mime.split('/')[1];
  return { b64_json: data, mime_type: mime, filename: `reference-${i+1}.${suffix}` };
}

export function createProvider(options={}, transport=globalThis.fetch) {
  if (typeof transport !== 'function') throw new Error('fetch 不可用，要求 Node 20+');
  const baseUrl = validBaseUrl(options.baseUrl);
  const apiKey = str(options.apiKey).trim();
  const timeoutMs = Math.min(300000, Math.max(2000, asNumber(options.timeoutMs, 120000)));

  async function request(path, {method='GET', body=null, auth=false, timeout=timeoutMs}={}) {
    if (!path.startsWith('/')) throw new TypeError('非法路径');
    if (auth && !apiKey) throw new Error('未配置 DSH_CHATGPT2API_KEY（或指定的 Host 环境变量）');
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(), timeout);
    try {
      const headers = {Accept:'application/json'};
      if (auth) headers.Authorization = `Bearer ${apiKey}`;
      if (body !== null) headers['Content-Type'] = 'application/json';
      const response = await transport(baseUrl+path,{method,headers,body:body===null?undefined:JSON.stringify(body),signal:controller.signal});
      const contentLength=Number(response.headers?.get?.('content-length') || 0);
      if (contentLength > MAX_RESPONSE_BYTES) throw new Error('上游响应过大，已阻止读取');
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('上游响应过大，已阻止读取');
      if (!response.ok) throw new Error(`上游 HTTP ${response.status}: ${toBriefError(text)}`);
      try {return JSON.parse(text)} catch { throw new Error('上游返回了非 JSON 响应'); }
    } catch(err) {
      if (controller.signal.aborted) throw new Error(`连接超时（${Math.round(timeout/1000)} 秒）`);
      throw err;
    } finally {clearTimeout(timer)}
  }

  async function health() {
    const json = await request('/health?format=json',{timeout:10000});
    const accounts = json?.accounts || {};
    return {
      connected: true, healthy: !!json?.healthy,
      status: str(json?.status) || 'unknown', version:str(json?.version),
      accounts: {
        total:nonnegative(accounts.total), active:nonnegative(accounts.active),
        limited:nonnegative(accounts.limited), abnormal:nonnegative(accounts.abnormal),
        disabled:nonnegative(accounts.disabled), totalQuota:nonnegative(accounts.total_quota),
        totalSuccess:nonnegative(accounts.total_success), totalFail:nonnegative(accounts.total_fail)
      }
    };
  }
  async function models() {
    const json = await request('/v1/models',{auth:true,timeout:15000});
    if (!Array.isArray(json?.data)) throw new Error('上游 models 响应格式错误');
    return json.data.map(item=>str(item?.id)).filter(Boolean);
  }
  async function poolSummary(){return (await health()).accounts;}
  async function generateImage(input) {
    if (!input || typeof input !== 'object') throw new TypeError('缺少生图参数');
    const prompt = str(input.prompt).trim();
    if (!prompt || prompt.length > 12000) throw new RangeError('提示词长度必须为 1–12000 字符');
    if (input.n !== undefined && input.n !== 1) throw new RangeError('此插件当前只支持单张生成（n=1），不提供批量号池调度');
    const model = str(input.model || 'gpt-image-2');
    if (!/^[a-zA-Z0-9._-]{1,80}$/.test(model)) throw new TypeError('模型名称无效');
    const refs = input.referenceImages || [];
    if (!Array.isArray(refs) || refs.length > MAX_INPUT_IMAGES) throw new RangeError('参考图片需为数组，最多 4 张');
    const images = refs.map(validateImage);
    const payload = {model,prompt,n:1,response_format:'b64_json'};
    if(input.output_format!==undefined){
      if(input.output_format!=='gif')throw new TypeError('output_format 仅支持 gif');
      if(refs.length)throw new TypeError('原生 GIF 暂不支持参考图片');
      const frameCount=Number(input.frame_count??9);
      const duration=Number(input.frame_duration_ms??200);
      if(!Number.isInteger(frameCount)||frameCount<2||frameCount>16)throw new RangeError('GIF 帧数必须是 2–16');
      if(!Number.isInteger(duration)||duration<20||duration>2000||duration%10)throw new RangeError('GIF 每帧时长必须为 20–2000ms 且为 10ms 的整数倍');
      payload.output_format='gif';
      payload.frame_count=frameCount;
      payload.frame_duration_ms=duration;
    }
    if (str(input.size)) payload.size = str(input.size);
    const path=images.length ? '/v1/images/edits' : '/v1/images/generations';
    if (images.length) payload.images = images;
    const result = await request(path,{method:'POST',body:payload,auth:true});
    if (!Array.isArray(result?.data)) throw new Error('生图响应中缺少 data 数组');
    return {
      model, data: result.data.map((x)=>({b64_json:str(x?.b64_json), url:str(x?.url)})).filter(x=>x.b64_json||x.url),
      output_format:payload.output_format||'png',generation_mode:result.generation_mode||null,
      usage:result.usage||null, created:result.created||null
    };
  }
  async function chatCompletion(input) {
    if (!input || !Array.isArray(input.messages) || input.messages.length > 80) throw new TypeError('Chat Completions 需要 messages 数组（最多 80 条）');
    const model = str(input.model || 'auto');
    if (!/^[\w.-]{1,80}$/.test(model)) throw new TypeError('模型名称无效');
    if (Buffer.byteLength(JSON.stringify(input),'utf8') > 1000000) throw new RangeError('请求体不得超过 1 MB');
    return request('/v1/chat/completions',{method:'POST',body:{...input,model},auth:true});
  }
  async function createResponse(input) {
    if (!input || typeof input!=='object' || input.input===undefined)throw new TypeError('Responses API 缺少 input');
    if (Buffer.byteLength(JSON.stringify(input),'utf8') > 1000000) throw new RangeError('请求体不得超过 1 MB');
    return request('/v1/responses',{method:'POST',body:input,auth:true});
  }
  return Object.freeze({baseUrl,health,models,poolSummary,generateImage,chatCompletion,createResponse});
}
export {validBaseUrl,validateImage};
