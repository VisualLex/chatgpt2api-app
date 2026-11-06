import {React, render} from './react.js';
import {createChatGPT2APIDashboard, readDashboardTheme, applyDashboardTheme} from './dashboard.js';
import {api, takeLoginToken} from './session.js';

applyDashboardTheme(readDashboardTheme());
let initialToken = takeLoginToken(window.location, window.history);
const h = React.createElement;
const phaseNames = {
  idle: '准备启动', downloading: '下载运行环境', installing: '安装 Python 依赖',
  repairing: '修复运行环境', starting: '启动号池', restarting: '重启号池',
  ready: '号池运行中', error: '后端启动失败', stopped: '后端已停止', disabled: '自动启动已关闭',
};

function App() {
  const [authenticated, setAuthenticated] = React.useState(null);
  const [token, setToken] = React.useState('');
  const [message, setMessage] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [runtime, setRuntime] = React.useState(null);
  const [runtimeError, setRuntimeError] = React.useState('');
  const [retrying, setRetrying] = React.useState(false);
  const authGuard = React.useRef({live: true, revision: 0});
  const panel = React.useMemo(() => createChatGPT2APIDashboard(React, '', {
    standalone: true,
    baseUrl: runtime?.baseUrl || runtime?.apiBaseUrl?.replace(/\/v1\/?$/, ''),
  }), [authenticated, runtime?.baseUrl, runtime?.apiBaseUrl]);

  const authenticateSession = React.useCallback(async value => {
    const guard = authGuard.current;
    const revision = ++guard.revision;
    const current = () => guard.live && revision === guard.revision;
    setBusy(true); setMessage('');
    try {
      const result = value
        ? await api('/api/session', {method: 'POST', body: {token: value}})
        : await api('/api/session');
      if (current()) { setToken(''); setAuthenticated(result.authenticated === true); }
    } catch (error) {
      if (current()) { setAuthenticated(false); setRuntime(null); setMessage(error.message); }
    } finally {
      if (current()) setBusy(false);
    }
  }, []);

  React.useEffect(() => {
    authGuard.current.live = true;
    const onHashChange = () => {
      const value = takeLoginToken(window.location, window.history);
      if (value) void authenticateSession(value);
    };
    window.addEventListener('hashchange', onHashChange);
    const value = takeLoginToken(window.location, window.history) || initialToken;
    initialToken = '';
    void authenticateSession(value);
    return () => {
      authGuard.current.live = false;
      authGuard.current.revision += 1;
      window.removeEventListener('hashchange', onHashChange);
    };
  }, [authenticateSession]);

  React.useEffect(() => {
    if (!authenticated) return;
    let live = true, timer;
    const poll = async () => {
      const revision = authGuard.current.revision;
      try {
        const status = await api('/api/runtime');
        if (live && revision === authGuard.current.revision) { setRuntime(status); setRuntimeError(''); }
      } catch (error) {
        if (!live || revision !== authGuard.current.revision) return;
        if (error.status === 401) { setAuthenticated(false); setRuntime(null); }
        else setRuntimeError(error.message);
      } finally {
        if (live) timer = setTimeout(poll, 2000);
      }
    };
    void poll();
    return () => { live = false; clearTimeout(timer); };
  }, [authenticated]);

  async function login(event) {
    event.preventDefault();
    if (!token.trim() || busy) return;
    await authenticateSession(token.trim());
  }
  async function logout() {
    setBusy(true);
    try {
      await api('/api/logout', {method: 'POST', body: {}});
      // Clear the panel's in-memory account drafts and keys on logout.
      window.location.reload();
    } catch (error) { setRuntimeError(error.message); setBusy(false); }
  }
  async function retry() {
    setRetrying(true); setRuntimeError('');
    try {
      await api('/api/runtime/retry', {method: 'POST', body: {}});
      setRuntime(await api('/api/runtime'));
    } catch (error) { setRuntimeError(error.message); }
    finally { setRetrying(false); }
  }

  if (authenticated === null) return h('main', {className: 'entry-page'},
    h('p', {role: 'status'}, '正在验证本机管理会话…'));
  if (!authenticated) return h('main', {className: 'entry-page'},
    h('section', {className: 'entry-card'},
      h('div', {className: 'entry-mark', 'aria-hidden': true}, h(panel.LogoMark, {size: 48})),
      h('h1', null, 'ChatGPT2API · 本机号池'),
      h('p', null, '请打开启动终端中显示的管理页登录链接。也可以将链接中 token= 后面的本次登录口令粘贴到下方。'),
      h('form', {onSubmit: login},
        h('label', {htmlFor: 'login-token'}, '本次登录口令'),
        h('input', {id: 'login-token', type: 'password', value: token, onChange: event => setToken(event.target.value), autoComplete: 'off', spellCheck: false, required: true}),
        h('button', {type: 'submit', disabled: busy || !token.trim()}, busy ? '验证中…' : '打开管理页面')),
      message ? h('p', {className: 'shell-error', role: 'alert'}, message) : null,
      h('p', {className: 'entry-note'}, '口令随程序重启更新，仅用于本机管理会话。第三方客户端使用在「API 接入」创建的用户 Key。')));

  const ready = runtime?.phase === 'ready';
  const failed = ['error', 'stopped', 'disabled'].includes(runtime?.phase);
  return h('div', {className: 'standalone-shell'},
    h('div', {className: 'shell-toolbar'},
      h('div', null, h('span', {className: 'shell-status-dot ' + (ready ? 'ready' : failed ? 'failed' : '')}),
        h('strong', null, phaseNames[runtime?.phase] || '读取运行状态'),
        h('span', {className: 'shell-session'}, '本机管理会话已授权')),
      h('button', {type: 'button', onClick: logout, disabled: busy}, '退出管理会话')),
    runtimeError ? h('p', {className: 'shell-error', role: 'alert'}, '连接本机程序失败：' + runtimeError) : null,
    ready ? h('div', {className: 'dashboard-host'}, h(panel.Dashboard)) :
      h('main', {className: 'runtime-page'}, h('section', {className: 'runtime-card', 'aria-live': 'polite'},
        h('p', {className: 'runtime-kicker'}, 'ChatGPT2API · 独立运行'),
        h('h1', null, phaseNames[runtime?.phase] || '正在读取运行状态…'),
        h('p', null, runtime?.message || '管理页面已就绪，正在准备本机号池后端。'),
        runtime?.error ? h('p', {className: 'shell-error', role: 'alert'}, runtime.error) : null,
        !failed ? h('p', {className: 'entry-note'}, '首次启动会联网下载固定版本的后端和运行环境，可能需要几分钟。后续启动会复用本机环境。') :
          h('div', null,
            h('p', null, '检查网络连接后重试。也可以在程序目录执行 npm run check、npm run repair 或 npm run diagnose。'),
            h('button', {type: 'button', onClick: retry, disabled: retrying}, retrying ? '正在重试…' : '重试启动后端')),
        runtime?.dataDir ? h('dl', {className: 'runtime-paths'},
          h('dt', null, '数据目录'), h('dd', null, runtime.dataDir),
          h('dt', null, '后端日志'), h('dd', null, runtime.logFile || runtime.logs || runtime.dataDir.replace(/[\\/]$/, '') + '/backend.log'),
          h('dt', null, 'API 地址'), h('dd', null, runtime.apiBaseUrl || runtime.baseUrl + '/v1')) : null)));
}

render(h(App), document.getElementById('root'));
