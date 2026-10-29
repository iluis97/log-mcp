@echo off
rem log-mcp 一键启动：MCP（stdio）+ 配置页（http://127.0.0.1:4780/）
rem 双击即用；参数原样透传（--port / --config / --env / --no-web ...）
setlocal
cd /d "%~dp0"
node "%~dp0bin\logmcp-start.mjs" --open %*
if errorlevel 1 pause
endlocal
