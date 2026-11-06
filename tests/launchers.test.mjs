import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {supportsNodeVersion} from '../scripts/launch.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));

// Exercise the shipped entry points against tiny local service/build modules.
// No real account data, backend downloads or network calls are involved.
function fixture(t, {buildExit = 0, keepAlive = false} = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'c2a-launcher-'));
  const project = path.join(temporary, '项目 空格 ! & (测试)');
  const outside = path.join(temporary, 'another working directory');
  const eventsFile = path.join(temporary, 'events.jsonl');
  const children = new Set();
  fs.mkdirSync(path.join(project, 'scripts'), {recursive: true});
  fs.mkdirSync(outside);
  fs.copyFileSync(path.join(repository, 'scripts/launch.mjs'), path.join(project, 'scripts/launch.mjs'));
  fs.copyFileSync(path.join(repository, 'start.sh'), path.join(project, 'start.sh'));
  fs.chmodSync(path.join(project, 'start.sh'), 0o755);
  const record = `import fs from 'node:fs';
const record = (kind, extra = {}) => fs.appendFileSync(process.env.C2A_TEST_LAUNCH_EVENTS,
  JSON.stringify({kind, pid: process.pid, cwd: process.cwd(), ...extra}) + '\\n');
`;
  fs.writeFileSync(path.join(project, 'scripts/build.mjs'), record + `
record('build');
process.exitCode = Number(process.env.C2A_TEST_BUILD_EXIT || 0);
`);
  fs.writeFileSync(path.join(project, 'scripts/start.mjs'), record + `
export function parseOptions(args = process.argv.slice(2)) {
  record('validate', {args});
  if (args.includes('--invalid-option')) throw new Error('fixture: invalid option');
  return {help: args.includes('--help') || args.includes('-h')};
}
export async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    record('help');
    console.info('fixture help');
    return;
  }
  record('main', {args});
  if (process.env.C2A_TEST_KEEP_ALIVE === '1') {
    const timer = setInterval(() => {}, 1000);
    process.once('SIGTERM', () => {
      record('cleaned', {signal: 'SIGTERM'});
      clearInterval(timer);
    });
    console.info('FIXTURE_READY');
  }
}
`);
  const env = {
    ...process.env,
    C2A_TEST_LAUNCH_EVENTS: eventsFile,
    C2A_TEST_BUILD_EXIT: String(buildExit),
    C2A_TEST_KEEP_ALIVE: keepAlive ? '1' : '0',
  };
  t.after(async () => {
    await Promise.all([...children].map(child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      return new Promise(resolve => {
        child.once('close', resolve);
        child.kill('SIGKILL');
      });
    }));
    fs.rmSync(temporary, {recursive: true, force: true});
  });
  return {
    project, outside, env,
    entry: path.join(project, 'scripts/launch.mjs'),
    shell: path.join(project, 'start.sh'),
    track(child) { children.add(child); return child; },
    events() {
      return fs.existsSync(eventsFile)
        ? fs.readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
        : [];
    },
  };
}

function run(f, args = [], {shell = '', entry = f.entry} = {}) {
  const result = spawnSync(shell || process.execPath,
    [shell ? f.shell : entry, ...args], {
      cwd: f.outside, env: f.env, encoding: 'utf8', timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return result;
}

test('launcher Node version check compares major and minor components correctly', () => {
  for (const [version, expected] of [
    ['18.20.0', false], ['20.9.0', false], ['20.10.0', false],
    ['20.11.0', true], ['20.11.1', true], ['v20.11.0', true],
    ['22.0.0', true], ['24.1.0', true], ['invalid', false],
  ]) assert.equal(supportsNodeVersion(version), expected, version);
});

test('shared launcher builds before starting the service and preserves argument boundaries', t => {
  const f = fixture(t);
  const args = ['--data-dir', path.join(f.project, '账号 数据 ! &'), '--no-open'];
  const result = run(f, args);
  assert.equal(result.status, 0, result.stderr);
  const events = f.events();
  assert.deepEqual(events.map(event => event.kind), ['validate', 'build', 'main']);
  assert.deepEqual(events[0].args, args);
  assert.deepEqual(events[2].args, args);
  assert.equal(events[1].cwd, fs.realpathSync(f.project), 'building must use the project directory');
  assert.equal(events[2].cwd, fs.realpathSync(f.outside), 'direct CLI calls retain their relative-path context');
  assert.equal(events[0].pid, events[2].pid, 'the service runs in the launcher process');
});

test('shared launcher help prints without building or starting a service', async t => {
  for (const flag of ['--help', '-h']) await t.test(flag, t => {
    const f = fixture(t, {buildExit: 9});
    const result = run(f, [flag]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /fixture help/);
    assert.deepEqual(f.events().map(event => event.kind), ['validate', 'help']);
  });
});

test('a failed page build preserves its exit code and never starts a service', t => {
  const f = fixture(t, {buildExit: 7});
  const result = run(f);
  assert.equal(result.status, 7, result.stderr);
  assert.match(result.stderr, /页面构建失败/);
  assert.deepEqual(f.events().map(event => event.kind), ['validate', 'build']);
});

test('invalid launch arguments fail before any build or service startup', t => {
  const f = fixture(t);
  const result = run(f, ['--invalid-option']);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /invalid option/);
  assert.deepEqual(f.events().map(event => event.kind), ['validate']);
});

test('a project reached through a symbolic link still executes its launcher', {
  skip: process.platform === 'win32' ? 'Windows symbolic links may require extra privileges' : false,
}, t => {
  const f = fixture(t);
  const linkedProject = path.join(f.outside, 'linked project');
  fs.symlinkSync(f.project, linkedProject, 'dir');
  const result = run(f, ['--no-open'], {entry: path.join(linkedProject, 'scripts/launch.mjs')});
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.events().map(event => event.kind), ['validate', 'build', 'main']);
});

test('POSIX launcher finds its project from another directory and preserves complex paths', {
  skip: process.platform === 'win32' ? 'requires a POSIX shell' : false,
}, t => {
  const f = fixture(t);
  const args = ['--data-dir', path.join(f.project, '账号 数据 ! &'), '--web-port', '40901', '--no-open'];
  const result = run(f, args, {shell: '/bin/sh'});
  assert.equal(result.status, 0, result.stderr);
  const events = f.events();
  assert.deepEqual(events.map(event => event.kind), ['validate', 'build', 'main']);
  assert.deepEqual(events[2].args, args);
  assert.ok(events.every(event => event.cwd === fs.realpathSync(f.project)), 'all startup stages use the located project');
});

test('POSIX launcher help skips building and exits without waiting for interactive input', {
  skip: process.platform === 'win32' ? 'requires a POSIX shell' : false,
}, t => {
  const f = fixture(t, {buildExit: 9});
  const result = run(f, ['--help'], {shell: '/bin/sh'});
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.events().map(event => event.kind), ['validate', 'help']);
});

test('POSIX launcher returns build errors without masking their exit code or hanging', {
  skip: process.platform === 'win32' ? 'requires a POSIX shell' : false,
}, t => {
  const f = fixture(t, {buildExit: 7});
  const result = run(f, ['--no-open'], {shell: '/bin/sh'});
  assert.equal(result.status, 7, result.stderr);
  assert.match(result.stderr, /页面构建失败/);
  assert.deepEqual(f.events().map(event => event.kind), ['validate', 'build']);
});

test('portable launcher also runs under dash without Bash extensions', {
  skip: process.platform === 'win32' || !fs.existsSync('/bin/dash') ? 'dash is not available' : false,
}, t => {
  const f = fixture(t);
  const args = ['--data-dir', path.join(f.project, '账号 数据 ! &'), '--no-open'];
  const result = run(f, args, {shell: '/bin/dash'});
  assert.equal(result.status, 0, result.stderr);
  const events = f.events();
  assert.deepEqual(events.map(event => event.kind), ['validate', 'build', 'main']);
  assert.deepEqual(events[2].args, args);
  assert.ok(events.every(event => event.cwd === fs.realpathSync(f.project)));
});

test('service shutdown signals reach main in the same process and allow cleanup', {
  skip: process.platform === 'win32' ? 'Windows termination uses different signal semantics' : false,
  timeout: 10000,
}, async t => {
  const f = fixture(t, {keepAlive: true});
  const child = f.track(spawn(process.execPath, [f.entry, '--no-open'], {
    cwd: f.outside, env: f.env, stdio: ['ignore', 'pipe', 'pipe'],
  }));
  let stdout = '', stderr = '';
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({code, signal}));
  });
  let timer;
  const ready = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('launcher readiness timed out: ' + stderr)), 5000);
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      if (stdout.includes('FIXTURE_READY')) resolve();
    });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (!stdout.includes('FIXTURE_READY')) reject(new Error(`launcher exited before ready (${code}, ${signal}): ${stderr}`));
    });
  });
  try { await ready; } finally { clearTimeout(timer); }
  assert.equal(child.kill('SIGTERM'), true);
  const result = await exited;
  assert.deepEqual(result, {code: 0, signal: null}, stderr);
  const events = f.events();
  assert.deepEqual(events.map(event => event.kind), ['validate', 'build', 'main', 'cleaned']);
  assert.equal(events.find(event => event.kind === 'main').pid, child.pid);
  assert.equal(events.find(event => event.kind === 'cleaned').pid, child.pid);
  assert.equal(events.at(-1).signal, 'SIGTERM');
});
