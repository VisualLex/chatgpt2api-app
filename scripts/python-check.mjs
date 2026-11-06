/** Read-only startup inspection; installation stays with PlatformBackend. */
import fs from 'node:fs';
import path from 'node:path';
import {pythonEnvIssue, isCompatiblePython} from '../lib/platform-backend.js';

function probe(manager, executable) {
  try { return manager.probeInterpreter(executable); } catch { return null; }
}

export function inspectPythonEnvironment(manager) {
  const environmentPath = path.join(manager.paths.source, '.venv');
  const pythonPath = path.join(environmentPath, manager.spec.pythonRelative);
  if (fs.existsSync(environmentPath)) {
    const python = fs.existsSync(pythonPath) ? probe(manager, pythonPath) : null;
    const issue = pythonEnvIssue(manager.paths, manager.spec);
    let reason = '';
    if (!python) reason = '解释器缺失或无法运行';
    else if (!isCompatiblePython(python)) reason = `Python ${python.version} 不满足 Python 3.13 或更高的 3.x 版本要求`;
    else if (issue) reason = issue.message;
    return {state: reason ? 'repair' : 'ready', environmentPath, pythonPath,
      version: python?.version || '', reason};
  }

  let warning = '';
  if (manager.configPython) {
    const configured = probe(manager, manager.configPython);
    if (!isCompatiblePython(configured)) {
      warning = `指定的 Python 未被采用：${manager.configPython}（${configured ? '版本 ' + configured.version : '无法运行'}）。需要 Python 3.13 或更高的 3.x 版本，将继续自动查找。`;
    }
  }
  const detected = typeof manager.systemPythonFinder === 'function'
    ? manager.systemPythonFinder({uvBin: manager.paths.uv, uvEnv: manager.uvEnv, customPath: manager.configPython})
    : null;
  return {state: isCompatiblePython(detected) ? 'system' : 'download', environmentPath,
    pythonPath: isCompatiblePython(detected) ? detected.path : '',
    version: isCompatiblePython(detected) ? detected.version : '', reason: '', warning};
}

export function reportPythonEnvironment(manager, {log = console.info} = {}) {
  log('[Python] 正在检查运行环境（需要 Python 3.13 或更高的 3.x 版本）…');
  const result = inspectPythonEnvironment(manager);
  log('[Python] 隔离环境目录：' + result.environmentPath);
  if (result.warning) log('[Python] ' + result.warning);
  if (result.state === 'ready') {
    log(`[Python] 已有环境可用：Python ${result.version}（${result.pythonPath}）。`);
    log('[Python] 关键依赖文件检查通过，将复用此环境。');
  } else if (result.state === 'repair') {
    log('[Python] 已有环境需要修复：' + result.reason + '。');
    log('[Python] 需要启动后端时会自动修复或重建；必要时下载 Python 3.13，无需手动安装。');
  } else if (result.state === 'system') {
    log(`[Python] 检测到兼容的 Python ${result.version}：${result.pythonPath}`);
    log('[Python] 需要启动后端时，将使用它创建隔离环境，并自动安装依赖。');
  } else {
    log('[Python] 未检测到兼容的 Python，将在需要启动后端时自动下载 Python 3.13 和依赖。');
    log('[Python] 请保持网络连接，首次准备环境可能需要几分钟。');
  }
  return result;
}
