@echo off
chcp 936 >nul
cd /d "%~dp0"
title 智能药箱 Web 应用 - 启动器

echo.
echo ==================================================
echo    智能药箱 · 家庭用药协同系统
echo    Web 应用一键启动
echo ==================================================
echo.

REM ---------- 1. 检查 Node.js ----------
where node >nul 2>nul
if errorlevel 1 goto NONODE
echo [1/4] Node.js 已就绪

REM ---------- 2. 安装依赖 ----------
if exist "node_modules" goto DEPSOK
echo [2/4] 首次运行，正在安装依赖包，请耐心等待 1-3 分钟...
call npm install --no-audit --no-fund
if errorlevel 1 goto NPMFAIL
goto DEPSDONE
:DEPSOK
echo [2/4] 依赖已存在，跳过安装
:DEPSDONE

REM ---------- 3. 检查数据库 ----------
echo [3/4] 检查数据库连通性（下一行显示英文是正常的）...
node scripts\check-db.js
if not errorlevel 1 goto DBOK
echo       连不上或没有表，尝试自动启动 MySQL80 服务（可能需要管理员权限）...
net start MySQL80 >nul 2>nul
node scripts\check-db.js
if not errorlevel 1 goto DBOK
goto DBFAIL

:DBOK
echo       数据库正常
goto PORTCHK

:DBFAIL
echo.
echo [错误] 数据库连接不上。网页能打开，但所有数据读写都会失败。
echo        请确认 MySQL 已安装并启动，然后执行：npm run init-db
echo        具体原因请看上面 DB FAIL: 或 DB EMPTY: 开头那一行。
echo.
set GO=
set /p GO=是否仍要强行启动？输入 Y 回车，其他任意键退出：
if /i not "%GO%"=="Y" goto END

REM ---------- 4. 端口检查 ----------
:PORTCHK
set PID3000=
for /f "tokens=5" %%a in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":3000 "') do set PID3000=%%a
if not defined PID3000 goto STARTAPP

echo [4/4] 3000 端口已被占用，正在确认占用者是不是本服务...

REM 关键改动：先做健康检查。活着且是本项目服务，就直接沿用，
REM 不再要求用户输入 Y 去杀进程 —— 以前杀不掉会反复问，形成死循环。
node scripts\health-probe.js
if not errorlevel 1 goto REUSE

echo.
echo   占用端口的进程 PID = %PID3000%
echo   该端口被【别的程序】占着，不是本项目的服务。
echo.
set GO2=
set /p GO2=   要尝试结束它吗？输入 Y 回车（不想动它就直接回车退出）：
if /i not "%GO2%"=="Y" goto END

echo.
echo   正在尝试结束进程 %PID3000% ...
taskkill /PID %PID3000% /F >nul 2>nul
ping -n 3 127.0.0.1 >nul

REM 杀完重新确认一次。杀不掉就明确告知并退出，绝不回到上面再来一遍。
set PID3000=
for /f "tokens=5" %%a in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":3000 "') do set PID3000=%%a
if defined PID3000 goto KILLFAIL
echo   端口已释放，继续启动...
goto STARTAPP

:KILLFAIL
echo.
echo [结束不了] 进程 %PID3000% 仍然占着 3000 端口（通常是权限不足）。
echo   请任选一种办法：
echo     1. 打开任务管理器 -^> 详细信息，找到 PID %PID3000%，右键结束任务；
echo     2. 管理员身份打开 PowerShell，执行：
echo          Stop-Process -Id %PID3000% -Force
echo     3. 换个端口：把 .env 里的 PORT=3000 改成 PORT=3100，再双击本脚本。
echo.
pause
goto END

:REUSE
echo       本服务已经在运行，直接沿用，不再重复启动。
echo       服务地址：http://localhost:3000
echo.
echo   如果页面数据不对或者打开是空白：多半是服务已经僵掉了。
echo   请找到之前那个黑色命令行窗口，关掉它，再重新双击本脚本。
echo   想确认服务是否还活着，浏览器打开：http://localhost:3000/api/health
echo.
if not "%1"=="--no-browser" start "" http://localhost:3000/login.html
pause
goto END

:STARTAPP
echo [4/4] 正在启动服务...
echo.
echo --------------------------------------------------
echo   启动成功！这个黑色窗口不能关，关掉 = 停止服务。
echo   服务地址：http://localhost:3000
echo   演示账号见 README.md 的 3.4 节
echo   确认服务是否还活着：http://localhost:3000/api/health
echo --------------------------------------------------
echo.
if not "%1"=="--no-browser" start "" http://localhost:3000/login.html
npm start
goto END

:NONODE
echo [错误] 没有检测到 Node.js。
echo       请到 https://nodejs.org 下载安装 LTS 版本，装完重开本脚本。
echo.
pause
goto END

:NPMFAIL
echo [错误] 依赖包安装失败，请检查网络连接。
echo.
pause
goto END

:END
