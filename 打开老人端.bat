@echo off
chcp 936 >nul
cd /d "%~dp0"
title 智能药箱 - 打开老人端

echo.
echo ==================================================
echo    智能药箱 · 老人端（药箱屏幕）
echo ==================================================
echo.

REM ---------- 1. 先确认服务活着，否则打开就是白屏 ----------
where node >nul 2>nul
if errorlevel 1 goto NONODE

echo [1/2] 检查服务是否在运行（下一行是英文，正常）...
node scripts\health-probe.js
if errorlevel 1 goto NOSERVICE
echo       服务正常

REM ---------- 2. 取局域网 IP，方便手机同屏演示 ----------
set LANIP=
for /f "delims=" %%i in ('node scripts\print-lan-ip.js') do set LANIP=%%i

echo [2/2] 正在打开老人端...
echo.
start "" http://localhost:3000/elder.html

echo --------------------------------------------------
echo   老人端已在浏览器新标签页打开。
echo.
echo   【首次打开】要输入 6 位绑定码（老人不需要密码）：
echo      打开 DEMO_ACCOUNTS.md 查看当前最新绑定码
echo      或在子女端「隔间管理 → 生成绑定码」现场生成
echo.
echo   【输码后底部弹红字】绑定码过期了，不是坏了。
echo      绑定码每跑一次 npm run init-db 都会重新签发，
echo      必须用 DEMO_ACCOUNTS.md 里最新的那个。
echo.
echo   【手机演示】手机连同一个 WiFi，浏览器访问：
echo      http://%LANIP%:3000/elder.html
echo      打不开多半是电脑防火墙拦了，临时关一下防火墙即可。
echo --------------------------------------------------
echo.
echo   本窗口 8 秒后自动关闭...
ping -n 8 127.0.0.1 >nul
goto END

:NONODE
echo [错误] 没有检测到 Node.js，无法检查服务状态。
echo       但老人端可能本来就能开，试试浏览器访问：
echo          http://localhost:3000/elder.html
echo.
pause
goto END

:NOSERVICE
echo.
echo [打不开] 服务还没有启动，现在打开只会是白屏。
echo.
echo   请这样操作：
echo     1. 先双击本文件夹里的「双击启动Web应用.bat」
echo     2. 等黑色窗口出现“启动成功”字样（这个黑窗口不能关）
echo     3. 再回来双击本脚本
echo.
pause
goto END

:END
