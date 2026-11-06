import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseOptions} from '../scripts/start.mjs';

// Supplying an empty environment keeps these checks independent of a developer's
// existing DSH installation and prevents any actual backend initialization.
test('standalone CLI defaults use their own data directory and separate local ports',()=>{
  assert.deepEqual(parseOptions([],{}),{
    port:38650,webPort:38651,
    dataDir:path.join(os.homedir(),'.chatgpt2api'),pythonPath:'',open:true,
  });
});

test('explicit CLI arguments override both standalone and legacy environment settings',()=>{
  const environment={
    CHATGPT2API_PORT:'41000',DSH_CHATGPT2API_PORT:'42000',CHATGPT2API_WEB_PORT:'41001',
    CHATGPT2API_HOME:'/standalone/from-env',DSH_CHATGPT2API_HOME:'/legacy/from-env',
    CHATGPT2API_PYTHON:'/standalone/python',DSH_CHATGPT2API_PYTHON:'/legacy/python',
  };
  const configuration=parseOptions([
    '--port','43000','--web-port','43001','--data-dir','relative-data-dir',
    '--python','/path with spaces/python3.13','--no-open',
  ],environment);
  assert.deepEqual(configuration,{
    port:43000,webPort:43001,dataDir:path.resolve('relative-data-dir'),
    pythonPath:'/path with spaces/python3.13',open:false,
  });
  assert.equal(environment.CHATGPT2API_PORT,'41000','reading configuration must not mutate the environment');
});

test('standalone environment names take priority while legacy DSH settings still work',()=>{
  const current=parseOptions([],{
    CHATGPT2API_PORT:'44000',DSH_CHATGPT2API_PORT:'45000',CHATGPT2API_WEB_PORT:'44001',
    CHATGPT2API_HOME:'current-data',DSH_CHATGPT2API_HOME:'legacy-data',
    CHATGPT2API_PYTHON:'current-python',DSH_CHATGPT2API_PYTHON:'legacy-python',
  });
  assert.equal(current.port,44000);
  assert.equal(current.webPort,44001);
  assert.equal(current.dataDir,path.resolve('current-data'));
  assert.equal(current.pythonPath,'current-python');
  const legacy=parseOptions([],{
    DSH_CHATGPT2API_PORT:'45000',DSH_CHATGPT2API_HOME:'legacy-data',DSH_CHATGPT2API_PYTHON:'legacy-python',
  });
  assert.equal(legacy.port,45000);
  assert.equal(legacy.dataDir,path.resolve('legacy-data'));
  assert.equal(legacy.pythonPath,'legacy-python');
});

test('invalid or colliding ports and unsupported arguments fail before startup',()=>{
  assert.throws(()=>parseOptions(['--port','46000','--web-port','46000'],{}),/不同端口/);
  assert.throws(()=>parseOptions([],{CHATGPT2API_PORT:'38651'}),/不同端口/);
  for(const value of ['0','-1','80','65536','NaN','40000.5']) {
    assert.throws(()=>parseOptions(['--port',value],{}),/端口|argument/i);
    assert.throws(()=>parseOptions(['--web-port',value],{}),/端口|argument/i);
  }
  assert.throws(()=>parseOptions(['--unknown-option'],{}),/unknown|未知/i);
  assert.throws(()=>parseOptions(['--port'],{}),/argument|参数/i);
  assert.throws(()=>parseOptions(['extra-positional'],{}),/positional|参数/i);
});

test('help skips configuration validation and runs without a backend or DSH host',()=>{
  assert.deepEqual(parseOptions(['--help'],{CHATGPT2API_PORT:'invalid'}),{help:true});
  assert.deepEqual(parseOptions(['-h'],{}),{help:true});
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/start.mjs',import.meta.url)),'--help'],{
    encoding:'utf8',timeout:5000,
    env:{...process.env,CHATGPT2API_PORT:'invalid',CHATGPT2API_HOME:path.join(os.tmpdir(),'nonexistent-help-data')},
  });
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/独立程序/);
  assert.match(result.stdout,/--web-port/);
  assert.match(result.stdout,/--data-dir/);
  assert.match(result.stdout,/--no-open/);
  assert.doesNotMatch(result.stderr,/启动失败/);
});
