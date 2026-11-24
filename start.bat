@echo off
chcp 65001 >nul
setlocal
set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" set "NODE=node"
echo 正在启动团队控制台…
"%NODE%" "%~dp0lib\start.mjs" --open %*
pause
