#!/bin/sh
# Shared macOS/Linux entry. Run with: sh start.sh

pause_on_failure() {
  if [ "$#" -eq 0 ] && [ -t 0 ]; then
    printf '\n按回车键关闭此窗口…'
    read -r _launcher_reply
  fi
}

if ! CDPATH= cd -P "$(dirname "$0")"; then
  printf '无法进入项目文件夹，请将项目完整解压后重试。\n'
  pause_on_failure "$@"
  exit 1
fi

# Include common macOS/Linux Node locations when the current PATH lacks Node.
if ! command -v node >/dev/null 2>&1; then
  export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.volta/bin"
fi
if ! command -v node >/dev/null 2>&1; then
  _launcher_nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$_launcher_nvm_dir/nvm.sh" ]; then
    # A function gives nvm an empty argument list instead of the app's flags.
    _launcher_load_nvm() { . "$_launcher_nvm_dir/nvm.sh"; }
    _launcher_load_nvm
  fi
fi
if ! command -v node >/dev/null 2>&1; then
  printf '未找到 Node.js。请从 https://nodejs.org/ 安装 Node.js 20.11 或更高版本，再重新打开此脚本。\n'
  pause_on_failure "$@"
  exit 1
fi

# This syntax also works on old Node versions, before loading the ESM entry.
if ! node -e 'var v=process.versions.node.split(".");process.exit(+v[0]>20||(+v[0]===20&&+v[1]>=11)?0:1)'; then
  printf '需要 Node.js 20.11 或更高版本，当前版本：'
  node --version
  printf '请从 https://nodejs.org/ 更新后重试。\n'
  pause_on_failure "$@"
  exit 1
fi

if [ ! -f scripts/launch.mjs ]; then
  printf '项目文件不完整：缺少 scripts/launch.mjs。请解压整个项目，不要单独移动启动脚本。\n'
  pause_on_failure "$@"
  exit 1
fi

# The shared entry also checks the saved Python environment and system Python.
node scripts/launch.mjs "$@"
_launcher_exit_code=$?
if [ "$_launcher_exit_code" -ne 0 ] && [ "$_launcher_exit_code" -ne 130 ] && [ "$_launcher_exit_code" -ne 143 ]; then
  printf '\n启动未完成，请查看上方错误信息。\n'
  pause_on_failure "$@"
fi
exit "$_launcher_exit_code"
