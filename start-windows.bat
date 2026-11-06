@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
title ChatGPT2API

pushd "%~dp0"
if errorlevel 1 goto directory_error

where node >nul 2>nul
if errorlevel 1 goto node_missing

node -e "var v=process.versions.node.split('.');process.exit(+v[0]>20||(+v[0]===20&&+v[1]>=11)?0:1)"
if errorlevel 1 goto node_old

if not exist "scripts\launch.mjs" goto files_missing

rem The shared entry also checks the saved Python environment and system Python.
node "scripts\launch.mjs" %*
set "CHATGPT2API_LAUNCH_EXIT=%ERRORLEVEL%"
if "%CHATGPT2API_LAUNCH_EXIT%"=="0" goto finished
if "%CHATGPT2API_LAUNCH_EXIT%"=="130" goto finished
if "%CHATGPT2API_LAUNCH_EXIT%"=="-1073741510" goto finished
if "%CHATGPT2API_LAUNCH_EXIT%"=="3221225786" goto finished
echo.
echo 启动未完成，请查看上方错误信息。
goto failed

:node_missing
echo 未找到 Node.js。请从 https://nodejs.org/ 安装 Node.js 20.11 或更高版本。
echo 安装完成后，请关闭此窗口，再重新双击启动脚本。
set "CHATGPT2API_LAUNCH_EXIT=1"
goto failed

:node_old
echo 需要 Node.js 20.11 或更高版本，当前版本：
node --version
echo 请从 https://nodejs.org/ 更新后重试。
set "CHATGPT2API_LAUNCH_EXIT=1"
goto failed

:files_missing
echo 项目文件不完整：缺少 scripts\launch.mjs。
echo 请解压整个项目，不要单独移动启动脚本。
set "CHATGPT2API_LAUNCH_EXIT=1"
goto failed

:directory_error
echo 无法进入项目文件夹，请将项目完整解压后重试。
if "%~1"=="" pause
exit /b 1

:failed
if "%~1"=="" pause

:finished
popd
exit /b %CHATGPT2API_LAUNCH_EXIT%
