import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {takeLoginToken, api} from '../web/session.js';
import {React} from '../web/react.js';
import {createChatGPT2APIDashboard} from '../web/dashboard.js';

test('login token is removed from the address before use and is not stored', () => {
  const calls = [];
  const token = 'a'.repeat(64);
  const actual = takeLoginToken({hash: '#token=' + token, pathname: '/', search: ''}, {
    replaceState: (...args) => calls.push(args),
  });
  assert.equal(actual, token);
  assert.deepEqual(calls, [[null, '', '/']]);
  assert.equal(takeLoginToken({hash: '', pathname: '/', search: ''}, {
    replaceState: () => assert.fail('plain page reload must keep its URL'),
  }), '');
});

test('web session calls use same-origin cookies and preserve HTTP auth failures', async () => {
  let captured;
  const fetcher = async (url, options) => {
    captured = {url, options};
    return new Response(JSON.stringify({authenticated: true}), {status: 200});
  };
  assert.deepEqual(await api('/api/session', {method: 'POST', body: {token: 'local-token'}, fetcher}), {authenticated: true});
  assert.equal(captured.options.credentials, 'same-origin');
  assert.equal(captured.options.body, JSON.stringify({token: 'local-token'}));
  await assert.rejects(api('/api/runtime', {
    fetcher: async () => new Response(JSON.stringify({error: '会话已失效'}), {status: 401}),
  }), error => error.status === 401 && error.message === '会话已失效');
});

test('standalone React adapter provides official hooks and live text-input changes', () => {
  for (const name of ['useState', 'useEffect', 'useMemo', 'useCallback', 'useLayoutEffect', 'useRef', 'Fragment']) {
    assert.equal(typeof React[name], 'function', name);
  }
  const update = () => {};
  for (const type of ['input', 'textarea']) {
    const element = React.createElement(type, {onChange: update});
    assert.equal(element.props.onInput, update);
    assert.equal(element.props.onChange, undefined);
  }
  for (const type of ['file', 'checkbox', 'radio']) {
    assert.equal(React.createElement('input', {type, onChange: update}).props.onChange, update);
  }
  assert.equal(React.createElement('select', {onChange: update}).props.onChange, update);
});

test('standalone dashboard uses the configured API and has no visible DSH service dependency', () => {
  const hooks = {
    Fragment: 'fragment', createElement: (type, props, ...children) => ({type, props: props || {}, children}),
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {}, useLayoutEffect: () => {}, useMemo: fn => fn(),
    useRef: value => ({current: value}), useCallback: fn => fn,
  };
  const panel = createChatGPT2APIDashboard(hooks, '', {standalone: true, baseUrl: 'http://127.0.0.1:39000'});
  function text(node) {
    if (node == null || node === false) return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(text).join('');
    if (typeof node.type === 'function') return text(node.type({...node.props, children: node.children}));
    return node.children.map(text).join('');
  }
  const visible = text(panel.Dashboard());
  assert.match(visible, /运行设置/);
  assert.match(visible, /http:\/\/127\.0\.0\.1:39000\/v1/);
  assert.match(visible, /复制地址/);
  assert.match(visible, /最近任务/);
  assert.match(visible, /管理 API Key/);
  assert.doesNotMatch(visible, /DSH|ctx\.chatgpt2api|插件设置/);
});

test('dashboard synchronizes the document theme only when running standalone', () => {
  const source = fs.readFileSync(new URL('../web/dashboard.js', import.meta.url), 'utf8')
    .replace(/^export \{[^}]+\};\s*$/m, '');
  for (const standalone of [false, true]) {
    const attributes = [], layouts = [];
    const createPanel = vm.runInNewContext(source + '\ncreateChatGPT2APIDashboard;', {
      URL, URLSearchParams,
      localStorage: {
        getItem: key => key === 'chatgpt2api.theme' ? 'light' : null,
        setItem: () => assert.fail('applying a theme must not overwrite its saved preference'),
      },
      document: {documentElement: {setAttribute: (...args) => attributes.push(args)}},
    });
    const hooks = {
      Fragment: 'fragment', createElement: (type, props, ...children) => ({type, props: props || {}, children}),
      useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
      useEffect: () => {}, useLayoutEffect: effect => layouts.push(effect), useMemo: fn => fn(),
      useRef: value => ({current: value}), useCallback: fn => fn,
    };
    const tree = createPanel(hooks, '', {standalone}).Dashboard();
    assert.equal(tree.props['data-theme'], 'light');
    for (const effect of layouts) effect();
    assert.deepEqual(attributes, standalone ? [['data-c2a-theme', 'light']] : [],
      'the optional plugin must leave the host document theme untouched');
  }
});

test('independent web assets use local modules and no inline executable code', () => {
  const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.match(html, /type="module" src="\/app\.js"/);
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) assert.equal(script[1].trim(), '');
  assert.doesNotMatch(html, /https?:\/\//);
  const standalone = fs.readFileSync(new URL('../web/dashboard.js', import.meta.url), 'utf8');
  assert.doesNotMatch(standalone, /__ModuleLoader__/);
  const source = fs.readFileSync(new URL('../src/client/dashboard.js', import.meta.url), 'utf8');
  assert.ok(standalone.includes(source), 'build output must track shared dashboard source');
});

function mountAppWithPendingRequests(hash = '', theme = 'dark') {
  const slots = [], pendingEffects = [], requests = [], listeners = new Map();
  const appliedThemes = [];
  let cursor = 0, component, themeBeforeMount;
  const same = (a, b) => a && b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  const memo = (fn, deps) => {
    const index = cursor++;
    if (!slots[index] || !same(slots[index].deps, deps)) slots[index] = {value: fn(), deps};
    return slots[index].value;
  };
  const hooks = {
    createElement: (type, props, ...children) => ({type, props: props || {}, children}),
    useState(initial) {
      const index = cursor++;
      slots[index] ||= {value: typeof initial === 'function' ? initial() : initial};
      return [slots[index].value, value => { slots[index].value = typeof value === 'function' ? value(slots[index].value) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      slots[index] ||= {current: initial};
      return slots[index];
    },
    useMemo: memo,
    useCallback: (fn, deps) => memo(() => fn, deps),
    useEffect(effect, deps) {
      const index = cursor++;
      if (!slots[index] || !same(slots[index].deps, deps)) {
        pendingEffects.push(() => {
          slots[index]?.cleanup?.();
          slots[index] = {deps, cleanup: effect()};
        });
      }
    },
  };
  const location = {hash, pathname: '/', search: ''};
  const history = {replaceState() { location.hash = ''; }};
  const window = {
    location, history,
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: (name, callback) => { if (listeners.get(name) === callback) listeners.delete(name); },
  };
  const source = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
  vm.runInNewContext(source, {
    React: hooks, render: vnode => { themeBeforeMount = appliedThemes.at(-1); component = vnode.type; },
    createChatGPT2APIDashboard: () => ({Dashboard: () => null}), takeLoginToken,
    readDashboardTheme: () => theme, applyDashboardTheme: value => appliedThemes.push(value),
    api: (path, options) => new Promise((resolve, reject) => requests.push({path, options, resolve, reject})),
    window, document: {getElementById: () => ({})}, setTimeout: () => 1, clearTimeout: () => {},
  });
  return {
    requests, listeners, location, appliedThemes, themeBeforeMount,
    render() {
      cursor = 0;
      const tree = component();
      while (pendingEffects.length) pendingEffects.shift()();
      return tree;
    },
    changeHash(token) { location.hash = '#token=' + token; listeners.get('hashchange')?.(); },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
  };
}

test('standalone applies the saved theme before mounting the login and runtime shell', () => {
  for (const theme of ['dark', 'light']) {
    const app = mountAppWithPendingRequests('', theme);
    assert.deepEqual(app.appliedThemes, [theme]);
    assert.equal(app.themeBeforeMount, theme);
    assert.equal(app.render().props.className, 'entry-page');
    app.unmount();
  }
});

test('opening a new login link in the current tab clears its fragment and latest login wins', async () => {
  const app = mountAppWithPendingRequests('#token=old-token');
  app.render();
  assert.equal(app.location.hash, '');
  assert.equal(app.requests[0].options.body.token, 'old-token');
  app.changeHash('new-token');
  assert.equal(app.location.hash, '', 'hashchange must clear the new token immediately');
  assert.equal(app.requests[1].options.body.token, 'new-token');
  app.requests[1].resolve({authenticated: true});
  await new Promise(setImmediate);
  assert.equal(app.render().props.className, 'standalone-shell');
  app.requests[0].reject(Object.assign(new Error('old token expired'), {status: 401}));
  await new Promise(setImmediate);
  assert.equal(app.render().props.className, 'standalone-shell', 'stale failures must not erase successful newer login');
  app.unmount();
  assert.equal(app.listeners.has('hashchange'), false);
});

test('late authentication after App unmount does not update its session state', async () => {
  const app = mountAppWithPendingRequests();
  app.render();
  app.unmount();
  app.requests[0].resolve({authenticated: true});
  await new Promise(setImmediate);
  assert.equal(app.render().props.className, 'entry-page');
  assert.equal(app.listeners.has('hashchange'), false);
});
