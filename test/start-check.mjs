import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.dirname(HERE);
const START = path.join(PKG, 'bin', 'logmcp-start.mjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logmcp-start-'));
const configFile = path.join(dir, 'logmcp.config.json');
fs.writeFileSync(
  configFile,
  JSON.stringify(
    {
      timezone: 'Asia/Shanghai',
      envs: {
        'dev-123': {
          source: { name: 'dev-local', type: 'file', roots: [path.join(dir, 'logs')], glob: '**/*.log*', allowPaths: ['**'] },
          services: { app: { glob: '**/*.log*' }, other: { glob: 'other/*.log*' } },
        },
      },
      activeEnv: 'dev-123',
    },
    null,
    2,
  ),
);
fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
fs.writeFileSync(path.join(dir, 'logs', 'app.log'), '2026-10-28 10:00:00.000 INFO  demo | hello\n');

/** 起子进程并等到 stderr 上出现配置页地址。 */
function launch(extraArgs) {
  const child = spawn(process.execPath, [START, '--config', configFile, ...extraArgs], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => (stdout += c.toString('utf8')));
  child.stderr.on('data', (c) => (stderr += c.toString('utf8')));
  const url = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等不到配置页地址，stderr=\n${stderr}`)), 15000);
    const check = () => {
      const m = /配置页 (http:\/\/\S+\/)/.exec(stderr);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    };
    child.stderr.on('data', check);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`子进程提前退出 code=${code}，stderr=\n${stderr}`));
    });
  });
  return { child, url, out: () => stdout, err: () => stderr };
}

// 1) --web：只起配置页，没有 MCP
{
  const { child, url, err } = launch(['--web', '--port', '0']);
  const base = await url;
  const cfg = await (await fetch(`${base}api/config`)).json();
  assert.deepEqual(cfg.envNames, ['dev-123'], '标签列表');
  assert.ok(fs.existsSync(path.join(PKG, 'public', 'index.html')));
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.doesNotMatch(err(), /config=/, '--web 不应启动 MCP');
  child.kill();
}

// 2) 默认：MCP + 配置页同时可用
{
  const { child, url } = launch(['--port', '0']);
  const base = await url;

  // 配置页活着
  const state = await (await fetch(`${base}api/config`)).json();
  assert.equal(state.envs['dev-123'].services.app.glob, '**/*.log*');
  assert.deepEqual(Object.keys(state.envs['dev-123'].services).sort(), ['app', 'other'], '一个标签下多个服务');

  // MCP 也活着：走 stdio JSON-RPC
  let buf = '';
  child.stdout.on('data', (c) => (buf += c.toString('utf8')));
  const call = (id, method, params) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} 超时，已收到=${buf}`)), 15000);
      const check = () => {
        const line = buf.split('\n').find((l) => l.includes(`"id":${id}`));
        if (!line) return;
        clearTimeout(timer);
        clearInterval(handle);
        resolve(JSON.parse(line));
      };
      const handle = setInterval(check, 50);
      check();
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  const init = await call(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  assert.equal(init.result.serverInfo.name, 'log-mcp');
  const tools = await call(2, 'tools/list', {});
  assert.ok(tools.result.tools.some((t) => t.name === 'log_search'));
  const sources = await call(3, 'tools/call', { name: 'log_sources', arguments: {} });
  const text = sources.result.content[0].text;
  assert.match(text, /dev-local/, 'MCP 用的是同一个配置文件');
  assert.match(text, /标签 dev-123/, 'log_sources 显示生效标签');

  // stdin 关闭 → 进程退出（配置页一起收掉）
  child.stdin.end();
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 0, '关闭 stdin 后正常退出');
}

// 3) 端口被占用时自动顺延
{
  const first = launch(['--web', '--port', '0']);
  const base1 = await first.url;
  const usedPort = Number(new URL(base1).port);
  const second = launch(['--web', '--port', String(usedPort)]);
  const base2 = await second.url;
  assert.notEqual(Number(new URL(base2).port), usedPort);
  assert.equal((await fetch(base2)).status, 200);
  first.child.kill();
  second.child.kill();
}

fs.rmSync(dir, { recursive: true, force: true });
console.log('start-check 全部通过');
process.exit(0);
