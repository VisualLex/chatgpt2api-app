import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createProvider,validBaseUrl,validateImage} from '../lib/provider.js';

const tiny='aGVsbG8=';
function backend() {
  const calls=[];
  const server=http.createServer(async (req,res)=>{
    let raw='';for await (const chunk of req) raw+=chunk;
    const json=raw?JSON.parse(raw):null;
    calls.push({url:req.url,auth:req.headers.authorization,body:json});
    res.setHeader('content-type','application/json');
    if(req.url==='/health?format=json') return res.end(JSON.stringify({healthy:true,status:'ok',version:'1.8.0',accounts:{total:10,active:8,limited:1,abnormal:1,total_quota:250,total_success:12,total_fail:2}}));
    if(req.url==='/v1/models') {
      if(req.headers.authorization!=='Bearer expected') {res.statusCode=401;return res.end('{"detail":{"error":"unauthorized"}}')}
      return res.end(JSON.stringify({data:[{id:'gpt-image-2'},{id:'auto'}]}));
    }
    if(req.url==='/v1/images/edits'||req.url==='/v1/images/generations') {
      if(req.headers.authorization!=='Bearer expected') {res.statusCode=401;return res.end('{"error":"unauthorized"}')}
      return res.end(JSON.stringify({created:123,data:[{b64_json:'ZGF0YQ=='}],usage:{output_tokens:100}}));
    }
    if(req.url==='/v1/chat/completions')return res.end(JSON.stringify({choices:[{message:{content:'hello'}}]}));
    if(req.url==='/v1/responses')return res.end(JSON.stringify({id:'resp-1',status:'completed'}));
    res.statusCode=404;return res.end('{"detail":"not found"}');
  });
  return {server,calls};
}

test('provider health, pool summary, models and image edit use backend endpoints', async t=>{
  const {server,calls}=backend();
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
  const api=createProvider({baseUrl:`http://127.0.0.1:${server.address().port}`,apiKey:'expected'});
  assert.equal((await api.health()).accounts.active,8);
  assert.equal((await api.poolSummary()).totalQuota,250);
  assert.deepEqual(await api.models(),['gpt-image-2','auto']);
  const result=await api.generateImage({prompt:'测试人物写真',referenceImages:[{dataBase64:tiny,mimeType:'image/png'}]});
  assert.equal(result.data[0].b64_json,'ZGF0YQ==');
  const edit=calls.find(x=>x.url==='/v1/images/edits');
  assert.equal(edit.auth,'Bearer expected');assert.equal(edit.body.images.length,1);assert.equal(edit.body.n,1);
  await api.generateImage({prompt:'一只猫'});
  assert.ok(calls.some(x=>x.url==='/v1/images/generations'));
});

test('without key, only public health endpoint works', async t=>{
  const {server}=backend();await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
  const api=createProvider({baseUrl:`http://127.0.0.1:${server.address().port}`});
  assert.equal((await api.health()).connected,true);
  await assert.rejects(()=>api.models(),/未配置/);
  await assert.rejects(()=>api.generateImage({prompt:'test'}),/未配置/);
});

test('input limits protect host service', async()=>{
  const api=createProvider({baseUrl:'http://127.0.0.1:38650',apiKey:'test'},async()=>{throw Error('should not call')});
  await assert.rejects(()=>api.generateImage({prompt:'hi',n:2}),/单张/);
  await assert.rejects(()=>api.generateImage({prompt:'hi',referenceImages:[{dataBase64:tiny,mimeType:'text/plain'}]}),/仅支持/);
  await assert.rejects(()=>api.generateImage({prompt:'hi',referenceImages:Array(5).fill({dataBase64:tiny,mimeType:'image/png'})}),/最多 4/);
  await assert.rejects(()=>api.generateImage({prompt:''}),/提示词/);
  assert.equal(validateImage({dataBase64:tiny,mimeType:'image/jpeg'},0).filename,'reference-1.jpg');
  assert.throws(()=>validBaseUrl('file:///etc/passwd'),/只能/);
  assert.throws(()=>validBaseUrl('http://user:password@example.com'),/只能/);
});

test('upstream error handling shows status without leaking Authorization', async t=>{
  const {server}=backend();await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
  const api=createProvider({baseUrl:`http://127.0.0.1:${server.address().port}`,apiKey:'bad-key'});
  await assert.rejects(()=>api.models(),e=>e.message.includes('HTTP 401')&&!e.message.includes('bad-key'));
});

test('generic Host chat and response interfaces serve other plugins',async t=>{
  const {server,calls}=backend();await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
  const api=createProvider({baseUrl:`http://127.0.0.1:${server.address().port}`,apiKey:'expected'});
  const chat=await api.chatCompletion({model:'auto',messages:[{role:'user',content:'你好'}]});
  assert.equal(chat.choices[0].message.content,'hello');
  const response=await api.createResponse({model:'auto',input:'你好'});
  assert.equal(response.status,'completed');
  assert.ok(calls.some(c=>c.url==='/v1/chat/completions'));
  assert.ok(calls.some(c=>c.url==='/v1/responses'));
  await assert.rejects(()=>api.chatCompletion({messages:'not-array'}),/messages/);
});
