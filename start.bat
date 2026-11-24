@echo off
chcp 65001 >nul
setlocal
set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" set "NODE=node"
echo 正在启动团队控制台…
start "" http://127.0.0.1:4318/
"%NODE%" "%~dp0lib\start.mjs" --open %*
pause
