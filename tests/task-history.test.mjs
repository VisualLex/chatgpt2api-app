import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {TaskHistory} from '../lib/task-history.js';

const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,options={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'c2a-tasks-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return new TaskHistory({root,...options});
}
function meta(extra={}){return {type:'image',summary:'测试图片',params:{prompt:'水彩风景',model:'gpt-image-2'},...extra}}

function apiRecord(history,extra={}){
  const stamp=new Date().toISOString();
  const task={id:randomUUID(),type:'api_request',summary:'POST /v1/responses',status:'running',params:{method:'POST',path:'/v1/responses',model:'test-model',stream:true,prompt:'你好'},progress:{},result:null,files:[],createdAt:stamp,startedAt:stamp,finishedAt:null,error:'',parentTaskId:null,...extra};
  fs.mkdirSync(history.apiHistoryDir,{recursive:true});
  fs.writeFileSync(path.join(history.apiHistoryDir,task.id+'.json'),JSON.stringify(task));
  return task;
}

test('API records merge before sorting, filtering and pagination without being copied into the task queue',async t=>{
  const history=fixture(t);
  const local=history.submit(meta(),()=>({}));await history.waitForIdle();
  const earlier=apiRecord(history,{createdAt:'2020-01-01T00:00:00.000Z',status:'failed'});
  const latest=apiRecord(history,{createdAt:'2099-01-01T00:00:00.000Z'});
  assert.deepEqual(history.list({pageSize:2}).items.map(task=>task.id),[latest.id,local.id]);
  assert.equal(history.list({page:2,pageSize:2}).items[0].id,earlier.id);
  assert.equal(history.list({type:'api_request'}).total,2);
  assert.equal(history.list({type:'api_request',status:'running'}).items[0].id,latest.id);
  assert.equal(history.list({from:'2020-01-01',to:'2020-01-01'}).items[0].id,earlier.id);
  assert.equal(history.list().items[0].params,undefined);
  assert.equal(JSON.parse(fs.readFileSync(history.filePath)).tasks.length,1);
  assert.deepEqual(new TaskHistory({root:history.root}).get(latest.id),latest,'Node restart must not interrupt a live Python request');
  const completed=apiRecord(history,{...latest,status:'succeeded',finishedAt:new Date().toISOString(),result:{httpStatus:200,responseBytes:42,usage:{input_tokens:3,output_tokens:4,total_tokens:7}}});
  assert.deepEqual(history.get(latest.id),completed,'updates written by Python are visible without restarting Node');
  assert.equal(history.list().items[0].result.usage.total_tokens,7);
});

test('finished API records can be removed durably, while active requests cannot be removed',t=>{
  const history=fixture(t),active=apiRecord(history),done=apiRecord(history,{status:'failed',error:'请求失败'});
  assert.throws(()=>history.delete(active.id),error=>error.status===409);
  assert.deepEqual(history.delete(done.id),{removed:1});
  assert.equal(fs.existsSync(path.join(history.apiHistoryDir,done.id+'.json')),false);
  assert.throws(()=>new TaskHistory({root:history.root}).get(done.id),error=>error.status===404);
  assert.equal(history.list().total,1);
});

test('API image results are previewable through registered file IDs and survive reload',t=>{
  const history=fixture(t),file={id:randomUUID(),mimeType:'image/png',size:PNG.length,role:'result'};
  const task=apiRecord(history,{status:'succeeded',files:[file],result:{httpStatus:200,files:[file]}});
  fs.mkdirSync(history.filesDir,{recursive:true});fs.writeFileSync(path.join(history.filesDir,file.id+'.png'),PNG);
  assert.deepEqual(history.get(task.id).result.files,[file]);
  assert.deepEqual(history.file(file.id).data,PNG);
  assert.deepEqual(new TaskHistory({root:history.root}).file(file.id).data,PNG);
  assert.deepEqual(history.list().items[0].result.files,[file]);
  fs.rmSync(path.join(history.filesDir,file.id+'.png'));
  assert.throws(()=>history.file(file.id),error=>error.status===404);
  assert.ok(history.get(task.id),'missing binary does not discard its request history');
});

test('API image descriptors cannot register arbitrary paths or unsafe types',t=>{
  const history=fixture(t);
  for(const file of [{id:'../outside',mimeType:'image/png',size:PNG.length,role:'result'},{id:randomUUID(),mimeType:'image/svg+xml',size:10,role:'result'},{id:randomUUID(),mimeType:'image/png',size:33*1024*1024,role:'result'}]){
    const task=apiRecord(history,{files:[file],result:{files:[file]}});
    assert.throws(()=>history.get(task.id),error=>error.status===404);
  }
});

test('malformed, oversized and credential-bearing API records are excluded',t=>{
  const history=fixture(t),valid=apiRecord(history);
  apiRecord(history,{params:{password:'must-never-appear'}});
  apiRecord(history,{type:'image'});
  apiRecord(history,{createdAt:'invalid'});
  const broken=apiRecord(history);fs.writeFileSync(path.join(history.apiHistoryDir,broken.id+'.json'),'{broken');
  const oversized=apiRecord(history);fs.writeFileSync(path.join(history.apiHistoryDir,oversized.id+'.json'),'x'.repeat(128*1024+1));
  fs.writeFileSync(path.join(history.apiHistoryDir,'not-an-id.json'),JSON.stringify(valid));
  assert.deepEqual(history.list().items.map(task=>task.id),[valid.id]);
  assert.throws(()=>history.get(broken.id),error=>error.status===404);
});

test('tasks are persisted before a runner starts, and progress and results survive reload',async t=>{
  const history=fixture(t);let runs=0;
  const created=history.submit(meta(),async({task,updateProgress})=>{
    runs++;assert.equal(task.status,'running');
    updateProgress({processed:1,total:2});
    assert.deepEqual(JSON.parse(fs.readFileSync(history.filePath)).tasks[0].progress,{processed:1,total:2});
    return {status:'partial',result:{succeeded:1,failed:1,failures:[{message:'可公开失败原因'}]}};
  });
  assert.equal(created.status,'queued');assert.equal(runs,0);
  assert.equal(JSON.parse(fs.readFileSync(history.filePath)).tasks[0].status,'queued');
  await history.waitForIdle();
  const done=history.get(created.id);
  assert.equal(done.status,'partial');assert.equal(runs,1);
  assert.ok(done.startedAt&&done.finishedAt);
  const reloaded=new TaskHistory({root:history.root});
  assert.deepEqual(reloaded.get(created.id),done);
  assert.deepEqual(reloaded.list().items[0].result,{succeeded:1,failed:1});
  assert.equal('params' in reloaded.list().items[0],false);
  if(process.platform!=='win32')assert.equal(fs.statSync(history.filePath).mode&0o777,0o600);
});

test('concurrency limits apply to background work and queued tasks start after a slot opens',async()=>{
  const history=new TaskHistory({concurrency:2});const started=[];const release=[];
  for(let i=0;i<3;i++)history.submit(meta({summary:String(i)}),()=>new Promise(resolve=>{started.push(i);release[i]=resolve}));
  await tick();assert.deepEqual(started,[0,1]);
  release[0]({result:{ok:true}});await tick();assert.deepEqual(started,[0,1,2]);
  release[1]({});release[2]({});await history.waitForIdle();
  assert.equal(history.list({status:'succeeded'}).total,3);
});

test('request IDs are canonical, durable, and never replay a cleaned-up task',async t=>{
  const history=fixture(t);let runs=0;
  const task=history.submit(meta({requestId:'browser-request-1'}),()=>{runs++;return {}});
  const duplicate=history.submit(meta({requestId:'browser-request-1',params:{model:'gpt-image-2',prompt:'水彩风景'}}),()=>{runs++;return {}});
  assert.equal(duplicate.id,task.id);
  assert.throws(()=>history.submit(meta({requestId:'browser-request-1',params:{prompt:'不同参数'}}),()=>({})),error=>error.status===409);
  await history.waitForIdle();assert.equal(runs,1);
  const reopened=new TaskHistory({root:history.root});
  assert.equal(reopened.submit(meta({requestId:'browser-request-1'}),()=>{runs++;return {}}).id,task.id);
  assert.equal(runs,1);
  reopened.delete(task.id);
  assert.throws(()=>reopened.submit(meta({requestId:'browser-request-1'}),()=>({})),error=>error.status===410);
});

test('preflight request hashes support credential and file preparation without storing raw input',async()=>{
  const history=new TaskHistory(),requestHash='a'.repeat(64);
  const task=history.submit(meta({requestId:'hash-request',requestHash}),()=>({}));
  assert.equal(history.findByRequestId('hash-request',requestHash).id,task.id);
  assert.equal(history.findByRequestId('not-created',requestHash),null);
  assert.throws(()=>history.findByRequestId('hash-request','b'.repeat(64)),error=>error.status===409);
  assert.throws(()=>history.findByRequestId('hash-request',[requestHash]),error=>error.status===400);
  assert.throws(()=>history.submit(meta({requestId:'hash-request',requestHash:'b'.repeat(64)}),()=>({})),error=>error.status===409);
  await history.waitForIdle();
});

test('input files and updated parameters are available to the runner without base64 metadata',async t=>{
  const history=fixture(t);let observed;
  const task=history.submit(meta(),({task})=>{observed=task;return {result:{files:task.files}}});
  const file=history.addFile(task.id,{data:PNG,mimeType:'image/png',role:'input'});
  history.updateParams(task.id,{prompt:'参考图',referenceFiles:[file]});
  await history.waitForIdle();
  assert.deepEqual(observed.params.referenceFiles,[file]);assert.deepEqual(observed.files,[file]);
  assert.deepEqual(history.file(file.id).data,PNG);
  assert.doesNotMatch(fs.readFileSync(history.filePath,'utf8'),new RegExp(PNG.toString('base64')));
  assert.deepEqual(history.list().items[0].result.files,[file]);
  assert.throws(()=>history.updateParams(task.id,{}),error=>error.status===409);
  assert.throws(()=>history.addFile(task.id,{data:PNG,mimeType:'image/png'}),error=>error.status===409);
});

test('aborted file preparation fails the queued record without invoking an upstream runner',async()=>{
  const history=new TaskHistory();let runs=0;
  const task=history.submit(meta(),()=>{runs++;return {}});
  history.failQueued(task.id,'参考图片无法保存，请重新提交');
  await history.waitForIdle();assert.equal(runs,0);
  assert.equal(history.get(task.id).status,'failed');
  assert.match(history.get(task.id).error,/参考图片无法保存/);
});

test('unexpected runner failures and secret result fields cannot leak into history',async t=>{
  const history=fixture(t);
  const thrown=history.submit(meta(),()=>{throw Error('access_token=private-upstream-token password=private-password')});
  const returned=history.submit(meta(),()=>({result:{access_token:'private-upstream-token'}}));
  const explicit=history.submit(meta(),()=>({status:'failed',error:'上游拒绝了本次请求'}));
  const unknown=history.submit(meta(),()=>({status:'interrupted',error:'额度刷新进度不可确认'}));
  await history.waitForIdle();
  assert.equal(history.get(thrown.id).status,'failed');
  assert.equal(history.get(returned.id).status,'failed');
  assert.match(history.get(explicit.id).error,/上游拒绝/);
  assert.equal(history.get(unknown.id).status,'interrupted');
  assert.doesNotMatch(fs.readFileSync(history.filePath,'utf8'),/private-upstream-token|private-password|access_token=/);
  assert.throws(()=>history.submit(meta({params:{password:'unsafe'}}),()=>({})),/不能保存凭据/);
});

test('crash recovery marks unfinished records interrupted without scheduling their operations',async t=>{
  const history=fixture(t);let runs=0;
  const old=history.submit(meta(),()=>{runs++;return {}});await history.waitForIdle();
  const document=JSON.parse(fs.readFileSync(history.filePath,'utf8'));
  document.tasks[0].status='running';document.tasks[0].finishedAt=null;
  const queued={...document.tasks[0],id:randomUUID(),status:'queued',startedAt:null};document.tasks.push(queued);
  fs.writeFileSync(history.filePath,JSON.stringify(document));
  const recovered=new TaskHistory({root:history.root});
  await recovered.waitForIdle();assert.equal(runs,1);
  for(const id of [old.id,queued.id]){
    assert.equal(recovered.get(id).status,'interrupted');
    assert.match(recovered.get(id).error,/程序已重启.*结果未知/);
    assert.ok(recovered.get(id).finishedAt);
  }
  assert.ok(JSON.parse(fs.readFileSync(history.filePath)).tasks.every(task=>task.status==='interrupted'));
});

test('retention evicts only ended tasks and refuses to silently discard queued work',async()=>{
  const history=new TaskHistory({maxTasks:2});let release;
  const a=history.submit(meta({requestId:'old-record'}),()=>new Promise(resolve=>{release=resolve}));
  const b=history.submit(meta(),()=>({}));
  assert.throws(()=>history.submit(meta(),()=>({})),error=>error.status===429);
  assert.equal(history.list().total,2);await tick();release({});await history.waitForIdle();
  const c=history.submit(meta(),()=>({}));await history.waitForIdle();
  assert.throws(()=>history.get(a.id),error=>error.status===404);
  assert.ok(history.get(b.id));assert.ok(history.get(c.id));
  assert.throws(()=>history.findByRequestId('old-record'),error=>error.status===410);
});

test('history removal never deletes recorded image files, including after restart',async t=>{
  const history=fixture(t);
  const task=history.submit(meta(),()=>({}));
  const file=history.addFile(task.id,{data:PNG,mimeType:'image/png',role:'result'});
  assert.throws(()=>history.delete(task.id),error=>error.status===409);
  await history.waitForIdle();assert.deepEqual(history.delete(task.id),{removed:1});
  const reloaded=new TaskHistory({root:history.root});
  assert.throws(()=>reloaded.get(task.id),error=>error.status===404);
  assert.deepEqual(reloaded.file(file.id).data,PNG);
});

test('list filtering and pagination are validated and never expose mutable internal state',async()=>{
  const history=new TaskHistory();
  const first=history.submit(meta({type:'gif'}),()=>({status:'failed',error:'失败'}));
  const second=history.submit(meta({summary:'第二个'}),()=>({}));
  const third=history.submit(meta({summary:'第三个'}),()=>({}));await history.waitForIdle();
  assert.deepEqual(history.list({pageSize:2}).items.map(task=>task.id),[third.id,second.id]);
  assert.equal(history.list({page:99,pageSize:2}).page,2);
  assert.equal(history.list({type:'gif',status:'failed'}).items[0].id,first.id);
  assert.equal(history.list({from:'2099-01-01'}).total,0);
  const snapshot=history.get(first.id);snapshot.params.prompt='mutated';
  assert.equal(history.get(first.id).params.prompt,'水彩风景');
  for(const options of [{page:0},{pageSize:101},{status:'made_up'},{from:'nonsense'},{from:'2026-02-31'},{from:'2026-11-08',to:'2026-11-06'}])assert.throws(()=>history.list(options),error=>error.status===400);
});

test('invalid file IDs, formats, size, and missing files are handled without paths or credentials',async t=>{
  const history=fixture(t),task=history.submit(meta(),()=>({}));
  assert.throws(()=>history.addFile(task.id,{data:Buffer.alloc(0),mimeType:'image/png'}),/文件为空/);
  assert.throws(()=>history.addFile(task.id,{data:Buffer.alloc(32*1024*1024+1),mimeType:'image/png'}),/超过 32MB/);
  assert.throws(()=>history.addFile(task.id,{data:Buffer.from('<svg/>'),mimeType:'image/png'}),/文件格式无效/);
  assert.throws(()=>history.addFile(task.id,{data:PNG,mimeType:'image/svg+xml'}),/文件格式无效/);
  const file=history.addFile(task.id,{data:PNG,mimeType:'image/png'});
  assert.throws(()=>history.file('../task-history.json'),error=>error.status===400);
  assert.throws(()=>history.file(randomUUID()),error=>error.status===404);
  fs.rmSync(path.join(history.filesDir,file.id+'.png'));
  assert.throws(()=>history.file(file.id),error=>error.status===404&&!error.message.includes(history.root));
  await history.waitForIdle();
});

test('registered file IDs cannot follow file or directory symlinks outside the task directory',async t=>{
  if(process.platform==='win32')return t.skip('symbolic link setup requires extra Windows privileges');
  const history=fixture(t),task=history.submit(meta(),()=>({}));
  const file=history.addFile(task.id,{data:PNG,mimeType:'image/png'});
  const outside=path.join(history.root,'outside.png');fs.writeFileSync(outside,PNG);
  const own=path.join(history.filesDir,file.id+'.png');fs.rmSync(own);fs.symlinkSync(outside,own);
  assert.throws(()=>history.file(file.id),error=>error.status===404);
  fs.rmSync(own);fs.rmSync(history.filesDir,{recursive:true});fs.symlinkSync(history.root,history.filesDir,'dir');
  assert.throws(()=>history.addFile(task.id,{data:PNG,mimeType:'image/png'}),/目录不可使用符号链接/);
  assert.throws(()=>history.file(file.id),error=>error.status===404);
  await history.waitForIdle();
});

test('corrupted metadata and metadata symlinks are rejected without overwriting existing files',t=>{
  const history=fixture(t),bad='{not-json';fs.writeFileSync(history.filePath,bad);
  assert.throws(()=>new TaskHistory({root:history.root}),/损坏.*未自动覆盖/);
  assert.equal(fs.readFileSync(history.filePath,'utf8'),bad);
  if(process.platform!=='win32'){
    const outside=path.join(history.root,'outside.json');fs.writeFileSync(outside,bad);
    fs.rmSync(history.filePath);fs.symlinkSync(outside,history.filePath);
    assert.throws(()=>new TaskHistory({root:history.root}),/任务历史文件无效/);
    assert.equal(fs.readFileSync(outside,'utf8'),bad);
  }
});

test('a failed atomic write cannot enqueue work or report a successful submission',async t=>{
  const history=fixture(t);let runs=0;
  const rename=fs.renameSync;
  try{
    fs.renameSync=()=>{throw Object.assign(Error('disk unavailable'),{code:'ENOSPC'})};
    assert.throws(()=>history.submit(meta(),()=>{runs++;return {}}),/disk unavailable/);
  }finally{fs.renameSync=rename}
  await history.waitForIdle();assert.equal(runs,0);assert.equal(history.list().total,0);
  assert.equal(fs.readdirSync(history.root).filter(name=>name.endsWith('.tmp')).length,0);
});
