/** Durable local task queue. Runners belong to the host, never to a browser request. */
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID, randomBytes, createHash} from 'node:crypto';

const ACTIVE=new Set(['queued','running']);
const TERMINAL=new Set(['succeeded','partial','failed','interrupted']);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIME_EXT=new Map([['image/png','.png'],['image/jpeg','.jpg'],['image/webp','.webp'],['image/gif','.gif']]);
const MAX_FILE_BYTES=32*1024*1024;
const SECRET_FIELD=/^(?:token|access_?token|refresh_?token|id_?token|password|totp_?secret|2fa|authorization|cookie|secret_?key|api_?key|b64_json)$/i;
function fault(message,status=400){return Object.assign(new Error(message),{status})}
function clone(value){return JSON.parse(JSON.stringify(value))}
function validId(value){if(typeof value!=='string'||!UUID.test(value))throw fault('任务或文件编号无效');return value}
function cleanError(value){return typeof value==='string'?value.slice(0,350):''}
function jsonValue(value,label,maxBytes=128*1024){
  const ancestors=new Set();
  function check(current,depth){
    if(depth>12)throw fault(`${label}层级过多`);
    if(current===null||typeof current==='string'||typeof current==='boolean')return;
    if(typeof current==='number'&&Number.isFinite(current))return;
    if(typeof current!=='object'||ancestors.has(current))throw fault(`${label}必须为 JSON 数据`);
    ancestors.add(current);
    if(Array.isArray(current)){
      if(current.length>10000)throw fault(`${label}项目过多`);
      for(const item of current)check(item,depth+1);
    }else{
      if(Object.getPrototypeOf(current)!==Object.prototype&&Object.getPrototypeOf(current)!==null)throw fault(`${label}必须为普通对象`);
      for(const [key,item] of Object.entries(current)){
        if(SECRET_FIELD.test(key))throw fault(`${label}不能保存凭据或图片原始数据`);
        check(item,depth+1);
      }
    }
    ancestors.delete(current);
  }
  check(value,0);
  const encoded=JSON.stringify(value);
  if(Buffer.byteLength(encoded)>maxBytes)throw fault(`${label}过大`);
  return JSON.parse(encoded);
}
function canonical(value){
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
  return JSON.stringify(value);
}
function matchesImage(data,mime){
  if(mime==='image/png')return data.length>=8&&data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if(mime==='image/jpeg')return data.length>=3&&data[0]===255&&data[1]===216&&data[2]===255;
  if(mime==='image/gif')return data.length>=13&&['GIF87a','GIF89a'].includes(data.subarray(0,6).toString('ascii'));
  return mime==='image/webp'&&data.length>=12&&data.subarray(0,4).toString('ascii')==='RIFF'&&data.subarray(8,12).toString('ascii')==='WEBP';
}
function fileDescriptor(file){return {id:file.id,mimeType:file.mimeType,size:file.size,role:file.role}}
function summaryResult(result){
  if(!result||typeof result!=='object'||Array.isArray(result))return result;
  return Object.fromEntries(Object.entries(result).flatMap(([key,value])=>{
    if(['number','boolean'].includes(typeof value)||value===null)return [[key,value]];
    if(typeof value==='string')return [[key,value.slice(0,300)]];
    if(key==='usage'&&value&&typeof value==='object'&&!Array.isArray(value))return [[key,Object.fromEntries(Object.entries(value).filter(([,count])=>typeof count==='number'&&Number.isFinite(count)&&count>=0))]];
    if(key==='files'&&Array.isArray(value))return [[key,value.filter(file=>file&&UUID.test(file.id)&&MIME_EXT.has(file.mimeType)).map(fileDescriptor)]];
    return [];
  }));
}

export class TaskHistory {
  constructor({root,maxTasks=1000,concurrency=1}={}){
    if(!Number.isInteger(maxTasks)||maxTasks<1||maxTasks>10000)throw fault('任务保留数量无效');
    if(!Number.isInteger(concurrency)||concurrency<1||concurrency>8)throw fault('任务并发数量无效');
    this.root=root?path.resolve(root):null;
    this.filePath=this.root?path.join(this.root,'task-history.json'):null;
    this.filesDir=this.root?path.join(this.root,'task-files'):null;
    this.apiHistoryDir=this.root?path.join(this.root,'api-request-history'):null;
    this.apiRecordsCache=new Map();
    this.maxTasks=maxTasks;this.concurrency=concurrency;
    this.tasks=new Map();this.files=new Map();this.requests=new Map();this.memoryFiles=new Map();
    this.queue=[];this.active=0;this.scheduled=false;this.idleWaiters=[];
    if(this.root){
      fs.mkdirSync(this.root,{recursive:true,mode:0o700});
      this._load();
    }
  }
  _load(){
    let stat;
    try{stat=fs.lstatSync(this.filePath)}catch(error){if(error.code==='ENOENT')return;throw error}
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>256*1024*1024)throw fault('任务历史文件无效，未自动覆盖',500);
    let saved;
    try{saved=JSON.parse(fs.readFileSync(this.filePath,'utf8'))}catch{throw fault('任务历史文件损坏，未自动覆盖',500)}
    if(saved?.version!==1||!Array.isArray(saved.tasks)||!Array.isArray(saved.files)||!Array.isArray(saved.requests))throw fault('任务历史格式无效，未自动覆盖',500);
    const now=new Date().toISOString();let changed=false;
    try{
      for(const task of saved.tasks){
        validId(task.id);
        if(!ACTIVE.has(task.status)&&!TERMINAL.has(task.status))throw Error('status');
        const clean=jsonValue(task,'任务记录',512*1024);
        if(ACTIVE.has(clean.status)){
          clean.status='interrupted';clean.finishedAt=now;
          clean.error='程序已重启，任务结果未知；请核对结果后再重试。';changed=true;
        }
        this.tasks.set(clean.id,clean);
      }
      for(const file of saved.files){
        validId(file.id);
        if(!MIME_EXT.has(file.mimeType)||!['input','result'].includes(file.role)||!Number.isInteger(file.size)||file.size<1||file.size>MAX_FILE_BYTES)throw Error('file');
        this.files.set(file.id,fileDescriptor(file));
      }
      for(const entry of saved.requests){
        if(!this._requestId(entry.requestId)||typeof entry.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(entry.fingerprint)||typeof entry.taskId!=='string'||!UUID.test(entry.taskId)||entry.requestHash!==null&&entry.requestHash!==undefined&&(typeof entry.requestHash!=='string'||!/^[a-f0-9]{64}$/.test(entry.requestHash)))throw Error('request');
        this.requests.set(entry.requestId,{taskId:entry.taskId,fingerprint:entry.fingerprint,requestHash:entry.requestHash||null});
      }
    }catch{throw fault('任务历史内容无效，未自动覆盖',500)}
    const trimmed=this._trim(this.tasks);
    if(changed||trimmed.size!==this.tasks.size)this._commit(trimmed,this.files,this.requests);
  }
  _requestId(value){
    if(value===undefined||value===null||value==='')return null;
    if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value))throw fault('任务请求编号无效');
    return value;
  }
  _trim(tasks){
    const next=new Map(tasks);
    for(const task of next.values()){
      if(next.size<=this.maxTasks)break;
      if(TERMINAL.has(task.status))next.delete(task.id);
    }
    if(next.size>this.maxTasks)throw fault('待处理任务已满，请等待现有任务结束',429);
    return next;
  }
  _persist(tasks,files,requests){
    if(!this.filePath)return;
    try{if(fs.lstatSync(this.filePath).isSymbolicLink())throw fault('任务历史路径不可使用符号链接',500)}catch(error){if(error.code!=='ENOENT')throw error}
    const tmp=this.filePath+'.'+randomBytes(6).toString('hex')+'.tmp';
    const document={version:1,tasks:[...tasks.values()],files:[...files.values()],requests:[...requests].map(([requestId,entry])=>({requestId,...entry}))};
    try{
      fs.writeFileSync(tmp,JSON.stringify(document),{mode:0o600,flag:'wx'});
      fs.renameSync(tmp,this.filePath);
    }finally{try{fs.rmSync(tmp,{force:true})}catch{}}
  }
  _commit(tasks,files=this.files,requests=this.requests){
    this._persist(tasks,files,requests);
    this.tasks=tasks;this.files=files;this.requests=requests;
  }
  _replace(task){const next=new Map(this.tasks);next.set(task.id,task);this._commit(next);return clone(task)}
  findByRequestId(requestId,requestHash){
    const key=this._requestId(requestId);
    if(!key)return null;
    if(requestHash!==undefined&&(typeof requestHash!=='string'||!/^[a-f0-9]{64}$/.test(requestHash)))throw fault('任务请求摘要无效');
    const entry=this.requests.get(key);
    if(!entry)return null;
    if(requestHash!==undefined&&entry.requestHash!==requestHash)throw fault('任务请求编号已用于不同内容',409);
    const task=this.tasks.get(entry.taskId);
    if(!task)throw fault('原任务记录已移除，请使用新的请求编号',410);
    return clone(task);
  }
  submit({type,summary='',params={},requestId,parentTaskId=null,requestHash}={},runner){
    if(typeof type!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(type))throw fault('任务类型无效');
    if(typeof summary!=='string'||summary.length>300)throw fault('任务摘要过长');
    if(typeof runner!=='function')throw fault('缺少任务执行器');
    if(parentTaskId!==null)validId(parentTaskId);
    const safeParams=jsonValue(params,'任务参数');
    if(!safeParams||Array.isArray(safeParams)||typeof safeParams!=='object')throw fault('任务参数必须为对象');
    const key=this._requestId(requestId);
    if(requestHash!==undefined&&(typeof requestHash!=='string'||!/^[a-f0-9]{64}$/.test(requestHash)))throw fault('任务请求摘要无效');
    const fingerprint=createHash('sha256').update(canonical(requestHash===undefined?{type,summary,params:safeParams,parentTaskId}:{type,requestHash,parentTaskId})).digest('hex');
    if(key&&this.requests.has(key)){
      if(this.requests.get(key).fingerprint!==fingerprint)throw fault('任务请求编号已用于不同内容',409);
      return this.findByRequestId(key,requestHash);
    }
    const task={id:randomUUID(),type,summary,status:'queued',params:safeParams,progress:{},result:null,files:[],createdAt:new Date().toISOString(),startedAt:null,finishedAt:null,error:'',parentTaskId};
    const next=new Map(this.tasks);next.set(task.id,task);
    const tasks=this._trim(next),requests=new Map(this.requests);
    if(key)requests.set(key,{taskId:task.id,fingerprint,requestHash:requestHash||null});
    this._commit(tasks,this.files,requests);
    this.queue.push({id:task.id,runner});this._schedule();
    return clone(task);
  }
  updateParams(id,params){
    const task=this.get(id);
    if(task.status!=='queued')throw fault('只能更新尚未开始的任务参数',409);
    const value=jsonValue(params,'任务参数');
    if(!value||Array.isArray(value)||typeof value!=='object')throw fault('任务参数必须为对象');
    return this._replace({...task,params:value});
  }
  failQueued(id,error='任务准备失败，请重新提交'){
    const task=this.get(id);
    if(task.status!=='queued')throw fault('任务已经开始，不能撤回准备步骤',409);
    const result=this._replace({...task,status:'failed',finishedAt:new Date().toISOString(),error:cleanError(error)});
    this.queue=this.queue.filter(job=>job.id!==id);this._notifyIdle();return result;
  }
  _apiDirectory(){
    if(!this.apiHistoryDir)return false;
    try{
      const info=fs.lstatSync(this.apiHistoryDir);
      if(info.isSymbolicLink()||!info.isDirectory())throw fault('API 请求记录目录无效',500);
      return true;
    }catch(error){if(error.code==='ENOENT')return false;throw error}
  }
  _apiTask(id){
    if(!this._apiDirectory())return null;
    let fd;
    try{
      const filename=path.join(this.apiHistoryDir,id+'.json'),info=fs.lstatSync(filename);
      if(info.isSymbolicLink()||!info.isFile()||info.size>128*1024)return null;
      const cached=this.apiRecordsCache.get(id);
      if(cached&&cached.mtime===info.mtimeMs&&cached.size===info.size&&cached.ino===info.ino)return cached.task;
      fd=fs.openSync(filename,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
      const opened=fs.fstatSync(fd);
      if(!opened.isFile()||opened.size>128*1024||opened.ino!==info.ino)return null;
      const task=jsonValue(JSON.parse(fs.readFileSync(fd,'utf8')),'API 请求记录');
      if(task.id!==id||task.type!=='api_request'||!ACTIVE.has(task.status)&&!TERMINAL.has(task.status))return null;
      if(typeof task.summary!=='string'||task.summary.length>300||typeof task.createdAt!=='string'||!Number.isFinite(Date.parse(task.createdAt)))return null;
      if(!task.params||Array.isArray(task.params)||typeof task.params!=='object'||!Array.isArray(task.files)||task.files.length>8)return null;
      if(task.files.some(file=>!file||typeof file.id!=='string'||!UUID.test(file.id)||!MIME_EXT.has(file.mimeType)||file.role!=='result'||!Number.isInteger(file.size)||file.size<1||file.size>MAX_FILE_BYTES))return null;
      if(task.result?.files&&(!Array.isArray(task.result.files)||task.result.files.some(file=>!task.files.some(registered=>JSON.stringify(fileDescriptor(registered))===JSON.stringify(fileDescriptor(file))))))return null;
      this.apiRecordsCache.set(id,{mtime:info.mtimeMs,size:info.size,ino:info.ino,task});
      return task;
    }catch{return null}finally{if(fd!==undefined)fs.closeSync(fd)}
  }
  _apiTasks(){
    if(!this._apiDirectory())return [];
    const ids=new Set(fs.readdirSync(this.apiHistoryDir).filter(name=>name.endsWith('.json')&&UUID.test(name.slice(0,-5))).map(name=>name.slice(0,-5)));
    for(const id of this.apiRecordsCache.keys())if(!ids.has(id))this.apiRecordsCache.delete(id);
    return [...ids].flatMap(id=>{
      const task=this._apiTask(id);return task?[task]:[];
    });
  }
  get(id){validId(id);const task=this.tasks.get(id)||this._apiTask(id);if(!task)throw fault('任务记录不存在',404);return clone(task)}
  list({page=1,pageSize=20,type,status,from,to}={}){
    page=Number(page);pageSize=Number(pageSize);
    if(!Number.isInteger(page)||page<1||!Number.isInteger(pageSize)||pageSize<1||pageSize>100)throw fault('任务分页参数无效');
    if(type&&(!/^[a-z][a-z0-9_]{0,63}$/.test(type)))throw fault('任务筛选类型无效');
    if(status&&!ACTIVE.has(status)&&!TERMINAL.has(status))throw fault('任务筛选状态无效');
    const dateBound=(value,end)=>{
      if(value===undefined||value===null||value==='')return null;
      if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value))throw fault('任务日期筛选无效');
      const stamp=Date.parse(value.length===10?value+(end?'T23:59:59.999Z':'T00:00:00.000Z'):value);
      if(!Number.isFinite(stamp)||value.length===10&&new Date(stamp).toISOString().slice(0,10)!==value)throw fault('任务日期筛选无效');return stamp;
    };
    const start=dateBound(from,false),end=dateBound(to,true);
    if(start!==null&&end!==null&&start>end)throw fault('任务开始日期晚于结束日期');
    const all=[...this.tasks.values()].reverse().concat(!type||type==='api_request'?this._apiTasks():[]).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)).filter(task=>(!type||task.type===type)&&(!status||task.status===status)&&(start===null||Date.parse(task.createdAt)>=start)&&(end===null||Date.parse(task.createdAt)<=end));
    const pageCount=Math.max(1,Math.ceil(all.length/pageSize));page=Math.min(page,pageCount);
    const items=all.slice((page-1)*pageSize,page*pageSize).map(task=>{const {params,...item}=task;return {...item,result:summaryResult(task.result)}});
    return clone({items,total:all.length,page,pageSize,pageCount});
  }
  delete(id){
    const task=this.get(id);if(ACTIVE.has(task.status))throw fault('进行中的任务不能删除',409);
    if(!this.tasks.has(id)){fs.unlinkSync(path.join(this.apiHistoryDir,id+'.json'));this.apiRecordsCache.delete(id);return {removed:1};}
    const next=new Map(this.tasks);next.delete(id);this._commit(next);return {removed:1};
  }
  _ensureFilesDir(){
    fs.mkdirSync(this.filesDir,{recursive:true,mode:0o700});
    const stat=fs.lstatSync(this.filesDir);
    if(stat.isSymbolicLink()||!stat.isDirectory())throw fault('任务文件目录不可使用符号链接',500);
    return fs.realpathSync(this.filesDir);
  }
  addFile(taskId,{data,mimeType,role='result'}={}){
    const task=this.get(taskId);
    if(!ACTIVE.has(task.status))throw fault('已结束任务不能新增文件',409);
    if(!Buffer.isBuffer(data)||!data.length||data.length>MAX_FILE_BYTES)throw fault('任务文件为空或超过 32MB');
    if(!MIME_EXT.has(mimeType)||!matchesImage(data,mimeType))throw fault('任务文件格式无效，仅支持 PNG/JPEG/WebP/GIF');
    if(!['input','result'].includes(role))throw fault('任务文件用途无效');
    const file={id:randomUUID(),mimeType,size:data.length,role},files=new Map(this.files);files.set(file.id,file);
    const next=new Map(this.tasks);next.set(taskId,{...task,files:[...task.files,file]});
    let filename;
    if(this.filesDir){
      filename=path.join(this._ensureFilesDir(),file.id+MIME_EXT.get(mimeType));
      fs.writeFileSync(filename,data,{mode:0o600,flag:'wx'});
    }
    try{this._commit(next,files)}catch(error){if(filename)try{fs.rmSync(filename,{force:true})}catch{}throw error}
    if(!this.filesDir)this.memoryFiles.set(file.id,Buffer.from(data));
    return clone(file);
  }
  file(id){
    validId(id);const file=this.files.get(id)||this._apiTasks().flatMap(task=>task.files).find(file=>file.id===id);if(!file)throw fault('任务文件不存在',404);
    let data;
    if(this.filesDir){
      let fd;
      try{
        const dir=this._ensureFilesDir(),filename=path.join(dir,id+MIME_EXT.get(file.mimeType));
        const info=fs.lstatSync(filename);
        if(info.isSymbolicLink()||!info.isFile()||info.size!==file.size)throw Error('unsafe file');
        fd=fs.openSync(filename,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
        const opened=fs.fstatSync(fd);
        if(!opened.isFile()||opened.size!==file.size||opened.ino!==info.ino)throw Error('changed file');
        data=fs.readFileSync(fd);
      }catch{throw fault('任务结果文件不存在或已损坏',404)}finally{if(fd!==undefined)fs.closeSync(fd)}
    }else data=this.memoryFiles.get(id);
    if(!data||data.length!==file.size||!matchesImage(data,file.mimeType))throw fault('任务结果文件不存在或已损坏',404);
    return {...clone(file),data:Buffer.from(data)};
  }
  _schedule(){
    if(this.scheduled)return;
    this.scheduled=true;queueMicrotask(()=>{this.scheduled=false;this._drain()});
  }
  _drain(){
    while(this.active<this.concurrency&&this.queue.length){
      const job=this.queue.shift();if(this.tasks.get(job.id)?.status!=='queued')continue;
      this.active++;void this._run(job);
    }
    this._notifyIdle();
  }
  async _run({id,runner}){
    try{
      const task=this._replace({...this.get(id),status:'running',startedAt:new Date().toISOString()});
      const outcome=await runner({task,updateProgress:progress=>{
        const latest=this.get(id);if(latest.status!=='running')throw fault('任务已经结束',409);
        return this._replace({...latest,progress:jsonValue(progress,'任务进度',32*1024)});
      }});
      const status=outcome?.status||'succeeded';
      if(!TERMINAL.has(status))throw fault('任务执行器返回无效状态');
      this._replace({...this.get(id),status,result:outcome?.result===undefined?null:jsonValue(outcome.result,'任务结果'),error:cleanError(outcome?.error),finishedAt:new Date().toISOString()});
    }catch{
      const task=this.tasks.get(id);
      if(task){
        const failed={...task,status:'failed',finishedAt:new Date().toISOString(),error:'任务执行失败，请检查本机服务状态后重试。'};
        try{this._replace(failed)}catch{
          // Never rerun a possibly completed upstream operation after a disk error.
          this.tasks.set(id,{...failed,status:'interrupted',error:'任务状态无法保存，结果未知；请检查磁盘并核对结果。'});
        }
      }
    }finally{this.active--;this._schedule()}
  }
  _notifyIdle(){if(!this.active&&!this.queue.length){for(const resolve of this.idleWaiters.splice(0))resolve()}}
  waitForIdle(){return !this.active&&!this.queue.length?Promise.resolve():new Promise(resolve=>this.idleWaiters.push(resolve))}
}
