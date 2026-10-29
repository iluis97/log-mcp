#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { START_BUILD } from '../src/build.mjs';
import { resolveConfigPath } from '../src/config.mjs';
import { startServer } from '../src/server.mjs';
import { startWebServer } from '../src/web.mjs';

/**
 * 一条命令起两样东西：
 *   - 配置页（HTTP，127.0.0.1）
 *   - MCP 服务（stdio，stdout 只给 JSON-RPC，日志全走 stderr）
 *
 * 用法：
 *   node bin/logmcp-start.mjs                  # 两个都起
 *   node bin/logmcp-start.mjs --web            # 只起配置页（Ctrl+C 退出）
 *   node bin/logmcp-start.mjs --no-web         # 只起 MCP（等同 bin/logmcp.mjs）
 *   node bin/logmcp-start.mjs --open           # 顺便打开浏览器
 *   node bin/logmcp-start.mjs --port 4781 --config xxx.json --env dev-123
 */

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(`--${flag}`);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v && !v.startsWith('--') ? v : fallback;
};

const configFile = resolveConfigPath(argv, { create: true });
const env = arg('env');
const host = arg('host', '127.0.0.1');
const wantWeb = !has('no-web');
const webOnly = has('web');
const wantOpen = has('open');
const startPort = Number(arg('port', process.env.LOGMCP_WEB_PORT ?? 4780));

if (!Number.isInteger(startPort) || startPort < 0 || startPort > 65535) {
  process.stderr.write(`[logmcp-start] 端口非法: ${startPort}\n`);
  process.exit(1);
}

function log(msg) {
  process.stderr.write(`[logmcp-start] ${msg}\n`);
}

/** 端口被占时先看看占它的是不是另一个 logmcp（很可能是忘了关的旧进程）。 */
async function describeOccupant(host, port) {
  try {
    const res = await fetch(`http://${host}:${port}/api/config`, { signal: AbortSignal.timeout(800) });
    if (!res.ok) return '未知进程';
    const data = await res.json();
    if (!data.configFile) return '未知进程';
    const build = data.build ? `，build ${data.build.build}${data.build.stale ? '（代码已变，是旧进程）' : ''}` : '';
    return `已有一个 logmcp（配置 ${data.configFile}${build}）`;
  } catch {
    return '占用者不是 logmcp 或无法访问';
  }
}

/** 端口被占用时顺延（最多试 10 个），--port 0 表示随机端口。 */
async function listenWithFallback(port) {
  const tries = port === 0 ? 1 : 10;
  for (let i = 0; i < tries; i += 1) {
    const candidate = port + i;
    try {
      const server = await startWebServer({ configFile, port: candidate, host });
      return server;
    } catch (err) {
      if ((err.code === 'EADDRINUSE' || err.code === 'EACCES') && i < tries - 1) {
        const why = err.code === 'EACCES' ? '无权限' : await describeOccupant(host, candidate);
        log(`端口 ${candidate} ${err.code === 'EACCES' ? '无权限' : '被占用'}：${why} → 改用 ${candidate + 1}`);
        continue;
      }
      throw err;
    }
  }
  throw new Error(`端口 ${port}~${port + tries - 1} 都不可用`);
}

function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch (err) {
    log(`打开浏览器失败（手动访问上面的地址即可）: ${err.message}`);
  }
}

let webServer = null;

async function shutdown(code = 0) {
  if (webServer) {
    await new Promise((resolve) => webServer.close(resolve));
    webServer = null;
    log('配置页已关闭');
  }
  process.exit(code);
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

async function main() {
  log(`配置 ${configFile}${env ? `  标签 ${env}` : ''}　build ${START_BUILD}`);

  if (wantWeb) {
    webServer = await listenWithFallback(startPort);
    const url = `http://${host}:${webServer.address().port}/`;
    log(`配置页 ${url}`);
    if (wantOpen) openBrowser(url);
  }

  if (webOnly) {
    // 只起配置页：HTTP server 自己撑住事件循环
    return;
  }

  // MCP 热加载会自己读 --env/LOGMCP_ENV/activeEnv，这里显式传一次保证与页面一致
  await startServer({ configFile, env });
  // stdin 关闭 = 客户端退出，连配置页一起收掉
  await shutdown(0);
}

main().catch(async (err) => {
  log(`启动失败: ${err?.message ?? err}`);
  await shutdown(1);
});
