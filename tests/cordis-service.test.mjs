import test from 'node:test';
import assert from 'node:assert/strict';
import {Service,SERVICE_SOURCE} from '../lib/cordis-service.js';
import fs from 'node:fs';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..');

test('host entry never imports the bare @deepseek-ai/cordis specifier',()=>{
  const host=fs.readFileSync(path.join(root,'lib/index.js'),'utf8');
  assert.doesNotMatch(host,/from\s+['"]@deepseek-ai\/cordis['"]/);
  assert.match(host,/from '\.\/cordis-service\.js'/);
});

test('service base class is available without installed dependencies',()=>{
  assert.equal(typeof Service,'function');
  assert.ok(SERVICE_SOURCE==='host'||SERVICE_SOURCE==='compat');
});

test('the base class registers the instance through ctx.reflect.provide',()=>{
  const registered=[];
  const ctx={reflect:{provide(name,value){registered.push({name,value})}}};
  class Demo extends Service{
    constructor(host){super(host,'chatgpt2api');this.ready=true}
  }
  const instance=new Demo(ctx);
  assert.equal(instance.ready,true);
  assert.equal(instance.name,'chatgpt2api');
  assert.equal(instance.ctx,ctx);
  assert.equal(registered.length,1);
  assert.equal(registered[0].name,'chatgpt2api');
  assert.equal(registered[0].value,instance);
});

test('a missing registry fails loudly instead of half-registering',()=>{
  class Demo extends Service{
    constructor(host){super(host,'chatgpt2api')}
  }
  assert.throws(()=>new Demo({}),/ctx\.reflect\.provide|服务名不能为空/);
});
