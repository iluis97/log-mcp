#!/usr/bin/env node
import { START_BUILD } from '../src/build.mjs';
import { resolveConfigPath } from '../src/config.mjs';
import { startWebServer } from '../src/web.mjs';

const argv = process.argv.slice(2);

function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const configFile = resolveConfigPath(argv, { create: true });
const port = Number(arg('port', process.env.LOGMCP_WEB_PORT ?? 4780));
const host = arg('host', '127.0.0.1');

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  process.stderr.write(`[logmcp-web] 端口非法: ${port}\n`);
  process.exit(1);
}

startWebServer({ configFile, port, host })
  .then((server) => {
    process.stderr.write(`[logmcp-web] build ${START_BUILD}\n`);
    process.stderr.write(`[logmcp-web] 配置: ${configFile}\n`);
    process.stderr.write(`[logmcp-web] 打开: http://${host}:${server.address().port}/\n`);
  })
  .catch((err) => {
    process.stderr.write(`[logmcp-web] 启动失败: ${err?.message ?? err}\n`);
    process.exit(1);
  });
