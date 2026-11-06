import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
const root=path.resolve(import.meta.dirname,'..');
test('standalone package launches local management without a plugin manifest',()=>{
  const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
  assert.equal(pkg.name,'chatgpt2api-app');assert.equal(pkg.version,'0.6.2');
  assert.equal(pkg.dsh,undefined);
  assert.equal(pkg.scripts.start,'node scripts/launch.mjs');
  assert.ok(!pkg.files.includes('cordis.patch.yml'));
  for(const file of ['start.sh','start-windows.bat']){
    assert.ok(pkg.files.includes(file));assert.ok(fs.existsSync(path.join(root,file)));
  }
  const web=fs.readFileSync(path.join(root,'web/dashboard.js'),'utf8');
  assert.doesNotMatch(web,/__ModuleLoader__/);
});
test('browser plugin mounts independent navigation + main panel',()=>{
  let module=null;
  vm.runInNewContext(fs.readFileSync(path.join(root,'lib/client.js'),'utf8'),{URL,__ModuleLoader__:{load(obj){module=obj.factory(()=>({createElement(){},useState(){},useEffect(){},useMemo(){}}))}}},{timeout:2500});
  assert.ok(module?.apply);
  const slots=[];
  module.apply({slots:{inject(_name,cb){return cb()},register(def){slots.push(def);return ()=>{}}}});
  assert.deepEqual(slots.map(x=>x.name),['sidebar.panellist','main']);
  assert.equal(module.__test.urlClean('http://127.0.0.1:38650'),'http://127.0.0.1:38650');
  assert.equal(module.__test.urlClean('file:///etc/passwd'),null);
});
test('package contains cross-platform bootstrap and no standalone Docker dependency',()=>{
  const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
  assert.ok(fs.existsSync(path.join(root,'lib/platform-backend.js')));
  assert.ok(fs.existsSync(path.join(root,'lib/archive.js')));
  assert.doesNotMatch(fs.readFileSync(path.join(root,'lib/index.js'),'utf8'),/AIPoseStudio/);
  const ui=fs.readFileSync(path.join(root,'lib/client.js'),'utf8');
  assert.match(ui,/API 接入/);assert.doesNotMatch(ui,/AIPoseStudio/);
  assert.doesNotMatch(ui,/show-admin-key/);
  assert.doesNotMatch(ui,/请输入管理员/);
  assert.match(ui,/chatgpt2api-native\/manage/);
  assert.match(ui,/邮箱 \/ 密码 \/ 第三字段批量导入/);
});
