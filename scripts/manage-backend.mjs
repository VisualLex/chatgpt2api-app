/** Standalone status/repair CLI; the existing DSH data directory remains opt-in. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PlatformBackend,managedPaths,resolvePlatform,DEFAULT_PORT,pythonEnvIssue,detectSystemPython,validatePort} from '../lib/platform-backend.js';

const usage=`用法：node scripts/manage-backend.mjs [status|check|repair|log|start] [选项]
  --data-dir <目录>  数据目录（默认 ~/.chatgpt2api）
  --port <端口>      后端 API 端口（默认 38650）
  --python <路径>    指定 Python 3.13 解释器
  --help             显示帮助
完整管理页面请运行 npm start。`;
let cmd='status',dataDir=process.env.CHATGPT2API_HOME||process.env.DSH_CHATGPT2API_HOME||path.join(os.homedir(),'.chatgpt2api');
let port=process.env.CHATGPT2API_PORT||process.env.DSH_CHATGPT2API_PORT||DEFAULT_PORT;
let pythonPath=process.env.CHATGPT2API_PYTHON||process.env.DSH_CHATGPT2API_PYTHON||'';
let wantsHelp=false;
try{
  const args=process.argv.slice(2);
  if(args[0]&&!args[0].startsWith('--'))cmd=args.shift();
  for(let i=0;i<args.length;i++){
    const flag=args[i];
    if(flag==='--help'){wantsHelp=true;continue}
    if(!['--data-dir','--port','--python'].includes(flag)||!args[i+1]||args[i+1].startsWith('--'))throw Error(`参数无效：${flag}`);
    const value=args[++i];
    if(flag==='--data-dir')dataDir=value;
    else if(flag==='--port')port=value;
    else pythonPath=value;
  }
  if(!['status','check','repair','log','start'].includes(cmd))throw Error(`未知命令：${cmd}`);
  port=validatePort(port);
}catch(e){console.error(e.message+'\n'+usage);process.exit(2)}
if(wantsHelp){console.info(usage);process.exit(0)}
const paths=managedPaths({root:dataDir});
const url=`http://127.0.0.1:${port}`;
const spec=resolvePlatform();
if(cmd==='status'){
  console.info('API 本机地址：',url+'/v1');
  console.info('持久化数据目录：',paths.root);
  console.info('已下载 uv：',fs.existsSync(paths.uv));
  console.info('已下载源码：',fs.existsSync(paths.marker));
  const readyMarker=path.join(paths.source,'.dsh-runtime-ready');
  const readyInfo=fs.existsSync(readyMarker)?fs.readFileSync(readyMarker,'utf8').trim():'';
  const issue=pythonEnvIssue(paths,spec);
  console.info('Python 运行环境：',issue?`不可用（${issue.message}）`:(readyInfo.includes('system:')?'系统已有 Python ('+readyInfo.split('system:')[1]?.trim()+')':(readyInfo.includes('managed')?'轻量隔离 Python 3.13':'已就绪')));
  const system=detectSystemPython({uvBin:paths.uv,customPath:pythonPath});
  console.info('系统可用 Python：',system?`${system.version}（${system.path}，来源 ${system.source}）`:'未找到 3.13 系统解释器，将使用托管 Python');
  try{const r=await fetch(url+'/health?format=json',{signal:AbortSignal.timeout(3000)});if(!r.ok)throw Error(`HTTP ${r.status}`);const j=await r.json();console.log('后端健康状态：',JSON.stringify({status:j.status,healthy:j.healthy,version:j.version,accounts:j.accounts&&{total:j.accounts.total,active:j.accounts.active}},null,2))}catch(e){console.error('后端未就绪：',e.message);process.exitCode=1}
}else if(cmd==='log'){
  console.info('后端日志：'+paths.logs);
  if(fs.existsSync(paths.logs))console.log(fs.readFileSync(paths.logs,'utf8').slice(-8000));else console.info('尚未生成日志：'+paths.logs);
}else if(cmd==='repair'){
  const manager=new PlatformBackend({port,dataDir:paths.root,pythonPath,autoStart:false});
  try{const stat=await manager.repair();console.log('Python 运行环境已修复：',stat.runtime)}catch(e){console.error('修复失败：'+e.message);process.exitCode=1}
}else if(cmd==='check'){
  const issue=pythonEnvIssue(paths,spec);
  if(issue){console.error('运行环境不可用：'+issue.message);process.exitCode=1}
  else console.log('运行环境检查通过：解释器、site-packages 与关键依赖齐全');
}else if(cmd==='start'){
  const manager=new PlatformBackend({port,dataDir:paths.root,pythonPath});
  let stopping=false;
  const stop=async()=>{if(stopping)return;stopping=true;await manager.stop();process.exit(0)};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
  try{const stat=await manager.start();console.log('后端已启动，按 Ctrl+C 停止：',stat.baseUrl+'/v1');
    // An adopted backend has no child handle; keep foreground mode alive too.
    setInterval(()=>{},60000);
  }catch(e){console.error('启动失败：'+e.message);await manager.stop();process.exitCode=1}
}
