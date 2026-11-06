import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {resolveImageSize, detectAspectRatio, validateImageTier} from '../lib/image-options.js';
import {ImagePreferencesStore, createAdminHandler} from '../lib/admin-route.js';

test('explicit pixel size wins over configured tier; ratio is never persisted',()=>{
  const prefs={defaultModel:'gpt-image-2',defaultImageTier:'4k'};
  assert.equal(resolveImageSize({prompt:'请生成16:9风景'},prefs),'3840x2160');
  assert.equal(resolveImageSize({aspect_ratio:'9:16',prompt:'image'},prefs),'2160x3840');
  assert.equal(resolveImageSize({prompt:'生成16:9风景',size:'1024x1024'},prefs),'1024x1024');
  assert.equal(resolveImageSize({prompt:'生成16:9风景',size:'auto'},prefs),'auto');
  assert.equal(resolveImageSize({prompt:'没有指定比例'},prefs),undefined);
  assert.equal(detectAspectRatio({prompt:'画幅 3:2'}),'3:2');
  assert.throws(()=>validateImageTier('5k'),/分辨率档位/);
});

test('saved preferences survive a new store instance and reject invalid values',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'c2a-prefs-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const a=new ImagePreferencesStore({root:dir});
  assert.equal(a.get().defaultImageTier,'auto');
  a.set({defaultModel:'codex-gpt-image-2',defaultImageTier:'2k'});
  const b=new ImagePreferencesStore({root:dir});
  assert.deepEqual(b.get(),{defaultModel:'codex-gpt-image-2',defaultImageTier:'2k'});
  assert.throws(()=>b.set({defaultImageTier:'unsafe'}));
  assert.equal(b.get().defaultImageTier,'2k');
  assert.ok(!JSON.stringify(b.get()).includes('token'));
});

test('Host bridge lists models and forwards saved tier as concrete image size',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'c2a-bridge-prefs-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const prefs=new ImagePreferencesStore({root:dir});
  prefs.set({defaultModel:'gpt-image-2',defaultImageTier:'2k'});
  const sent=[];
  const fetcher=async(url,options)=>{
    sent.push({path:new URL(url).pathname,body:options.body?JSON.parse(options.body):null});
    const data=new URL(url).pathname==='/v1/models'
      ? {data:[{id:'gpt-image-2'},{id:'gpt-image-2'},{id:'gpt-5'}]}
      : {data:[{b64_json:'aW1n'}]};
    return {ok:true,status:200,headers:{get:()=>null},text:async()=>JSON.stringify(data)};
  };
  const h=createAdminHandler({baseUrl:'http://127.0.0.1:38650',secret:'test-secret-very-long',fetcher,preferencesStore:prefs});
  assert.deepEqual((await h.execute({path:'/local/models'})).models,['gpt-image-2','gpt-5']);
  await h.execute({path:'/v1/images/generations',method:'POST',body:{prompt:'一张16:9风景图片'}});
  assert.equal(sent.at(-1).body.size,'2560x1440');
  await h.execute({path:'/v1/images/generations',method:'POST',body:{prompt:'一张16:9风景图片',size:'1024x1024'}});
  assert.equal(sent.at(-1).body.size,'1024x1024');
});

test('GIF bridge forwards native GIF options, not synthesized image frames',async()=>{
  const sent=[];
  const fetcher=async(url,options)=>{
    const data=JSON.parse(options.body);
    sent.push(data);
    return {ok:true,status:200,headers:{get:()=>null},text:async()=>JSON.stringify({
      data:[{b64_json:'R0lGODlhAQABAIAAAAUEBA=='}],
      output_format:'gif',generation_mode:'chatgpt_account_pool',frame_count:9,frame_duration_ms:200
    })};
  };
  const h=createAdminHandler({baseUrl:'http://127.0.0.1:38650',secret:'test-secret-very-long',fetcher});
  const result=await h.execute({
    path:'/v1/images/generations',method:'POST',
    body:{prompt:'16:9 cat waving',model:'gpt-image-2.6',output_format:'gif',frame_count:9,frame_duration_ms:200}
  });
  assert.equal(sent.length,1);
  assert.equal(sent[0].output_format,'gif');
  assert.equal(sent[0].frame_count,9);
  assert.equal(result.generation_mode,'chatgpt_account_pool');
  assert.equal(sent[0].size,'auto', 'GIF requests without explicit size must not inherit static 4K defaults');
  await assert.rejects(h.execute({
    path:'/v1/images/generations',method:'POST',
    body:{prompt:'GIF',model:'gpt-image-2',output_format:'gif'}
  }),/GPT Image 2.6/);
  await assert.rejects(h.execute({
    path:'/v1/images/edits',method:'POST',
    body:{prompt:'edit image',output_format:'gif',images:[]}
  }),/GIF 只支持文生图/);
  await assert.rejects(h.execute({
    path:'/v1/images/generations',method:'POST',
    body:{prompt:'image',output_format:'gif',frame_count:17}
  }),/2–16/);
});
