import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { startWebServer } from '../src/web.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.dirname(HERE);
const BIN = path.join(PKG, 'bin', 'logmcp.mjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logmcp-web-'));
const configFile = path.join(dir, 'logmcp.config.json');
const logs = path.join(dir, 'logs');

// 旧格式起步：顶层 sources 数组 + services（service 里还带 source 字段）
fs.writeFileSync(
  configFile,
  JSON.stringify(
    {
      timezone: 'Asia/Shanghai',
      defaults: { last: '30m' },
      services: { order: { source: 'local-dev', glob: 'order/logs/app*.log*' } },
      sources: [{ name: 'local-dev', type: 'file', roots: [logs], glob: '**/*.log*', allowPaths: ['**'] }],
      noisePatterns: ['(?i)heartbeat'],
    },
    null,
    2,
  ),
);
fs.mkdirSync(path.join(logs, 'order'), { recursive: true });
fs.writeFileSync(path.join(logs, 'order', 'app.log'), '2026-10-28 10:00:00.000 INFO  demo | hello\n');

const server = await startWebServer({ configFile, port: 0 });
const base = `http://127.0.0.1:${server.address().port}`;

async function call(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

const readDoc = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));

try {
  // 1) 旧格式被识别为一个标签（source 为对象、services 保留），页面不内置任何数据
  const cfgRes = await call('GET', '/api/config');
  assert.equal(cfgRes.status, 200);
  assert.equal(cfgRes.data.legacy, true);
  assert.equal(cfgRes.data.activeEnv, undefined, '不再有全局生效标签');
  assert.deepEqual(Object.keys(cfgRes.data.envs), ['default']);
  assert.equal(cfgRes.data.envs.default.source.name, 'local-dev');
  assert.equal(cfgRes.data.envs.default.services.order.source, 'local-dev');
  assert.deepEqual(
    cfgRes.data.meta.serviceFields.map((f) => f.key),
    ['name', 'container', 'glob', 'format'],
    '服务不再有 source 字段',
  );
  const version1 = cfgRes.data.version;

  // 2) 校验：缺 user、没有源、多个源 —— 逐条返回，不写盘
  const bad = await call('PUT', '/api/envs/dev-123', {
    source: { name: 'bad', type: 'ssh', host: '192.168.1.10' },
    services: { svc: {} },
  });
  assert.equal(bad.status, 400);
  assert.ok(bad.data.errors.some((e) => /user/.test(e.message)));

  const noSource = await call('POST', '/api/validate', { source: null, services: { a: { container: 'x' } } });
  assert.equal(noSource.data.ok, false);
  assert.ok(noSource.data.errors.some((e) => /未配置日志源/.test(e.message)));
  assert.equal(readDoc().envs, undefined, '校验失败不落盘');

  const twoSources = await call('POST', '/api/validate', {
    sources: [
      { name: 'a', type: 'ssh', host: '1.1.1.1', user: 'root' },
      { name: 'b', type: 'ssh', host: '2.2.2.2', user: 'root' },
    ],
    services: {},
  });
  assert.equal(twoSources.data.ok, false);
  assert.ok(twoSources.data.errors.some((e) => /只能有一个日志源/.test(e.message)));

  // 3) 保存新标签：旧顶层配置迁移进 envs（source 为单对象），其它字段原样保留
  const ok = await call('PUT', '/api/envs/dev-123', {
    source: { name: 'dev-host', type: 'file', roots: [logs], glob: '**/*.log*', allowPaths: ['**'] },
    services: { order: { glob: 'order/logs/app*.log*' }, other: { glob: 'other/*.log*' }, extra: { glob: 'extra/*.log*' } },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.ok, true);
  const doc1 = readDoc();
  assert.deepEqual(Object.keys(doc1.envs).sort(), ['default', 'dev-123']);
  assert.equal(doc1.sources, undefined, '顶层旧副本已迁移，不留两份');
  assert.equal(doc1.timezone, 'Asia/Shanghai');
  assert.deepEqual(doc1.noisePatterns, ['(?i)heartbeat']);
  assert.equal(doc1.envs['dev-123'].source.name, 'dev-host', '一个标签一个 source 对象');
  assert.equal(doc1.envs['dev-123'].sources, undefined, '不再写 sources 数组');
  assert.deepEqual(Object.keys(doc1.envs['dev-123'].services).sort(), ['extra', 'order', 'other'], '同一源下多个服务');

  // 4) service.source 若与唯一源不一致 → 告警并忽略
  const mismatch = await call('POST', '/api/validate', {
    source: { name: 'only-one', type: 'ssh', host: '1.1.1.1', user: 'root' },
    services: { app: { source: 'other-host', glob: '/opt/app/*.log*' } },
  });
  assert.equal(mismatch.data.ok, true, '不阻塞保存');
  assert.ok(mismatch.data.warnings.some((w) => /已忽略/.test(w.message)));

  // 5) 手改配置文件后，页面轮询能感知（since=旧指纹）
  const doc2 = readDoc();
  doc2.envs.prod = { source: { name: 'prod-host', type: 'ssh', host: '10.0.0.9', user: 'app' }, services: { pay: { glob: '/opt/pay/logs/*.log*' } } };
  fs.writeFileSync(configFile, `${JSON.stringify(doc2, null, 2)}\n`);
  const changed = await call('GET', `/api/config?since=${encodeURIComponent(version1)}`);
  assert.equal(changed.data.unchanged, undefined, '文件变了就不再返回 unchanged');
  assert.deepEqual(Object.keys(changed.data.envs).sort(), ['default', 'dev-123', 'prod']);
  assert.deepEqual(changed.data.envNames, ['default', 'dev-123', 'prod'], '所有标签一起返回');
  assert.equal(changed.data.envs.prod.source.name, 'prod-host');

  // 6) loadConfig 把全部标签都读进来；未指定 env 时不做选择（多标签）
  const cfgAll = loadConfig(configFile);
  assert.deepEqual(cfgAll.envs, ['default', 'dev-123', 'prod']);
  assert.equal(cfgAll.env, null, '多标签且没指定 → 不自动选');
  assert.deepEqual(cfgAll.sources, [], '不猜源');

  const cfg = loadConfig(configFile, { env: 'dev-123' });
  assert.equal(cfg.env, 'dev-123');
  assert.equal(cfg.sources.length, 1);
  assert.equal(cfg.services.order.source, 'dev-host');
  assert.deepEqual(cfg.services.order, { name: 'order', source: 'dev-host', glob: 'order/logs/app*.log*', container: null, format: null });
  const prodCfg = loadConfig(configFile, { env: 'prod' });
  assert.equal(prodCfg.sources[0].host, '10.0.0.9');
  assert.equal(prodCfg.services.pay.source, 'prod-host');

  // 7) 页面保存只覆盖当前标签，其它标签保持最新
  const saved = await call('PUT', '/api/envs/prod', {
    source: { name: 'prod-host', type: 'ssh', host: '10.0.0.10', user: 'app' },
    services: { pay: { glob: '/opt/pay/logs/app*.log*' }, refund: { glob: '/opt/refund/logs/app*.log*' } },
  });
  assert.equal(saved.status, 200);
  const doc3 = readDoc();
  assert.equal(doc3.envs.prod.source.host, '10.0.0.10');
  assert.deepEqual(Object.keys(doc3.envs.prod.services).sort(), ['pay', 'refund']);
  assert.equal(doc3.envs['dev-123'].source.name, 'dev-host', '别的标签不受影响');
  assert.equal(Object.keys(doc3.envs['dev-123'].services).length, 3, '别标签的服务数量不变');

  // 8) MCP 侧热加载：改文件即生效，不需要重启进程
  const rpc = mcp(configFile);
  await rpc.ready;
  const before = await rpc.call('log_sources', { env: 'dev-123' });
  assert.match(before, /dev-host/, '按 env 定向到 dev-123 的源');
  assert.match(before, /标签 dev-123/, '首行写出本次用的标签');

  // 多标签：不传 env 时给全景，让模型先确认数据源（不是自己挑）
  const overview = await rpc.callRaw('log_sources', {});
  assert.equal(overview.isError, false);
  assert.match(overview.text, /全部同时有效/);
  assert.match(overview.text, /dev-123: 源 dev-host/);
  assert.match(overview.text, /prod: 源 prod-host/);

  // 不传 env 的检索直接拒绝，并列出候选
  const ambiguous = await rpc.callRaw('log_search', { last: '30m' });
  assert.equal(ambiguous.isError, true, '未确定数据源不查');
  assert.match(ambiguous.text, /必须先确定用哪个/);
  assert.match(ambiguous.text, /dev-123/);
  assert.match(ambiguous.text, /prod/);

  // 被拒后不能换个标签再试：必须先用 log_confirm_env 确认（等同于先问用户）
  const blocked = await rpc.callRaw('log_search', { env: 'dev-123', last: '7d' });
  assert.equal(blocked.isError, true, 'pending 期间带 env 也拒绝');

  const confirm = await rpc.callRaw('log_confirm_env', { env: 'dev-123', evidence: '用户说：看 dev-123' });
  assert.equal(confirm.isError, false);
  assert.match(confirm.text, /已确认数据源：dev-123/);

  // 确认后正常查
  const scoped = await rpc.callRaw('log_search', { env: 'dev-123', last: '7d' });
  assert.equal(scoped.isError, false);
  assert.match(scoped.text, /hello/, '按 env 扫到该标签的日志内容');

  // 未知标签要报错并列出可用标签
  const unknown = await rpc.callRaw('log_search', { env: 'nope', last: '30m' });
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /没有 nope 这个标签/);

  // 锁定后换标签被拒
  const switchAway = await rpc.callRaw('log_search', { env: 'prod', last: '30m' });
  assert.equal(switchAway.isError, true);
  assert.match(switchAway.text, /已确认为 dev-123/);

  // 改文件后热加载：新增标签立刻可见，其它标签不受影响
  const doc4 = readDoc();
  doc4.envs.staging = {
    source: { name: 'staging-host', type: 'ssh', host: '10.0.0.30', user: 'app' },
    services: { api: { glob: '/opt/api/logs/*.log*' } },
  };
  fs.writeFileSync(configFile, `${JSON.stringify(doc4, null, 2)}
`);
  const after = await rpc.callRaw('log_sources', { env: 'staging' });
  assert.equal(after.isError, false);
  assert.match(after.text, /staging-host/, '改文件后 MCP 自动重载');
  const both = await rpc.callRaw('log_sources', {});
  assert.match(both.text, /dev-123: 源 dev-host/, '原标签仍在');
  assert.match(both.text, /staging: 源 staging-host/, '新标签同时有效');
  rpc.close();

  // 9) 删除标签 + 不允许删最后一个
  assert.equal((await call('DELETE', '/api/envs/default')).status, 200);
  assert.ok(!readDoc().envs.default);
  const delProd = await call('DELETE', '/api/envs/staging');
  assert.equal(delProd.status, 200);
  assert.ok(!readDoc().envs.staging);
  assert.equal((await call('DELETE', '/api/envs/dev-123')).status, 200);
  assert.deepEqual(readDoc().envs && Object.keys(readDoc().envs), ['prod'], '只剩一个标签');
  const delLast = await call('DELETE', '/api/envs/prod');
  assert.equal(delLast.status, 400);
  assert.match(delLast.data.error, /至少保留一个/);

  console.log('web-check 全部通过');
} finally {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

/** 起一个 MCP stdio 子进程，返回简化 rpc。 */
function mcp(configPath) {
  const child = spawn(process.execPath, [BIN, '--config', configPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  let seq = 0;
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });
  const send = (method, params) => {
    const id = ++seq;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve) => pending.set(id, resolve));
  };
  return {
    ready: send('initialize', { protocolVersion: '2024-11-05', capabilities: {} }),
    async call(name, args) {
      const res = await send('tools/call', { name, arguments: args });
      return res.result?.content?.[0]?.text ?? '';
    },
    async callRaw(name, args) {
      const res = await send('tools/call', { name, arguments: args });
      return { text: res.result?.content?.[0]?.text ?? '', isError: !!res.result?.isError };
    },
    close: () => child.kill(),
  };
}
