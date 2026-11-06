import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PlatformBackend,managedPaths,resolvePlatform,ensureManagedFiles,validatePort,DEFAULT_PORT,SOURCE_COMMIT,UV_VERSION,detectSystemPython,probePythonExecutable,pythonEnvIssue,systemPythonCandidates,windowsRegistryPythons,MINIMUM_PYTHON_MINOR} from '../lib/platform-backend.js';

const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'dsh-c2a-v06-'));
/** Create the interpreter + site-packages layout a healthy install has. */
function installVenv(root,spec,{packages=['anyio','fastapi','uvicorn','starlette']}={}){
  const venv=path.join(root,'source','.venv');
  const py=path.join(venv,spec.pythonRelative);
  fs.mkdirSync(path.dirname(py),{recursive:true});fs.writeFileSync(py,'python-stub');
  const site=spec.platform==='win32'?path.join(venv,'Lib','site-packages'):path.join(venv,'lib','python3.13','site-packages');
  fs.mkdirSync(site,{recursive:true});
  for(const name of packages)fs.mkdirSync(path.join(site,name),{recursive:true});
  return {venv,py,site};
}
/** /health only answers once a child was spawned, mirroring a cold start. */
function healthFetcher(state){
  return async url=>{
    const route=new URL(url).pathname;
    if(route==='/health')return state.spawned?{ok:true,json:async()=>({status:'ok'})}:{ok:false,json:async()=>null};
    if(route==='/api/accounts')return state.adoptable===false?{ok:false,status:401,json:async()=>({})}:{ok:true,json:async()=>({items:[]})};
    throw Error('unexpected fetch '+route);
  };
}
/** Pre-create uv, source marker and uv.lock so provisioning starts at the venv. */
function primeRuntime(root,platform='linux',arch='x64',libc='gnu'){
  const paths=managedPaths({root,platform,arch,libc});
  fs.mkdirSync(paths.source,{recursive:true});
  fs.writeFileSync(paths.marker,SOURCE_COMMIT+'\n');
  fs.writeFileSync(path.join(paths.source,'uv.lock'),'stub');
  fs.mkdirSync(path.dirname(paths.uv),{recursive:true});
  fs.writeFileSync(paths.uv,'fake-uv');
  return paths;
}
const flush=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));};
const cases=[
  ['win32','x64','gnu'],['win32','arm64','gnu'],
  ['darwin','x64','gnu'],['darwin','arm64','gnu'],
  ['linux','x64','gnu'],['linux','arm64','gnu'],
  ['linux','x64','musl'],['linux','arm64','musl']
];

test('all 8 Windows/macOS/Linux runtime targets have pinned SHA256',()=>{
  for(const [platform,arch,libc] of cases){
    const spec=resolvePlatform(platform,arch,libc);
    assert.match(spec.sha256,/^[a-f0-9]{64}$/);
    assert.match(spec.url,/^https:\/\/github\.com\/astral-sh\/uv\/releases\/download\/0\.9\.13\/uv-/);
    assert.equal(spec.filename.endsWith('.zip'),platform==='win32');
    assert.equal(spec.pythonRelative.includes('Scripts'),platform==='win32');
  }
  assert.equal(DEFAULT_PORT,38650);
  assert.match(SOURCE_COMMIT,/^[0-9a-f]{40}$/);
  assert.equal(UV_VERSION,'0.9.13');
  assert.throws(()=>resolvePlatform('freebsd','x64'),/暂不支持/);
  assert.throws(()=>resolvePlatform('linux','ia32'),/暂不支持/);
  assert.throws(()=>validatePort(80),/端口/);
});

test('windows v0.5 existing credential and account paths are preserved',t=>{
  const root=temp();t.after(()=>fs.rmSync(root,{force:true,recursive:true}));
  const p=managedPaths({root,platform:'win32',arch:'x64'});
  const k=ensureManagedFiles(p);
  assert.equal(k,ensureManagedFiles(p));
  assert.equal(p.uv,path.join(root,'runtime','uv.exe'));
  const wArm=managedPaths({root,platform:'win32',arch:'arm64'});
  assert.equal(wArm.uv,path.join(root,'runtime','uv-arm64.exe'));
  assert.equal(p.key,path.join(root,'admin-key'));
  assert.equal(p.data,path.join(root,'source','data'));
  assert.throws(()=>ensureManagedFiles(p,'short'),/密钥/);
  const lx=managedPaths({root,platform:'linux',arch:'x64',libc:'gnu'});
  const la=managedPaths({root,platform:'linux',arch:'arm64',libc:'musl'});
  assert.notEqual(lx.uv,la.uv);
});

for(const [platform,arch,libc] of cases){
  test(`simulate first boot, health and clean stop: ${platform}/${arch}/${libc}`,async t=>{
    const root=temp();t.after(()=>fs.rmSync(root,{force:true,recursive:true}));
    const dummy=Buffer.from('pretend archive version 0.9.13');
    const downloads=[],commands=[],launches=[],termination=[];
    const downloader=async(url,file,opts)=>{downloads.push({url,file,opts});fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,dummy)};
    const extractor=(archive,dest)=>{
      if(archive.endsWith('.tar.gz')){
        fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,'fake-uv');
      }else if(archive.includes('uv-')){
        fs.mkdirSync(dest,{recursive:true});fs.writeFileSync(path.join(dest,'uv.exe'),'fake-uv');
      }else{
        const dir=path.join(dest,`chatgpt2api-${SOURCE_COMMIT}`);
        fs.mkdirSync(dir,{recursive:true});
        for(const file of ['pyproject.toml','uv.lock','main.py'])fs.writeFileSync(path.join(dir,file),'stub');
        for(const folder of ['api','services','utils'])fs.mkdirSync(path.join(dir,folder));
      }
    };
    const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.pid=123456;child.kill=()=>{};
    const state={spawned:false};
    const executor=async(bin,args)=>{commands.push({bin,args});if(args[0]==='sync'){
      installVenv(root,resolvePlatform(platform,arch,libc));
    }return ''};
    const backend=new PlatformBackend({dataDir:root},{platform,arch,libc,downloader,extractZip:extractor,extractTar:extractor,executor,
      spawner:(bin,args,opts)=>{launches.push({bin,args,opts});state.spawned=true;return child},
      portProbe:async()=>{},fetcher:healthFetcher(state),sleeper:async()=>{},
      groupKiller:(pid,sig)=>termination.push([pid,sig])});
    backend.spec.sha256=crypto.createHash('sha256').update(dummy).digest('hex');
    const result=await backend.start();
    assert.equal(result.phase,'ready');assert.equal(result.platform,resolvePlatform(platform,arch,libc).tag);
    assert.equal(downloads.length,2);
    assert.equal(downloads[0].opts.sha256,backend.spec.sha256);
    assert.equal(commands.filter(c=>c.args[0]==='python').length,1);
    assert.equal(commands.filter(c=>c.args[0]==='sync').length,1);
    assert.equal(launches.length,1);
    assert.equal(launches[0].opts.detached,platform!=='win32');
    assert.deepEqual(launches[0].args.slice(-4),['127.0.0.1','--port','38650','--no-access-log']);
    assert.equal(launches[0].opts.env.STORAGE_BACKEND,'sqlite');
    assert.equal(launches[0].opts.env.DSH_API_HISTORY_DIR,path.join(root,'api-request-history'));
    assert.equal(launches[0].opts.env.CHATGPT2API_AUTH_KEY,ensureManagedFiles(backend.paths));
    assert.equal(fs.readFileSync(backend.paths.marker,'utf8').trim(),SOURCE_COMMIT);
    await backend.stop();
    const pythonInstall=commands.find(c=>c.args[0]==='python'&&c.args[1]==='install');
    assert.ok(pythonInstall.args.includes('--no-bin'),'does not expose a user-level Python command');
    assert.ok(pythonInstall.args.includes('--no-registry'),'does not register Python with Windows');
    if(platform==='win32')assert.ok(commands.some(c=>c.bin==='taskkill.exe'));
    else assert.deepEqual(termination,[[123456,'SIGTERM']]);
    // A restart is not attempted after DSH unload, but installed source and
    // user data remain in the same stable path.
    assert.ok(fs.existsSync(path.join(backend.paths.source,'uv.lock')));
  });
}

test('checksum failures refuse extraction and execution',async t=>{
  const root=temp();t.after(()=>fs.rmSync(root,{force:true,recursive:true}));
  const b=new PlatformBackend({dataDir:root},{platform:'linux',arch:'x64',libc:'gnu',
    // Nothing is listening in this scenario; never probe a real local port from tests.
    fetcher:async()=>({ok:false,json:async()=>null}),
    downloader:async(_,file)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'wrong archive')},
    extractTar:()=>{throw Error('should not extract')}});
  await assert.rejects(()=>b.start(),/SHA256/);
  assert.equal(b.phase,'error');
});

test('disabled startup does not download or request credentials',async t=>{
  const root=temp();t.after(()=>fs.rmSync(root,{force:true,recursive:true}));
  const b=new PlatformBackend({dataDir:root,autoStart:false},{platform:'darwin',arch:'arm64'});
  assert.equal((await b.start()).phase,'disabled');
  assert.equal(fs.readdirSync(root).length,0);
});


test('probePythonExecutable safely returns null for invalid executables', () => {
  assert.equal(probePythonExecutable(''), null);
  assert.equal(probePythonExecutable('definitely-not-a-real-python-binary-12345'), null);
});

test('PlatformBackend reuses detected system Python and skips uv python download', async t => {
  const root = temp();
  t.after(() => fs.rmSync(root, {force: true, recursive: true}));
  const dummy = Buffer.from('pretend archive version 0.9.13');
  const commands = [];
  const downloader = async (url, file, opts) => { fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, dummy); };
  const extractor = (archive, dest) => {
    if (archive.endsWith('.tar.gz') || archive.includes('uv-')) {
      fs.mkdirSync(path.dirname(dest), {recursive: true}); fs.writeFileSync(dest, 'fake-uv');
    } else {
      const dir = path.join(dest, `chatgpt2api-${SOURCE_COMMIT}`);
      fs.mkdirSync(dir, {recursive: true});
      for (const file of ['pyproject.toml', 'uv.lock', 'main.py']) fs.writeFileSync(path.join(dir, file), 'stub');
      for (const folder of ['api', 'services', 'utils']) fs.mkdirSync(path.join(dir, folder));
    }
  };
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 999; child.kill = () => {};
  const state = {spawned: false};
  const executor = async (bin, args) => {
    commands.push({bin, args});
    if (args[0] === 'sync') installVenv(root, resolvePlatform('linux', 'x64', 'gnu'));
    return '';
  };

  const fakeSysPy = '/usr/local/bin/python3.13';
  const backend = new PlatformBackend({dataDir: root}, {
    platform: 'linux', arch: 'x64', libc: 'gnu',
    downloader, extractZip: extractor, extractTar: extractor, executor,
    systemPythonFinder: () => ({path: fakeSysPy, version: '3.13', major: 3, minor: 13, source: 'system'}),
    spawner: (bin, args, opts) => { state.spawned = true; return child; },
    portProbe: async () => {},
    fetcher: healthFetcher(state),
    sleeper: async () => {},
    groupKiller: () => {}
  });
  backend.spec.sha256 = crypto.createHash('sha256').update(dummy).digest('hex');
  const result = await backend.start();

  assert.equal(result.phase, 'ready');
  // Must skip uv python install (0 calls)
  assert.equal(commands.filter(c => c.args[0] === 'python' && c.args[1] === 'install').length, 0);
  // Reuses the system interpreter, but keeps the dependency set isolated so a
  // globally installed package cannot silently satisfy (and drift) the lock.
  assert.ok(commands.some(c => c.args[0] === 'venv' && c.args.includes(fakeSysPy) && !c.args.includes('--system-site-packages')));
  // Must sync with detected system python
  assert.ok(commands.some(c => c.args[0] === 'sync' && c.args.includes(fakeSysPy)));
  // Runtime reflects system Python
  assert.match(backend.status().runtime, /system-python/);
  // Marker records the concrete interpreter so a later repair can notice it is gone
  assert.match(fs.readFileSync(path.join(backend.paths.source, '.dsh-runtime-ready'), 'utf8'), /system:\/usr\/local\/bin\/python3\.13/);

  await backend.stop();
});

test('system site-packages inheritance stays opt-in for deliberate GPU/CUDA use', async t => {
  const root = temp();
  const commands = [];
  t.after(() => { delete process.env.DSH_CHATGPT2API_SYSTEM_SITE_PACKAGES; fs.rmSync(root, {force: true, recursive: true}); });
  fs.mkdirSync(path.join(root, 'source'), {recursive: true});
  fs.writeFileSync(path.join(root, 'source', 'uv.lock'), 'stub');
  const executor = async (bin, args) => {
    commands.push({bin, args});
    if (args[0] === 'sync') installVenv(root, resolvePlatform('linux', 'x64', 'gnu'));
    return '';
  };
  const fakeSysPy = '/usr/bin/python3.13';
  const build = () => new PlatformBackend({dataDir: root}, {
    platform: 'linux', arch: 'x64', libc: 'gnu', executor,
    systemPythonFinder: () => ({path: fakeSysPy, version: '3.13', major: 3, minor: 13, source: 'system'})
  });

  const isolated = build();
  assert.equal(isolated.inheritSystemPackages, false);
  await isolated._installPython();
  const isolatedVenv = commands.find(c => c.args[0] === 'venv');
  assert.ok(isolatedVenv && !isolatedVenv.args.includes('--system-site-packages'));

  commands.length = 0;
  fs.rmSync(path.join(root, 'source', '.venv'), {force: true, recursive: true});
  process.env.DSH_CHATGPT2API_SYSTEM_SITE_PACKAGES = '1';
  const inherited = build();
  assert.equal(inherited.inheritSystemPackages, true);
  await inherited._installPython();
  const inheritedVenv = commands.find(c => c.args[0] === 'venv');
  assert.ok(inheritedVenv && inheritedVenv.args.includes('--system-site-packages'));
});

test('Python provisioning stays private despite inherited uv environment overrides', async t => {
  const inherited = {
    UV_PROJECT_ENVIRONMENT: '/other-app/.venv', uv_project: '/other-app',
    uv_working_directory: '/other-app', UV_PYTHON_INSTALL_DIR: '/shared/python',
    UV_CACHE_DIR: '/shared/cache', UV_PYTHON_INSTALL_BIN: '1', UV_PYTHON_INSTALL_REGISTRY: '1'
  };
  const previous = Object.fromEntries(Object.keys(inherited).map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  Object.assign(process.env, inherited);

  for (const mode of ['download', 'system', 'repair']) await t.test(mode, async t => {
    const root = temp();
    t.after(() => fs.rmSync(root, {force: true, recursive: true}));
    const spec = resolvePlatform('linux', 'x64', 'gnu');
    const paths = primeRuntime(root);
    if (mode === 'repair') installVenv(root, spec, {packages: ['fastapi']});
    const commands = [];
    const backend = new PlatformBackend({dataDir: root}, {
      platform: 'linux', arch: 'x64', libc: 'gnu',
      systemPythonFinder: () => mode === 'system' ? {path: '/usr/bin/python3.13', version: '3.13'} : null,
      probeInterpreter: () => ({major: 3, minor: 13}),
      executor: async (bin, args, options) => {
        commands.push({args, env: options.env});
        if (args[0] === 'sync') installVenv(root, spec);
        return '';
      }
    });
    await backend._installPython();
    assert.ok(commands.some(c => c.args[0] === 'sync'));
    for (const {env} of commands) {
      assert.equal(env.UV_PROJECT_ENVIRONMENT, path.join(paths.source, '.venv'));
      assert.equal(env.UV_PYTHON_INSTALL_DIR, paths.python);
      assert.equal(env.UV_CACHE_DIR, paths.uvCache);
      assert.equal(env.UV_PYTHON_INSTALL_BIN, '0');
      assert.equal(env.UV_PYTHON_INSTALL_REGISTRY, '0');
      assert.ok(!Object.keys(env).some(key => ['UV_PROJECT', 'UV_WORKING_DIRECTORY'].includes(key.toUpperCase())));
    }
    for (const [key, value] of Object.entries(inherited)) assert.equal(process.env[key], value);
  });
});

test('runtime integrity check reports a venv whose interpreter or site-packages vanished', t => {
  const root = temp();
  t.after(() => fs.rmSync(root, {force: true, recursive: true}));
  const spec = resolvePlatform('linux', 'x64', 'gnu');
  const paths = managedPaths({root, platform: 'linux', arch: 'x64', libc: 'gnu'});
  fs.mkdirSync(paths.source, {recursive: true});
  assert.equal(pythonEnvIssue(paths, spec).reason, 'python-missing');
  const {site} = installVenv(root, spec);
  assert.equal(pythonEnvIssue(paths, spec), null);
  fs.rmSync(site, {recursive: true, force: true});
  assert.equal(pythonEnvIssue(paths, spec).reason, 'site-packages-missing');
  installVenv(root, spec, {packages: ['fastapi', 'uvicorn', 'starlette']});
  const issue = pythonEnvIssue(paths, spec);
  assert.equal(issue.reason, 'packages-missing');
  assert.deepEqual(issue.missing, ['anyio']);
});

test('a damaged venv is repaired in place instead of being trusted by the ready marker', async t => {
  const root = temp();
  t.after(() => fs.rmSync(root, {force: true, recursive: true}));
  const spec = resolvePlatform('linux', 'x64', 'gnu');
  const paths = primeRuntime(root);
  // The exact failure mode seen in the field: marker + interpreter present,
  // site-packages gone, so /health passes and the first lazy import crashes.
  fs.writeFileSync(path.join(paths.source, '.dsh-runtime-ready'), '2026-01-01T00:00:00.000Z linux-x64-gnu system:/usr/local/bin/python3.13\n');
  const py = path.join(paths.source, '.venv', spec.pythonRelative);
  fs.mkdirSync(path.dirname(py), {recursive: true});
  fs.writeFileSync(py, 'python-stub');

  const commands = [];
  const state = {spawned: false};
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 4242; child.kill = () => {};
  const backend = new PlatformBackend({dataDir: root}, {
    platform: 'linux', arch: 'x64', libc: 'gnu',
    executor: async (bin, args) => { commands.push({bin, args}); if (args[0] === 'sync') installVenv(root, spec); return ''; },
    spawner: () => { state.spawned = true; return child; },
    probeInterpreter: () => ({path: py, major: 3, minor: 13, inVenv: false}),
    portProbe: async () => {}, fetcher: healthFetcher(state), sleeper: async () => {}, groupKiller: () => {}
  });

  const status = await backend.start();
  assert.equal(status.phase, 'ready');
  const sync = commands.filter(c => c.args[0] === 'sync');
  assert.equal(sync.length, 1);
  assert.ok(!sync[0].args.includes('--python'), 'repair keeps the pinned interpreter');
  assert.equal(commands.filter(c => c.args[0] === 'venv').length, 0, 'does not recreate the venv');
  // The repair must not lose track of which interpreter the venv is based on.
  assert.match(fs.readFileSync(path.join(paths.source, '.dsh-runtime-ready'), 'utf8'), /system:\/usr\/local\/bin\/python3\.13/);
});

test('an unusable or outdated venv is rebuilt instead of reused', async t => {
  for(const previous of [null,{major:3,minor:12,version:'3.12'}])await t.test(previous?'Python 3.12':'interpreter cannot run',async t=>{
  const root = temp();
  t.after(() => fs.rmSync(root, {force: true, recursive: true}));
  const spec = resolvePlatform('linux', 'x64', 'gnu');
  const paths = primeRuntime(root);
  installVenv(root, spec);
  fs.writeFileSync(path.join(paths.source, '.dsh-runtime-ready'), '2026-01-01T00:00:00.000Z linux-x64-gnu system:/opt/python3.13/bin/python\n');
  const commands = [];
  const state = {spawned: false};
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 31; child.kill = () => {};
  const backend = new PlatformBackend({dataDir: root}, {
    platform: 'linux', arch: 'x64', libc: 'gnu',
    executor: async (bin, args) => { commands.push({bin, args}); if (args[0] === 'sync') installVenv(root, spec); return ''; },
    spawner: () => { state.spawned = true; return child; },
    probeInterpreter: () => previous,
    systemPythonFinder: () => ({path: '/usr/bin/python3.13', version: '3.13', major: 3, minor: 13, source: 'system'}),
    portProbe: async () => {}, fetcher: healthFetcher(state), sleeper: async () => {}, groupKiller: () => {}
  });

  const status = await backend.start();
  assert.equal(status.phase, 'ready');
  assert.equal(commands.filter(c => c.args[0] === 'venv').length, 1, 'recreates the venv');
  assert.ok(commands.some(c => c.args[0] === 'venv' && c.args.includes('/usr/bin/python3.13')));
  assert.match(fs.readFileSync(path.join(paths.source, '.dsh-runtime-ready'), 'utf8'), /system:\/usr\/bin\/python3\.13/);
  });
});

test('a broken Python environment that cannot be removed is never silently reused',async t=>{
  const root=temp();
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const spec=resolvePlatform('linux','x64','gnu');
  const paths=primeRuntime(root);
  installVenv(root,spec);
  const venv=path.join(paths.source,'.venv');
  const remove=fs.rmSync;
  t.mock.method(fs,'rmSync',(target,options)=>{
    if(target===venv)throw Object.assign(new Error('directory is busy'),{code:'EBUSY'});
    return remove(target,options);
  });
  const backend=new PlatformBackend({dataDir:root},{
    platform:'linux',arch:'x64',libc:'gnu',
    probeInterpreter:()=>({major:3,minor:12,version:'3.12'}),
    sleeper:async()=>{},
    executor:()=>assert.fail('must stop before attempting to use or repair an unremovable environment'),
  });
  await assert.rejects(backend._installPython(),/无法重建 Python.*权限|无法重建 Python.*占用/);
  assert.ok(fs.existsSync(venv),'the failure is reported without pretending the directory was removed');
});

test('an already running backend is adopted instead of failing on the busy port', async t => {
  const root = temp();
  t.after(() => fs.rmSync(root, {force: true, recursive: true}));
  let spawned = 0;
  let provisioned = 0;
  const fetcher = async url => {
    const route = new URL(url).pathname;
    if (route === '/health') return {ok: true, json: async () => ({status: 'ok', healthy: true})};
    if (route === '/api/accounts') return {ok: true, json: async () => ({items: []})};
    throw Error('unexpected ' + route);
  };
  const backend = new PlatformBackend({dataDir: root}, {
    platform: 'linux', arch: 'x64', libc: 'gnu', fetcher,
    spawner: () => { spawned += 1; throw Error('must not spawn'); },
    executor: async () => { provisioned += 1; return ''; },
    portProbe: async () => { throw Error('port busy'); }
  });

  const status = await backend.start();
  assert.equal(status.phase, 'ready');
  assert.equal(status.adopted, true);
  assert.equal(spawned, 0);
  assert.equal(provisioned, 0);
  assert.match(status.message, /接管/);

  await backend.stop();
  assert.match(backend.message, /不属于本实例/);
});

test('a foreign service on the port fails with actionable guidance', async t => {
  const root = temp();
  t.after(() => fs.rmSync(root, {force: true, recursive: true}));
  let spawned = 0;
  const fetcher = async url => {
    const route = new URL(url).pathname;
    if (route === '/health') return {ok: true, json: async () => ({status: 'ok'})};
    if (route === '/api/accounts') return {ok: false, status: 401, json: async () => ({})};
    throw Error('unexpected ' + route);
  };
  const backend = new PlatformBackend({dataDir: root}, {
    platform: 'linux', arch: 'x64', libc: 'gnu', fetcher,
    spawner: () => { spawned += 1; throw Error('must not spawn'); },
    executor: async () => '', portProbe: async () => {}
  });

  await assert.rejects(() => backend.start(), /另一个 chatgpt2api/);
  assert.equal(spawned, 0);
  assert.equal(backend.phase, 'error');
  assert.match(backend.error, /DSH_CHATGPT2API_PORT/);
});

test('an unexpected backend exit is retried a bounded number of times', async t => {
  const root = temp();
  t.after(() => fs.rmSync(root, {force: true, recursive: true}));
  const spec = resolvePlatform('linux', 'x64', 'gnu');
  const paths = primeRuntime(root);
  installVenv(root, spec);
  fs.writeFileSync(path.join(paths.source, '.dsh-runtime-ready'), '2026-01-01T00:00:00.000Z linux-x64-gnu managed-3.13\n');
  const state = {spawned: false};
  let launches = 0;
  // A real spawner returns a fresh child each time; reusing one emitter would
  // attach a second 'close' listener and fire two restart paths per crash.
  const children = [];
  const spawnChild = () => {
    const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.pid = 700 + children.length; c.kill = () => {};
    children.push(c);
    return c;
  };
  const backend = new PlatformBackend({dataDir: root, restartDelays: [1]}, {
    platform: 'linux', arch: 'x64', libc: 'gnu',
    executor: async () => '', spawner: () => { launches += 1; state.spawned = true; return spawnChild(); },
    probeInterpreter: () => ({path: 'stub', major: 3, minor: 13, inVenv: false}),
    portProbe: async () => {}, fetcher: healthFetcher(state), sleeper: async () => {}, groupKiller: () => {}
  });

  await backend.start();
  assert.equal(launches, 1);

  state.spawned = false;
  children.at(-1).emit('close', 1);
  await flush();
  assert.equal(launches, 2, 'restarts after an unexpected exit');
  assert.equal(backend.phase, 'ready');

  for (let i = 0; i < backend.maxRestarts; i += 1) {
    state.spawned = false;
    children.at(-1).emit('close', 1);
    await flush();
  }
  assert.equal(launches, 1 + backend.maxRestarts);
  assert.equal(backend.phase, 'error');
  assert.match(backend.error, /反复退出/);
});

test('system interpreter candidates prefer OS installs over PATH shims', () => {
  assert.equal(MINIMUM_PYTHON_MINOR, 13);
  const linux = systemPythonCandidates('linux', {});
  assert.equal(linux[0].exe, 'python3.13');
  assert.ok(linux.some(c => c.exe === '/usr/bin/python3.13'));
  const win = systemPythonCandidates('win32', {LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local'});
  assert.deepEqual(win[0], {exe: 'py', args: ['-3.13'], kind: 'windows-launcher'});
  assert.ok(win.some(c => c.exe.endsWith('Programs\\Python\\Python313\\python.exe')));
  assert.ok(Array.isArray(windowsRegistryPythons()));
});
