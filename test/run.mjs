import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.dirname(HERE);
const CONFIG = path.join(HERE, 'config.json');
const BIN = path.join(PKG, 'bin', 'logmcp.mjs');

const child = spawn(process.execPath, [BIN, '--config', CONFIG], {
  cwd: PKG,
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buf = '';
const pending = new Map();
child.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error('非法响应:', line);
      continue;
    }
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

let seq = 0;
function rpc(method, params) {
  const id = ++seq;
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolve) => pending.set(id, resolve));
}
function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

async function call(name, args) {
  const res = await rpc('tools/call', { name, arguments: args });
  const text = res.result?.content?.[0]?.text ?? JSON.stringify(res.error ?? res);
  console.log(`\n===== ${name} ${JSON.stringify(args ?? {})} =====`);
  console.log(`isError=${res.result?.isError ?? false}`);
  console.log(text);
  return text;
}

const init = await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'logmcp-test', version: '0' },
});
console.log('initialize:', JSON.stringify(init.result));
notify('notifications/initialized', {});

const list = await rpc('tools/list', {});
console.log('tools:', list.result?.tools?.map((t) => t.name).join(', '));

await call('log_sources', {});
await call('log_search', { last: '2h', q: ['支付回调失败'] });
const withIds = await call('log_search', { last: '2h', level: 'ERROR', maxLines: 5 });
const hit = /\[(h[0-9a-z]+)\]/.exec(withIds)?.[1];
if (!hit) throw new Error('未从 log_search 结果中解析到 hit id');
await call('log_context', { hit, before: 1, after: 3 });
await call('log_summarize', { last: '2h', groupBy: ['level', 'template'], bucket: '1m', topN: 5 });
await call('log_trace', { traceId: '4f2a9c3b8d0023', last: '2h' });
await call('log_search', { from: '2020-01-01 00:00:00', to: '2999-01-01 00:00:00', glob: 'order/logs/*.gz', maxLines: 3 });
await call('log_playbook', {});
await call('log_investigate', { service: 'order', keywords: ['支付回调失败'], last: '2h', maxEvidence: 2 });

console.log('\n--- 测试完成 ---');
child.kill();
process.exit(0);
