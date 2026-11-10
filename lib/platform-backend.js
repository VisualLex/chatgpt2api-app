/**
 * Cross-platform local backend for standalone Node and DSH: Windows, macOS, Linux on x64/arm64.
 * It downloads a pinned chatgpt2api source snapshot and a SHA256-verified uv
 * executable, then provisions its own Python 3.13 and isolated dependencies.
 * No Docker and no system Python needed. First run does require internet.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import net from 'node:net';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {spawn, spawnSync} from 'node:child_process';
import {extractZipSafe,extractUvTarGz} from './archive.js';
import {installPoolGifBackendPatch} from './backend-gif-patch.js';
import {installImageErrorBackendPatch,installImageApiContractPatch} from './backend-image-error-patch.js';
import {installImageTaskBackendPatch} from './backend-image-task-patch.js';

export const SOURCE_COMMIT='92dd80e91543157d36a4ddad60e765c5293760e9';
export const UV_VERSION='0.9.13';
export const SOURCE_URL=`https://codeload.github.com/basketikun/chatgpt2api/zip/${SOURCE_COMMIT}`;
export const DEFAULT_PORT=38650;

// Official GitHub release API asset digests for uv v0.9.13.
const UV_BUILDS = Object.freeze({
  'win32-x64': ['uv-x86_64-pc-windows-msvc.zip','cdfb04512c9184939f16eea02644a7133b4e41233ead69122d49847d29a45538'],
  'win32-arm64':['uv-aarch64-pc-windows-msvc.zip','761e29d5a67ca61f1d19c20ce935a9fd1f0011efb0e00f1efb20b0801e06b3c4'],
  'darwin-x64':['uv-x86_64-apple-darwin.tar.gz','571cb1623681c439af892335c729c272266e836a9ebcb627f34f8012c6459d9d'],
  'darwin-arm64':['uv-aarch64-apple-darwin.tar.gz','9c594dce1c237e11680be2b6d1331448eeb6f8a1453fb851a66a40291bb624de'],
  'linux-x64-gnu':['uv-x86_64-unknown-linux-gnu.tar.gz','c45a44144bf23a2182e143227b4ad0bbe41a2bb7161a637c02e968906af53fd1'],
  'linux-arm64-gnu':['uv-aarch64-unknown-linux-gnu.tar.gz','c221d04810f873a7aa8bae9aa6ed721e600e56534980df1363952386a4fcdcc5'],
  'linux-x64-musl':['uv-x86_64-unknown-linux-musl.tar.gz','04cf326d2d742ce5c8890fdc0b9f71bd707be8640979bf6e53ddd52da74dfb41'],
  'linux-arm64-musl':['uv-aarch64-unknown-linux-musl.tar.gz','5a81540af68e28df324d01d79900e7b86c659e8167cb236528b8e6050d74f94e']
});

export function detectLinuxLibc(){
  if(process.platform!=='linux')return 'gnu';
  try{return process.report.getReport().header.glibcVersionRuntime?'gnu':'musl';}catch{return 'gnu';}
}
export function resolvePlatform(platform=process.platform,arch=process.arch,libc=detectLinuxLibc()){
  const tag=platform==='linux'?`${platform}-${arch}-${libc}`:`${platform}-${arch}`;
  const data=UV_BUILDS[tag];
  if(!data)throw Error(`暂不支持 ${platform}/${arch}${platform==='linux'?'/'+libc:''}；当前支持 Windows/macOS/Linux 的 x64/arm64（Linux GNU/musl）`);
  const [filename,sha256]=data;
  return {platform,arch,libc:platform==='linux'?libc:null,tag,filename,sha256,
    url:`https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${filename}`,
    executable:platform==='win32'?'uv.exe':'uv',
    pythonRelative:platform==='win32'?path.join('Scripts','python.exe'):path.join('bin','python')};
}

export function managedPaths(options={}){
  const root=path.resolve(options.root||process.env.CHATGPT2API_HOME||process.env.DSH_CHATGPT2API_HOME||path.join(os.homedir(),'.dsh','chatgpt2api-native'));
  const platform=options.platform||process.platform;
  const arch=options.arch||process.arch;
  const libc=options.libc||detectLinuxLibc();
  const tag=platform==='linux'?`${platform}-${arch}-${libc}`:`${platform}-${arch}`;
  return {root,source:path.join(root,'source'),data:path.join(root,'source','data'),
    marker:path.join(root,'source','.dsh-source-commit'),uv:path.join(root,'runtime',platform==='win32'?(arch==='x64'?'uv.exe':'uv-arm64.exe'):`uv-${tag}`),
    key:path.join(root,'admin-key'),downloads:path.join(root,'downloads'),runtime:path.join(root,'runtime'),
    uvCache:path.join(root,'uv-cache'),python:path.join(root,'python'),logs:path.join(root,'backend.log')};
}
export function ensureManagedFiles(paths,keyOverride=''){
  fs.mkdirSync(paths.root,{recursive:true,mode:0o700});
  const valid=/^[\x21-\x7e]{12,256}$/;
  if(keyOverride&&!valid.test(keyOverride))throw Error('Host 内部认证密钥无效：需至少 12 位 ASCII 字符');
  if(!fs.existsSync(paths.key))fs.writeFileSync(paths.key,(keyOverride||crypto.randomBytes(32).toString('hex'))+'\n',{flag:'wx',mode:0o600});
  const key=String(keyOverride||fs.readFileSync(paths.key,'utf8')).trim();
  if(!valid.test(key))throw Error('内部认证密钥损坏，请检查用户数据目录');
  return key;
}
const DOWNLOAD_HOSTS=new Set(['github.com','codeload.github.com','release-assets.githubusercontent.com','objects.githubusercontent.com','github-releases.githubusercontent.com']);
function checkedDownloadUrl(raw){
  const url=new URL(raw);
  if(url.protocol!=='https:'||url.username||url.password||!DOWNLOAD_HOSTS.has(url.hostname)||url.port)throw Error('下载地址必须是受信任的 GitHub HTTPS 地址');
  return url;
}
export function downloadProxy(env=process.env){
  return env.CHATGPT2API_DOWNLOAD_PROXY??env.HTTPS_PROXY??env.https_proxy??env.HTTP_PROXY??env.http_proxy??'';
}
function checkedDownloadProxy(raw){
  let url;
  try{url=new URL(raw)}catch{throw Error('下载代理地址无效，请使用完整 HTTP(S)/SOCKS5 URL')}
  if(!['http:','https:','socks5:','socks5h:'].includes(url.protocol)||!url.hostname||url.search||url.hash||(url.pathname&&url.pathname!=='/'))throw Error('下载代理只支持无路径或查询参数的 HTTP(S)/SOCKS5 URL');
  return String(raw);
}
async function curlDownload(url,part,{maxBytes,proxy,runner,onSpawn}){
  const headersFile=part+'.headers';
  let current=checkedDownloadUrl(url);
  try{
    // curl never follows redirects itself: validate every Location before use.
    for(let hop=0;hop<=5;hop++){
      fs.rmSync(part,{force:true});
      fs.writeFileSync(headersFile,'',{mode:0o600});
      const args=['--silent','--show-error','--fail','--proto','=https','--connect-timeout','20','--max-time','180','--max-filesize',String(maxBytes),'--proxy',proxy,'--dump-header',headersFile,'--output','-','--',current.href];
      const child=runner(process.platform==='win32'?'curl.exe':'curl',args,{windowsHide:true,shell:false,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
      onSpawn?.(child);
      let stderr='',bytes=0;
      child.stderr?.on('data',chunk=>{stderr=(stderr+String(chunk)).slice(-1200)});
      const completed=new Promise((resolve,reject)=>{
        child.once('error',()=>reject(Error('无法启动系统 curl；请安装 curl 后重试或取消下载代理配置')));
        child.once('close',code=>code===0?resolve():reject(Error(`代理下载失败（curl ${code}）：${stderr.replaceAll(proxy,'[PROXY]').replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi,'[PROXY]@')}`)));
      });
      async function* limited(){
        for await(const chunk of child.stdout){bytes+=chunk.length;if(bytes>maxBytes)throw Error('下载文件过大');yield chunk}
      }
      const transfer=pipeline(Readable.from(limited()),fs.createWriteStream(part,{flags:'wx',mode:0o600}));
      try{await Promise.all([completed,transfer])}catch(error){try{child.kill('SIGKILL')}catch{}await Promise.allSettled([completed,transfer]);throw error}
      if(fs.statSync(headersFile).size>128*1024)throw Error('下载响应头过大');
      const block=fs.readFileSync(headersFile,'utf8').split(/\r?\n\r?\n/).reverse().find(value=>/^HTTP\/\S+\s+\d{3}/.test(value));
      const status=Number(block?.match(/^HTTP\/\S+\s+(\d{3})/)?.[1]);
      if(status>=300&&status<400){
        const location=block.match(/(?:^|\r?\n)location:\s*([^\r\n]+)/i)?.[1]?.trim();
        if(!location||hop===5)throw Error('下载重定向过多或缺少 Location');
        current=checkedDownloadUrl(new URL(location,current));
        continue;
      }
      if(status<200||status>=300||!Number.isFinite(status))throw Error(`代理下载失败 HTTP ${status||'未知'}`);
      return bytes;
    }
  }finally{fs.rmSync(headersFile,{force:true})}
}
export async function downloadAsset(url,filename,{maxBytes=50000000,sha256='',fetcher=globalThis.fetch,proxy=downloadProxy(),runner=spawn,onSpawn}={}){
  checkedDownloadUrl(url);
  fs.mkdirSync(path.dirname(filename),{recursive:true});
  const part=filename+'.part';
  try{fs.rmSync(part,{force:true})}catch{}
  try{
    let n=0;
    if(proxy){
      n=await curlDownload(url,part,{maxBytes,proxy:checkedDownloadProxy(proxy),runner,onSpawn});
    }else{
      // The built-in path also checks the final host before reading any bytes.
      const response=await fetcher(url,{redirect:'follow',signal:AbortSignal.timeout(180000)});
      if(!response.ok||!response.body)throw Error(`下载失败 HTTP ${response.status}: ${url}`);
      checkedDownloadUrl(response.url||url);
      const len=Number(response.headers?.get?.('content-length')||0);
      if(len>maxBytes)throw Error('下载文件超过限制');
      async function* bytes(){for await(const chunk of Readable.fromWeb(response.body)){n+=chunk.length;if(n>maxBytes)throw Error('下载文件过大');yield chunk;}}
      await pipeline(Readable.from(bytes()),fs.createWriteStream(part,{flags:'wx',mode:0o600}));
    }
    if(n<1000)throw Error('下载内容异常');
    if(sha256){const digest=crypto.createHash('sha256').update(fs.readFileSync(part)).digest('hex');if(digest!==sha256)throw Error('下载 SHA256 不匹配，拒绝执行');}
    fs.renameSync(part,filename);return filename;
  }catch(e){try{fs.rmSync(part,{force:true})}catch{}throw e;}
}
export function runCommand(bin,args,{cwd,env=process.env,timeoutMs=900000,runner=spawn,onLine,onSpawn,detached=false}={}){
  return new Promise((resolve,reject)=>{
    const p=runner(bin,args,{cwd,env,windowsHide:true,shell:false,detached,stdio:['ignore','pipe','pipe']});
    onSpawn?.(p);
    let output='',done=false;
    const recv=data=>{output=(output+String(data)).slice(-11000);onLine?.(String(data).slice(-350))};
    p.stdout?.on('data',recv);p.stderr?.on('data',recv);
    const timer=setTimeout(()=>{if(done)return;done=true;try{p.kill()}catch{}reject(Error('命令执行超时：'+path.basename(bin)))},timeoutMs);
    p.on('error',e=>{if(done)return;done=true;clearTimeout(timer);reject(Error(`无法执行 ${path.basename(bin)}：${e.message}`))});
    p.on('close',code=>{if(done)return;done=true;clearTimeout(timer);if(code===0)resolve(output.trim());else reject(Error(`命令失败 ${path.basename(bin)}（退出码 ${code}）：${output.slice(-900)}`))});
  });
}
export function validatePort(p){const value=Number(p);if(!Number.isInteger(value)||value<1024||value>65535)throw Error('端口应为 1024–65535');return value;}
export function checkPortFree(port){return new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',e=>reject(Error(`端口 ${port} 不可用：${e.code||e.message}`)));s.listen({host:'127.0.0.1',port,exclusive:true},()=>s.close(resolve));});}

/**
 * Packages the backend cannot start without. A ready marker only proves a
 * previous run succeeded: the interpreter, or its whole site-packages tree, can
 * be removed afterwards (interrupted uv run, antivirus, manual cleanup). That
 * leaves a backend that answers /health but fails the moment a lazy import runs
 * (this is how image generation broke with `No module named 'anyio._backends'`).
 */
export const REQUIRED_PACKAGES=Object.freeze(['anyio','fastapi','uvicorn','starlette']);
function sitePackagesPath(venv,platform){
  if(platform==='win32')return path.join(venv,'Lib','site-packages');
  try{
    const base=path.join(venv,'lib');
    const versions=fs.readdirSync(base).filter(name=>/^python3\.\d+$/.test(name)).sort((a,b)=>Number(a.slice(7))-Number(b.slice(7)));
    if(versions.length)return path.join(base,versions[versions.length-1],'site-packages');
  }catch{}
  return null;
}
/** @returns {null|{reason:string,message:string,venv:string,missing?:string[]}} */
export function pythonEnvIssue(paths,spec){
  const venv=path.join(paths.source,'.venv');
  const python=path.join(venv,spec.pythonRelative);
  if(!fs.existsSync(python))return {reason:'python-missing',venv,message:'缺少虚拟环境解释器'};
  const sitePackages=sitePackagesPath(venv,spec.platform);
  if(!sitePackages||!fs.existsSync(sitePackages))return {reason:'site-packages-missing',venv,message:'缺少 site-packages 目录'};
  const missing=REQUIRED_PACKAGES.filter(name=>!fs.existsSync(path.join(sitePackages,name))&&!fs.existsSync(path.join(sitePackages,name+'.py')));
  if(missing.length)return {reason:'packages-missing',venv,missing,message:`缺少依赖包 ${missing.join('、')}`};
  return null;
}

/** The backend lock pins `requires-python = ">=3.13"`; older interpreters cannot install it. */
export const MINIMUM_PYTHON_MINOR=13;
export function isCompatiblePython(python){
  return python?.major===3&&Number.isInteger(python.minor)&&python.minor>=MINIMUM_PYTHON_MINOR;
}
const PYTHON_PROBE='import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}|{sys.executable}|{1 if sys.prefix!=sys.base_prefix else 0}")';

function probePython(exe,args=[]){
  if(!exe)return null;
  try{
    const res=spawnSync(exe,[...args,'-c',PYTHON_PROBE],{
      encoding:'utf8',
      timeout:5000,
      windowsHide:true,
      stdio:['ignore','pipe','pipe']
    });
    if(res.status!==0||!res.stdout)return null;
    const parts=res.stdout.trim().split('|');
    if(parts.length<3||!parts[1])return null;
    const [major,minor]=parts[0].split('.').map(Number);
    if(major!==3||!Number.isInteger(minor))return null;
    return {path:parts[1].trim(),version:`${major}.${minor}`,major,minor,inVenv:parts[2].trim()==='1'};
  }catch{return null;}
}
/** Backwards-compatible single-path probe (accepts any 3.x >= 3.10). */
export function probePythonExecutable(executable){
  const probed=probePython(executable);
  return probed&&probed.minor>=10?probed:null;
}

/**
 * Real OS installs first, and never a `python` that only exists inside another
 * tool's virtualenv: on Windows `python` on PATH is frequently some other
 * application's venv or a bundled portable copy, either of which can disappear
 * without warning. The `py -3.13` launcher and the Python registry entries
 * resolve to the OS installation itself.
 */
let windowsInstallsCache=null;
export function windowsRegistryPythons(){
  if(process.platform!=='win32')return [];
  if(windowsInstallsCache)return windowsInstallsCache;
  const found=[];
  for(const key of ['HKLM\\SOFTWARE\\Python\\PythonCore\\3.13\\InstallPath','HKCU\\SOFTWARE\\Python\\PythonCore\\3.13\\InstallPath','HKLM\\SOFTWARE\\WOW6432Node\\Python\\PythonCore\\3.13\\InstallPath']){
    try{
      const res=spawnSync('reg',['query',key,'/ve'],{encoding:'utf8',timeout:4000,windowsHide:true,stdio:['ignore','pipe','pipe']});
      if(res.status!==0||!res.stdout)continue;
      const match=res.stdout.match(/REG_SZ\s+(.+?)\s*$/m);
      if(!match)continue;
      const exe=path.join(match[1].trim(),'python.exe');
      if(fs.existsSync(exe)&&!found.includes(exe))found.push(exe);
    }catch{}
  }
  windowsInstallsCache=found;
  return found;
}
export function systemPythonCandidates(platform=process.platform,env=process.env){
  const list=[];
  const add=(exe,args=[],kind='system-path')=>{if(exe)list.push({exe,args,kind})};
  if(platform==='win32'){
    add('py',['-3.13'],'windows-launcher');
    for(const exe of windowsRegistryPythons())add(exe,[],'windows-registry');
    add('python3.13');add('python3');add('python');
    if(env.LOCALAPPDATA)add(path.win32.join(env.LOCALAPPDATA,'Programs','Python','Python313','python.exe'),[],'windows-install');
    add('C:\\Python313\\python.exe',[],'windows-install');
    add('C:\\Program Files\\Python313\\python.exe',[],'windows-install');
  }else{
    add('python3.13');add('python3');add('python');
    for(const exe of ['/usr/local/bin/python3.13','/usr/bin/python3.13','/opt/homebrew/bin/python3.13','/usr/local/bin/python3','/usr/bin/python3'])add(exe,[],'posix-install');
  }
  return list;
}

/**
 * Prefer a usable system interpreter (no download), then uv-managed Python.
 * `inVenv` interpreters are rejected unless the user configured one explicitly.
 */
export function detectSystemPython({uvBin='',uvEnv=process.env,customPath='',platform=process.platform}={}){
  const target=customPath||process.env.CHATGPT2API_PYTHON||process.env.DSH_CHATGPT2API_PYTHON||process.env.PYTHON;
  if(target){
    const probed=probePythonExecutable(target);
    if(isCompatiblePython(probed))return {...probed,source:'configured'};
  }
  for(const candidate of systemPythonCandidates(platform)){
    const probed=probePython(candidate.exe,candidate.args);
    if(!isCompatiblePython(probed)||probed.inVenv)continue;
    return {...probed,source:candidate.kind};
  }
  if(uvBin&&fs.existsSync(uvBin)){
    for(const req of ['>=3.13']){
      try{
        const res=spawnSync(uvBin,['python','find','--no-python-downloads',req],{
          encoding:'utf8',
          timeout:8000,
          windowsHide:true,
          env:{...uvEnv,UV_PYTHON_DOWNLOADS:'never'},
          stdio:['ignore','pipe','pipe']
        });
        if(res.status===0&&res.stdout){
          const found=res.stdout.trim();
          if(found&&fs.existsSync(found)){
            const probed=probePython(found);
            if(isCompatiblePython(probed)&&!probed.inVenv)return {...probed,source:'uv-discovery'};
          }
        }
      }catch{}
    }
  }
  return null;
}

export class PlatformBackend{
  constructor(config={},deps={}){
    this.os=deps.platform||process.platform;this.arch=deps.arch||process.arch;
    this.spec=resolvePlatform(this.os,this.arch,deps.libc||detectLinuxLibc());
    this.paths=managedPaths({root:config.dataDir,platform:this.os,arch:this.arch,libc:this.spec.libc||'gnu'});
    this.port=validatePort(config.port??process.env.CHATGPT2API_PORT??process.env.DSH_CHATGPT2API_PORT??DEFAULT_PORT);
    this.autoStart=config.autoStart!==false;
    this.configKey=config.apiKey;
    this.commands=new Set();
    this.downloader=deps.downloader||((url,file,options={})=>{
      if(this.stopping)return Promise.reject(Error('取消启动'));
      return downloadAsset(url,file,{...options,onSpawn:child=>{
        this.commands.add(child);
        child.once('close',()=>this.commands.delete(child));
      }});
    });
    this.extractZip=deps.extractZip||extractZipSafe;
    this.extractTar=deps.extractTar||extractUvTarGz;
    this.terminator=deps.executor||runCommand;
    this.executor=deps.executor||((bin,args,options={})=>{
      if(this.stopping)return Promise.reject(Error('取消启动'));
      return runCommand(bin,args,{...options,detached:this.os!=='win32',onSpawn:child=>{
        this.commands.add(child);
        child.once('close',()=>this.commands.delete(child));
      }});
    });
    this.fetcher=deps.fetcher||globalThis.fetch;
    this.spawner=deps.spawner||spawn;
    this.sleeper=deps.sleeper||((ms)=>new Promise(r=>setTimeout(r,ms)));
    this.portProbe=deps.portProbe||checkPortFree;
    this.groupKiller=deps.groupKiller||((pid,signal)=>process.kill(-pid,signal));
    this.configPython=config.pythonPath||process.env.CHATGPT2API_PYTHON||process.env.DSH_CHATGPT2API_PYTHON||'';
    this.probeInterpreter=deps.probeInterpreter||probePython;
    this.systemPythonFinder=deps.systemPythonFinder!==undefined?deps.systemPythonFinder:(deps.executor?null:detectSystemPython);
    this.detectedPython=null;
    this.phase='idle';this.message='尚未启动';this.error='';this.startPromise=null;this.stopping=false;this.child=null;
    this.adopted=false;this.restarts=0;
    this.maxRestarts=Number.isInteger(config.maxRestarts)?config.maxRestarts:3;
    this.restartDelays=Array.isArray(config.restartDelays)&&config.restartDelays.length?config.restartDelays:[2000,5000,15000];
    // The restart budget is only credited back after the service stayed up for a
    // while; otherwise a crash loop that briefly reports healthy would retry forever.
    this.stableMs=Number.isInteger(config.stableMs)?config.stableMs:30000;
    this.stabilityTimer=null;
  }
  _clearStability(){
    if(this.stabilityTimer){clearTimeout(this.stabilityTimer);this.stabilityTimer=null}
  }
  get baseUrl(){return `http://127.0.0.1:${this.port}`}
  status(){
    let runtime='private-python-3.13';
    const marker=path.join(this.paths.source,'.dsh-runtime-ready');
    if(fs.existsSync(marker)){
      try{
        const content=fs.readFileSync(marker,'utf8').trim();
        if(content.includes('system:')){
          const sysPath=content.split('system:')[1]?.trim()||'';
          runtime=`system-python (${sysPath?path.basename(sysPath):'host'})`;
        }else if(content.includes('managed')){
          runtime='managed-python-3.13';
        }
      }catch{}
    }else if(this.detectedPython?.path){
      runtime=`system-python (${path.basename(this.detectedPython.path)})`;
    }
    // A marker can be missing (older install, manual repair); the venv itself
    // still records which interpreter it was built on.
    if(runtime==='private-python-3.13'){
      try{
        const cfg=fs.readFileSync(path.join(this.paths.source,'.venv','pyvenv.cfg'),'utf8');
        const home=cfg.match(/^home\s*=\s*(.+)$/m)?.[1]?.trim();
        if(home)runtime=`venv on ${home}`;
      }catch{}
    }
    return {managed:true,runtime,platform:this.spec.tag,phase:this.phase,message:this.message,error:this.error,baseUrl:this.baseUrl,dataDir:this.paths.root,sourceCommit:SOURCE_COMMIT,adopted:this.adopted,restarts:this.restarts};
  }
  get uvEnv(){
    const env={...process.env};
    // Parent uv settings must not redirect sync to another project's environment.
    for(const key of Object.keys(env)){
      if(['UV_PROJECT','UV_WORKING_DIRECTORY'].includes(key.toUpperCase()))delete env[key];
    }
    const proxy=process.env.CHATGPT2API_DOWNLOAD_PROXY;
    if(proxy){
      checkedDownloadProxy(proxy);
      if(!env.HTTPS_PROXY&&!env.https_proxy)env.HTTPS_PROXY=proxy;
      if(!env.HTTP_PROXY&&!env.http_proxy)env.HTTP_PROXY=proxy;
    }
    return {...env,UV_PROJECT_ENVIRONMENT:path.join(this.paths.source,'.venv'),
      UV_PYTHON_INSTALL_BIN:'0',UV_PYTHON_INSTALL_REGISTRY:'0',
      UV_PYTHON_INSTALL_DIR:this.paths.python,UV_CACHE_DIR:this.paths.uvCache,UV_PYTHON_DOWNLOADS:'automatic',UV_NO_PROGRESS:'1',PYTHONDONTWRITEBYTECODE:'1',PYTHONUNBUFFERED:'1'}}
  /**
   * Optional, and off by default: inheriting the OS site-packages makes the
   * locked wheel set non-deterministic, so only users who deliberately want
   * their global GPU/CUDA packages should enable it.
   */
  get inheritSystemPackages(){return (process.env.CHATGPT2API_SYSTEM_SITE_PACKAGES??process.env.DSH_CHATGPT2API_SYSTEM_SITE_PACKAGES)==='1'}
  _readReadyMarker(){try{return fs.readFileSync(path.join(this.paths.source,'.dsh-runtime-ready'),'utf8').trim()}catch{return ''}}
  async start(){
    if(this.stopping)throw Error('服务正在停止');
    if(this.startPromise)return this.startPromise;
    this.error='';
    this.startPromise=this._start().catch(e=>{this.error=String(e?.message||e).slice(0,750);this.phase='error';this.message='启动失败，请检查网络或平台运行环境';throw e}).finally(()=>{this.startPromise=null});
    return this.startPromise;
  }
  async _setupUv(){
    if(fs.existsSync(this.paths.uv))return;
    this.phase='downloading';this.message=`下载已校验的 uv ${UV_VERSION}（${this.spec.tag}）`;
    const archive=path.join(this.paths.downloads,this.spec.filename);
    if(!fs.existsSync(archive))await this.downloader(this.spec.url,archive,{maxBytes:45000000,sha256:this.spec.sha256});
    // Cached archives are revalidated before extraction.
    const digest=crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    if(digest!==this.spec.sha256){fs.rmSync(archive,{force:true});throw Error('缓存的 uv SHA256 不匹配');}
    if(this.spec.filename.endsWith('.tar.gz'))this.extractTar(archive,this.paths.uv);
    else{
      const temp=path.join(this.paths.root,'unpack-uv');fs.rmSync(temp,{recursive:true,force:true});
      try{
        this.extractZip(archive,temp);
        const stack=[temp];let found=null;
        while(stack.length){const folder=stack.pop();for(const entry of fs.readdirSync(folder,{withFileTypes:true})){
          const full=path.join(folder,entry.name);if(entry.isDirectory())stack.push(full);else if(entry.name.toLowerCase()==='uv.exe')found=full;
        }}
        if(!found)throw Error('uv 归档缺少可执行文件');
        fs.mkdirSync(this.paths.runtime,{recursive:true});fs.copyFileSync(found,this.paths.uv);
      }finally{fs.rmSync(temp,{recursive:true,force:true});}
    }
    if(this.os!=='win32')fs.chmodSync(this.paths.uv,0o700);
  }
  async _setupSource(){
    if(fs.existsSync(this.paths.marker)&&fs.readFileSync(this.paths.marker,'utf8').trim()===SOURCE_COMMIT&&fs.existsSync(path.join(this.paths.source,'uv.lock')))return;
    if(fs.existsSync(this.paths.source)&&fs.readdirSync(this.paths.source).some(x=>x!=='data'))throw Error('发现不完整或不同版本源码，请备份后手动检查 source 目录（程序不会覆盖）');
    this.phase='downloading';this.message='下载固定提交的 chatgpt2api 后端源码';
    const zip=path.join(this.paths.downloads,`chatgpt2api-${SOURCE_COMMIT}.zip`);
    if(!fs.existsSync(zip))await this.downloader(SOURCE_URL,zip,{maxBytes:35000000});
    const temp=path.join(this.paths.root,'unpack-source');fs.rmSync(temp,{recursive:true,force:true});
    try{
      this.extractZip(zip,temp);
      const folder=path.join(temp,`chatgpt2api-${SOURCE_COMMIT}`);
      if(!fs.existsSync(folder))throw Error('固定版本源码目录不匹配');
      for(const file of ['pyproject.toml','uv.lock','main.py','api','services','utils'])if(!fs.existsSync(path.join(folder,file)))throw Error('源码归档缺少 '+file);
      fs.mkdirSync(this.paths.source,{recursive:true});fs.cpSync(folder,this.paths.source,{recursive:true,force:true});
      fs.mkdirSync(this.paths.data,{recursive:true,mode:0o700});
      fs.writeFileSync(this.paths.marker,SOURCE_COMMIT+'\n');
    }finally{fs.rmSync(temp,{recursive:true,force:true});}
  }
  /** Install a versioned wrapper outside the pinned upstream code. */
  _installImageApiEntrypoint(){
    const src=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../scripts/dsh_backend_entry.py');
    const dest=path.join(this.paths.source,'dsh_backend_entry.py');
    // Source integrity is checked by _setupSource; allow injected test runtimes without main.py.
    // Test fixtures may omit all upstream modules; production snapshots must have all files.
    if(fs.existsSync(path.join(this.paths.source,'api','ai.py'))){
      installPoolGifBackendPatch(this.paths.source);
      installImageErrorBackendPatch(this.paths.source);
      installImageApiContractPatch(this.paths.source);
      installImageTaskBackendPatch(this.paths.source);
    }
    const data=fs.readFileSync(src);
    if(!fs.existsSync(dest)||!fs.readFileSync(dest).equals(data))fs.writeFileSync(dest,data,{mode:0o600});
  }
  async _installPython(){
    const marker=path.join(this.paths.source,'.dsh-runtime-ready');
    const venv=path.join(this.paths.source,'.venv');
    const python=path.join(venv,this.spec.pythonRelative);
    const previous=this._readReadyMarker();
    const recordedSystem=previous.includes('system:')?(previous.split('system:')[1]||'').trim():'';

    // "Ready" must mean runnable: a marker plus a python.exe says nothing about
    // site-packages, which is exactly how a lazy `anyio` import broke image
    // generation while /health kept reporting success. A venv can also survive
    // an OS Python uninstall with every file in place yet refuse to execute, so
    // the interpreter itself is probed before trusting the directory.
    let venvExists=fs.existsSync(python);
    if(venvExists&&!isCompatiblePython(this.probeInterpreter(python))){
      await this.sleeper(300);
      if(!isCompatiblePython(this.probeInterpreter(python))){
        this.phase='installing';this.message='虚拟环境无法运行或 Python 版本低于 3.13，正在重建…';
        try{fs.rmSync(venv,{recursive:true,force:true})}catch(error){
          throw new Error(`无法重建 Python 运行环境：${venv}。请检查目录写入权限或是否被其他程序占用。`,{cause:error});
        }
        venvExists=false;
      }
    }

    const issue=pythonEnvIssue(this.paths,this.spec);
    if(!issue){
      if(!previous)fs.writeFileSync(marker,`${new Date().toISOString()} ${this.spec.tag} reused\n`);
      return;
    }

    if(venvExists){
      // Repair in place: keep the pinned interpreter, skip the interpreter
      // search and venv creation entirely.
      const keep=recordedSystem?`system:${recordedSystem}`:previous.includes('managed')?'managed-3.13':'repaired';
      this.phase='installing';this.message=`Python 依赖不完整（${issue.message}），正在修复…`;
      await this.executor(this.paths.uv,['sync','--frozen','--no-dev','--no-install-project'],{cwd:this.paths.source,env:this.uvEnv,timeoutMs:1500000});
      this._confirmPython(venv,marker,keep);
      return;
    }

    const detected=typeof this.systemPythonFinder==='function'
      ? this.systemPythonFinder({uvBin:this.paths.uv,uvEnv:this.uvEnv,customPath:this.configPython})
      : null;

    if(detected&&detected.path){
      this.phase='installing';
      this.message=`使用系统 Python ${detected.version||''}（${path.basename(detected.path)}）创建隔离环境（无需下载 Python）…`;
      this.detectedPython=detected;
      const venvArgs=['venv'];
      if(this.inheritSystemPackages)venvArgs.push('--system-site-packages');
      venvArgs.push('--python',detected.path,venv);
      try{
        await this.executor(this.paths.uv,venvArgs,{cwd:this.paths.source,env:{...this.uvEnv,UV_PYTHON_DOWNLOADS:'never'},timeoutMs:300000});
      }catch{}
      await this.executor(
        this.paths.uv,
        ['sync','--frozen','--no-dev','--no-install-project','--python',detected.path],
        {cwd:this.paths.source,env:{...this.uvEnv,UV_PYTHON_DOWNLOADS:'never'},timeoutMs:1500000}
      );
      if(!fs.existsSync(python))throw Error(`无法用系统 Python 创建虚拟环境：${python}。请设置 CHATGPT2API_PYTHON 指向可用的 Python 3.13。`);
      this._confirmPython(venv,marker,`system:${detected.path}`);
      return;
    }

    this.phase='installing';
    this.message='未检测到可用系统 Python，正在下载轻量隔离 Python 3.13 与依赖…';
    await this.executor(this.paths.uv,['python','install','3.13','--no-bin','--no-registry'],{env:this.uvEnv,timeoutMs:1200000});
    await this.executor(
      this.paths.uv,
      ['sync','--frozen','--no-dev','--no-install-project','--python','3.13'],
      {cwd:this.paths.source,env:this.uvEnv,timeoutMs:1500000}
    );
    if(!fs.existsSync(python))throw Error('未找到隔离 Python 虚拟环境：'+python);
    this._confirmPython(venv,marker,'managed-3.13');
  }
  /** Trust the environment only after checking it, never the command exit code alone. */
  _confirmPython(venv,marker,suffix='repaired'){
    const issue=pythonEnvIssue(this.paths,this.spec);
    if(issue)throw Error(`Python 运行环境不可用（${issue.message}）。请运行 npm run repair 修复运行环境，并重新启动程序；虚拟环境位置：${venv}。`);
    fs.writeFileSync(marker,`${new Date().toISOString()} ${this.spec.tag} ${suffix}\n`);
  }
  /** Public repair path used by scripts/manage-backend.mjs; never starts the API. */
  async repair(){
    this.phase='repairing';this.message='检查并修复本机 Python 运行环境…';
    await this._setupUv();
    await this._setupSource();
    this._installImageApiEntrypoint();
    await this._installPython();
    this.phase='stopped';this.message='Python 运行环境已就绪';
    return this.status();
  }
  /**
   * Detect a backend that is already serving on our port. /health is public, so
   * it only proves "something answers"; an authenticated /api/accounts call with
   * the Host's internal key proves it is *our* install and is safe to reuse.
   */
  async _probeExisting(){
    let health=null;
    try{
      const r=await this.fetcher(this.baseUrl+'/health?format=json',{signal:AbortSignal.timeout(2500)});
      if(r?.ok){const data=await r.json().catch(()=>null);if(data&&typeof data.status==='string')health=data}
    }catch{}
    if(!health)return null;
    try{
      const r=await this.fetcher(this.baseUrl+'/api/accounts',{headers:{Authorization:`Bearer ${this.key}`,'Accept':'application/json'},signal:AbortSignal.timeout(4000),redirect:'error'});
      if(r?.ok)return {health,auth:true};
      return {health,auth:false,status:r?.status};
    }catch{return {health,auth:false,status:0}}
  }
  async _start(){
    if(!this.autoStart){this.phase='disabled';this.message='自动启动已关闭';return this.status()}
    this.adopted=false;
    this.key=ensureManagedFiles(this.paths,this.configKey??(process.env.CHATGPT2API_KEY||process.env.DSH_CHATGPT2API_KEY||''));
    // A backend orphaned by a crashed DSH still serves correctly; adopting it
    // avoids a false "port in use" failure and a second Python process.
    const existing=await this._probeExisting();
    if(existing?.auth){
      this.phase='ready';this.error='';this.adopted=true;
      this.message='已接管正在运行的本机号池 API';
      return this.status();
    }
    if(existing){
      const message=`端口 ${this.port} 上有另一个 chatgpt2api 服务（内部密钥不同），无法接管。请关闭它，或设置 CHATGPT2API_PORT（兼容 DSH_CHATGPT2API_PORT）使用其他端口。`;
      this.phase='error';this.error=message;throw Error(message);
    }
    await this._setupUv();if(this.stopping)throw Error('取消启动');
    await this._setupSource();if(this.stopping)throw Error('取消启动');
    this._installImageApiEntrypoint();
    await this._installPython();if(this.stopping)throw Error('取消启动');
    this.phase='starting';this.message='启动本机号池 API';
    await this.portProbe(this.port);
    const env={...this.uvEnv,CHATGPT2API_AUTH_KEY:this.key,STORAGE_BACKEND:'sqlite',DSH_IMAGE_PREFERENCES_FILE:path.join(this.paths.root,'image-preferences.json'),DSH_API_HISTORY_DIR:path.join(this.paths.root,'api-request-history')};
    const args=['run','--no-sync','uvicorn','dsh_backend_entry:app','--host','127.0.0.1','--port',String(this.port),'--no-access-log'];
    const child=this.spawner(this.paths.uv,args,{cwd:this.paths.source,env,windowsHide:true,shell:false,detached:this.os!=='win32',stdio:['ignore','pipe','pipe']});
    this.child=child;
    const receive=b=>{const txt=String(b).replaceAll(this.key,'[REDACTED]');try{fs.appendFileSync(this.paths.logs,txt,{mode:0o600})}catch{}};
    child.stdout?.on('data',receive);child.stderr?.on('data',receive);
    child.on('error',e=>{if(!this.stopping){this.phase='error';this.error='服务启动失败：'+e.message}});
    child.on('close',code=>{
      if(this.stopping)return;
      this.child=null;
      this._clearStability();
      // An unexpected exit (OOM, antivirus, crashed interpreter) must not leave
      // the panel dead until the user restarts DSH; retry a bounded number of times.
      if(this.restarts<this.maxRestarts){
        const delay=this.restartDelays[Math.min(this.restarts,this.restartDelays.length-1)];
        this.restarts+=1;
        this.phase='restarting';
        this.message=`后端进程退出（退出码 ${code}），${Math.round(delay/1000)} 秒后自动重启（第 ${this.restarts}/${this.maxRestarts} 次）`;
        this.sleeper(delay).then(async()=>{
          if(this.stopping)return;
          // A crash during startup leaves an in-flight start(); wait for it to
          // settle so the relaunch is not silently swallowed by the guard.
          if(this.startPromise)await this.startPromise.catch(()=>{});
          if(this.stopping||this.child)return;
          try{await this.start()}catch{}
        });
      }else{
        this.phase='error';
        this.error=`后端进程反复退出（退出码 ${code}），已停止自动重启。请重新启动程序，或查看 ${this.paths.logs}`;
      }
    });
    for(let i=0;i<100;i++){
      if(this.stopping)throw Error('取消启动');
      if(this.phase==='error')throw Error(this.error);
      try{
        const r=await this.fetcher(this.baseUrl+'/health?format=json',{signal:AbortSignal.timeout(1500)});
        if(r.ok){const value=await r.json();if(typeof value.status==='string'){
          this.phase='ready';this.message='服务已就绪，可被本机 OpenAI 兼容客户端调用';
          this._clearStability();
          this.stabilityTimer=setTimeout(()=>{this.restarts=0;this.stabilityTimer=null},this.stableMs);
          this.stabilityTimer.unref?.();
          return this.status();
        }}
      }catch{}
      await this.sleeper(800);
    }
    throw Error('后端启动超时，请检查 '+this.paths.logs);
  }
  async stop(){
    if(this.stopPromise)return this.stopPromise;
    this.stopping=true;
    this._clearStability();
    this.stopPromise=this._stopOwnedProcess();
    return this.stopPromise;
  }
  async _stopOwnedProcess(){
    // Include uv provisioning commands so Ctrl+C during setup leaves no child.
    const children=new Set(this.commands);
    if(this.child)children.add(this.child);
    await Promise.allSettled([...children].map(child=>this._stopChild(child)));
    this.child=null;
    this.phase='stopped';
    this.message=this.adopted?'已停止托管（正在运行的后端不属于本实例，未终止）':'已停止，号池账号和 API Key 保留';
  }
  async _stopChild(child){
    // Register before signalling: a short-lived process can close immediately.
    // ChildProcess.exitCode is null while running; test doubles may omit it.
    if(child.exitCode!==null&&child.exitCode!==undefined)return;
    let onClose;
    const closed=new Promise(resolve=>{onClose=()=>resolve(true);child.once('close',onClose)});
    const pid=child.pid;
    if(this.os==='win32'&&Number.isInteger(pid)){
      try{await this.terminator('taskkill.exe',['/PID',String(pid),'/T','/F'],{timeoutMs:16000})}catch{try{child.kill()}catch{}}
    }else if(Number.isInteger(pid)){
      try{this.groupKiller(pid,'SIGTERM')}catch{try{child.kill('SIGTERM')}catch{}}
    }else try{child.kill('SIGTERM')}catch{}
    if(child.exitCode===null){
      let timer;
      const finished=await Promise.race([closed,new Promise(resolve=>{timer=setTimeout(()=>resolve(false),5000)})]);
      clearTimeout(timer);
      if(!finished){
        // Kill the uv/uvicorn process group owned by this instance.
        if(this.os!=='win32'&&Number.isInteger(pid)){
          try{this.groupKiller(pid,'SIGKILL')}catch{try{child.kill('SIGKILL')}catch{}}
        }else try{child.kill('SIGKILL')}catch{}
        await Promise.race([closed,new Promise(resolve=>{timer=setTimeout(resolve,1000)})]);
        clearTimeout(timer);
      }
    }
    child.removeListener('close',onClose);
  }
}
