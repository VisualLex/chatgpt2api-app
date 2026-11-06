#!/usr/bin/env node
/** Standalone foreground program: local browser UI + supervised account pool. */
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {parseArgs} from 'node:util';
import {PlatformBackend, ensureManagedFiles, DEFAULT_PORT, validatePort} from '../lib/platform-backend.js';
import {createStandaloneServer, DEFAULT_WEB_PORT} from '../lib/standalone-server.js';
import {reportPythonEnvironment} from './python-check.mjs';

export function parseOptions(args = process.argv.slice(2), env = process.env) {
  const {values} = parseArgs({args, options: {
    port: {type: 'string'}, 'web-port': {type: 'string'}, 'data-dir': {type: 'string'},
    python: {type: 'string'}, 'no-open': {type: 'boolean'}, help: {type: 'boolean', short: 'h'},
  }});
  if (values.help) return {help: true};
  const port = validatePort(values.port ?? env.CHATGPT2API_PORT ?? env.DSH_CHATGPT2API_PORT ?? DEFAULT_PORT);
  const webPort = validatePort(values['web-port'] ?? env.CHATGPT2API_WEB_PORT ?? DEFAULT_WEB_PORT);
  if (port === webPort) throw new Error('管理页面和 API 必须使用不同端口');
  return {
    port, webPort,
    dataDir: path.resolve(values['data-dir'] || env.CHATGPT2API_HOME || env.DSH_CHATGPT2API_HOME || path.join(os.homedir(), '.chatgpt2api')),
    pythonPath: values.python || env.CHATGPT2API_PYTHON || env.DSH_CHATGPT2API_PYTHON || '',
    open: !values['no-open'],
  };
}

const HELP = `ChatGPT2API 独立程序（Node.js 20.11+）

用法：npm start -- [选项]
  --port <端口>        OpenAI 兼容 API 端口（默认 38650）
  --web-port <端口>    浏览器管理页面端口（默认 38651）
  --data-dir <目录>   数据及运行环境目录（默认 ~/.chatgpt2api）
  --python <路径>     指定 Python 3.13 或更高的 3.x 解释器
  --no-open           不自动打开浏览器
  -h, --help          显示帮助

首次运行自动准备后端及 Python 环境，无需手动安装 Python 或 Docker。
按 Ctrl+C 停止；账号、密钥和图片保留在数据目录。
`;

function openBrowser(url) {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
    : ['xdg-open', [url]];
  const child = spawn(command, args, {stdio: 'ignore', detached: true, windowsHide: true});
  child.once('error', () => console.info('无法自动打开浏览器，请手动打开上方登录链接。'));
  child.unref();
}

export async function main() {
  const config = parseOptions();
  if (config.help) { console.info(HELP); return; }
  const manager = new PlatformBackend(config);
  reportPythonEnvironment(manager);
  const secret = ensureManagedFiles(manager.paths, process.env.CHATGPT2API_KEY || process.env.DSH_CHATGPT2API_KEY || '');
  const web = createStandaloneServer({manager, secret, webPort: config.webPort});
  let stopping = false, lastStatus = '', timer;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    console.info('\n正在停止 ChatGPT2API…');
    await Promise.allSettled([web.close(), manager.stop()]);
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const {url, loginUrl} = await web.listen();
    console.info(`ChatGPT2API 独立程序\n管理页面：${url}\n本机登录链接：${loginUrl}\nAPI Base URL：${manager.baseUrl}/v1\n数据目录：${manager.paths.root}\n按 Ctrl+C 停止。登录链接只用于本机管理，请妥善保管。`);
    if (config.open) openBrowser(loginUrl);
    const report = () => {
      const status = manager.status();
      const message = status.error || status.message;
      const signature = status.phase + message;
      if (signature !== lastStatus) { lastStatus = signature; console.info(`[${status.phase}] ${message}`); }
    };
    timer = setInterval(report, 1000);
    report();
    void manager.start().then(report).catch(() => {
      if (stopping) return;
      report();
      console.error(`后端启动失败。可在管理页重试，或先停止程序后执行 npm run repair。日志：${manager.paths.logs}`);
    });
  } catch (error) {
    clearInterval(timer);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await Promise.allSettled([web.close(), manager.stop()]);
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error('启动失败：' + error.message); process.exitCode = 1; });
}
