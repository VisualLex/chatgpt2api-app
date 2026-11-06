#!/usr/bin/env node
/** Shared entry for the macOS/Linux shell, Windows launcher and npm start. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {realpathSync} from 'node:fs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

export function supportsNodeVersion(version) {
  const [major, minor] = String(version).replace(/^v/, '').split('.').map(Number);
  return major > 20 || (major === 20 && minor >= 11);
}

export async function launch() {
  if (!supportsNodeVersion(process.versions.node)) {
    throw new Error(`当前 Node.js 为 ${process.versions.node}，请安装 Node.js 20.11 或更高版本后重试：https://nodejs.org/`);
  }
  // Validate arguments before building. Help never starts or downloads anything.
  const {parseOptions, main} = await import('./start.mjs');
  const config = parseOptions();
  if (!config.help) {
    console.info('Node.js 检查通过：v' + process.versions.node);
    console.info('正在准备管理页面…');
    const result = spawnSync(process.execPath, [path.join(projectRoot, 'scripts', 'build.mjs')], {
      cwd: projectRoot, stdio: 'inherit',
    });
    if (result.error) throw new Error('页面构建失败：' + result.error.message);
    if (result.status !== 0) {
      const code = Number.isInteger(result.status) && result.status > 0 ? result.status : 1;
      throw Object.assign(new Error('页面构建失败，请检查项目是否完整解压，以及项目文件夹是否可写。'), {exitCode: code});
    }
  }
  // Run in this process so start.mjs owns Ctrl+C and backend cleanup.
  await main();
}

let invokedDirectly = false;
try {
  // Node resolves module symlinks, including macOS's /var -> /private/var.
  invokedDirectly = !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch {}
if (invokedDirectly) {
  launch().catch(error => {
    console.error('启动失败：' + error.message);
    process.exitCode = error.exitCode || 1;
  });
}
