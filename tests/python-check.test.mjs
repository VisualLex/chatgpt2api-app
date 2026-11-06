import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {inspectPythonEnvironment, reportPythonEnvironment} from '../scripts/python-check.mjs';
import {detectSystemPython, probePythonExecutable} from '../lib/platform-backend.js';

const repository = fileURLToPath(new URL('../', import.meta.url));
const compatible = pythonPath => ({path: pythonPath, major: 3, minor: 13, version: '3.13', inVenv: true});

// Use inert files and injected probes. These checks never install Python,
// execute account backends, access real data directories or contact a network.
function fixture(t, {platform = 'linux', environment = 'ready', probe, finder} = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'c2a-python-check-'));
  const root = path.join(temporary, '指定 数据目录 ! &');
  const source = path.join(root, 'source');
  const environmentPath = path.join(source, '.venv');
  const pythonRelative = platform === 'win32' ? path.join('Scripts', 'python.exe') : path.join('bin', 'python');
  const pythonPath = path.join(environmentPath, pythonRelative);
  const sitePackages = platform === 'win32'
    ? path.join(environmentPath, 'Lib', 'site-packages')
    : path.join(environmentPath, 'lib', 'python3.13', 'site-packages');
  fs.mkdirSync(root, {recursive: true});
  if (environment !== 'none') fs.mkdirSync(environmentPath, {recursive: true});
  if (!['none', 'missing-interpreter'].includes(environment)) {
    fs.mkdirSync(path.dirname(pythonPath), {recursive: true});
    fs.writeFileSync(pythonPath, 'inert interpreter fixture');
  }
  if (environment === 'ready' || environment === 'missing-package') {
    fs.mkdirSync(sitePackages, {recursive: true});
    for (const name of ['anyio', 'fastapi', 'uvicorn', 'starlette']) {
      if (environment !== 'missing-package' || name !== 'anyio') fs.mkdirSync(path.join(sitePackages, name));
    }
  }
  const probes = [], searches = [];
  const manager = {
    paths: {root, source, uv: path.join(root, 'runtime', platform === 'win32' ? 'uv.exe' : 'uv')},
    spec: {platform, pythonRelative},
    configPython: '',
    uvEnv: {},
    probeInterpreter(executable) {
      probes.push(executable);
      return probe ? probe(executable) : compatible(executable);
    },
    systemPythonFinder(options) {
      searches.push(options);
      return finder ? finder(options) : null;
    },
    executor: () => assert.fail('checking Python must not run installation commands'),
    downloader: () => assert.fail('checking Python must not download anything'),
    _installPython: () => assert.fail('checking Python must not repair an environment'),
  };
  t.after(() => fs.rmSync(temporary, {recursive: true, force: true}));
  return {temporary, root, source, environmentPath, pythonPath, manager, probes, searches};
}

function tree(root) {
  const entries = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = path.join(directory, entry.name);
      const relative = path.relative(root, filename);
      entries.push([relative, entry.isDirectory() ? 'directory' : fs.readFileSync(filename, 'utf8')]);
      if (entry.isDirectory()) visit(filename);
    }
  }
  visit(root);
  return entries;
}

test('Python preflight uses the selected data directory and checks POSIX and Windows environments', async t => {
  for (const platform of ['linux', 'darwin', 'win32']) await t.test(platform, t => {
    const f = fixture(t, {platform});
    const before = tree(f.root);
    const result = inspectPythonEnvironment(f.manager);
    assert.equal(result.state, 'ready');
    assert.equal(result.pythonPath, f.pythonPath);
    assert.equal(result.environmentPath, f.environmentPath);
    assert.equal(result.version, '3.13');
    assert.deepEqual(f.probes, [f.pythonPath]);
    assert.equal(f.searches.length, 0, 'a usable existing environment avoids another system scan');
    assert.deepEqual(tree(f.root), before, 'inspection must not modify the existing runtime');
  });
});

test('broken or incomplete existing Python environments are reported for repair without system scans', async t => {
  const cases = [
    {name: 'missing interpreter', environment: 'missing-interpreter'},
    {name: 'interpreter cannot run', probe: () => null},
    {name: 'interpreter is too old', probe: executable => ({...compatible(executable), minor: 12, version: '3.12'})},
    {name: 'missing site-packages', environment: 'missing-site-packages'},
    {name: 'missing critical dependency', environment: 'missing-package'},
  ];
  for (const item of cases) await t.test(item.name, t => {
    const f = fixture(t, item);
    const before = tree(f.root);
    const result = inspectPythonEnvironment(f.manager);
    assert.equal(result.state, 'repair');
    assert.equal(result.environmentPath, f.environmentPath);
    assert.ok(result.reason, 'the user needs to know why the environment requires repair');
    assert.equal(f.searches.length, 0, 'inspection leaves repair decisions to the backend startup');
    assert.deepEqual(tree(f.root), before, 'diagnosis must not remove or recreate a damaged environment');
  });
});

test('a compatible system Python is reported without creating an environment', t => {
  const systemPython = path.join(os.tmpdir(), '系统 Python 3.13', 'python');
  const f = fixture(t, {environment: 'none', finder: () => ({...compatible(systemPython), inVenv: false, source: 'system'})});
  const before = tree(f.root);
  const result = inspectPythonEnvironment(f.manager);
  assert.equal(result.state, 'system');
  assert.equal(result.pythonPath, systemPython);
  assert.equal(result.version, '3.13');
  assert.equal(result.environmentPath, f.environmentPath);
  assert.equal(f.searches.length, 1);
  assert.deepEqual(tree(f.root), before, 'the check must not create a virtual environment');
});

test('no compatible Python is a nonfatal automatic-download result', t => {
  const f = fixture(t, {environment: 'none'});
  const before = tree(f.root);
  const result = inspectPythonEnvironment(f.manager);
  assert.equal(result.state, 'download');
  assert.equal(result.environmentPath, f.environmentPath);
  assert.equal(f.searches.length, 1);
  assert.deepEqual(tree(f.root), before, 'a download plan must not download or create files');
});

test('an incompatible finder result is never accepted as the backend Python', t => {
  const f = fixture(t, {environment: 'none', finder: () => ({path: '/inert/python3.12', major: 3, minor: 12, version: '3.12'})});
  const result = inspectPythonEnvironment(f.manager);
  assert.equal(result.state, 'download');
  assert.notEqual(result.pythonPath, '/inert/python3.12');
});

test('real system discovery rejects an explicitly configured Python 3.12 while preserving the legacy probe', {
  skip: process.platform === 'win32' ? 'the inert interpreter fixture requires a POSIX shell' : false,
}, t => {
  const f = fixture(t, {environment: 'none'});
  const oldPython = path.join(f.root, 'python3.12');
  const output = `3.12|${oldPython}|0`;
  const quotedOutput = "'" + output.replaceAll("'", "'\\''") + "'";
  fs.writeFileSync(oldPython, `#!/bin/sh\nprintf '%s\\n' ${quotedOutput}\n`, {mode: 0o755});
  const legacy = probePythonExecutable(oldPython);
  assert.ok(legacy, 'the existing public helper intentionally supports Python 3.10+');
  assert.equal(legacy.version, '3.12');
  const selected = detectSystemPython({customPath: oldPython, uvBin: ''});
  assert.notEqual(selected?.path, oldPython, 'backend discovery must reject the old explicit interpreter');
  if (selected) {
    assert.equal(selected.major, 3);
    assert.ok(selected.minor >= 13, 'another system interpreter is usable only when compatible');
  }
});

test('invalid configured Python paths produce a warning while allowing automatic fallback', async t => {
  for (const condition of ['missing', 'too-old']) await t.test(condition, t => {
    const configured = path.join(os.tmpdir(), '指定 Python', 'python');
    const systemPython = path.join(os.tmpdir(), '兼容 Python', 'python');
    const f = fixture(t, {
      environment: 'none',
      probe: executable => executable !== configured ? compatible(executable)
        : condition === 'missing' ? null : {...compatible(configured), minor: 12, version: '3.12'},
      finder: () => ({...compatible(systemPython), inVenv: false, source: 'system'}),
    });
    f.manager.configPython = configured;
    const result = inspectPythonEnvironment(f.manager);
    assert.equal(result.state, 'system');
    assert.equal(result.pythonPath, systemPython);
    assert.ok(result.warning, 'ignored explicit configuration must not be silently hidden');
    assert.match(result.warning, /Python|解释器/);
    assert.equal(f.searches.length, 1);
  });
});

test('Python startup messages explain each result and return the inspection report', async t => {
  const cases = [
    {name: 'ready', options: {}, expected: /可用|复用|已就绪/},
    {name: 'repair', options: {environment: 'missing-package'}, expected: /修复|重建/},
    {name: 'system', options: {environment: 'none', finder: () => ({...compatible('/inert/python3.13'), inVenv: false})}, expected: /系统 Python|兼容.*Python|Python.*3\.13/},
    {name: 'download', options: {environment: 'none'}, expected: /自动.*下载|下载.*Python|自动.*准备/},
  ];
  for (const item of cases) await t.test(item.name, t => {
    const f = fixture(t, item.options), lines = [];
    const result = reportPythonEnvironment(f.manager, {log: (...values) => lines.push(values.join(' '))});
    assert.equal(result.state, item.name);
    assert.match(lines[0], /检查.*Python|Python.*检查/);
    assert.match(lines.slice(1).join('\n'), item.expected);
    assert.doesNotMatch(lines.join('\n'), /全部依赖.*(?:可用|通过)|所有依赖.*(?:可用|通过)|依赖全部.*(?:可用|通过)/,
      'a filesystem check must not claim that every dependency was imported successfully');
  });
});

test('startup help skips Python checks and creates no runtime data', t => {
  const f = fixture(t, {environment: 'none'});
  const absentData = path.join(f.temporary, 'help-must-not-create-this');
  const result = spawnSync(process.execPath, [path.join(repository, 'scripts/launch.mjs'), '--help'], {
    cwd: repository,
    env: {...process.env, CHATGPT2API_HOME: absentData, CHATGPT2API_PYTHON: '/invalid/explicit/python'},
    encoding: 'utf8', timeout: 5000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--python/);
  assert.doesNotMatch(result.stdout, /正在检查.*Python|Python.*环境检查/);
  assert.equal(fs.existsSync(absentData), false);
});
