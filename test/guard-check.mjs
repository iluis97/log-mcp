/**
 * 会话级数据源锁：验证「模型不能逐个标签试」这条硬约束。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.dirname(HERE);
const BIN = path.join(PKG, 'bin', 'logmcp.mjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logmcp-guard-'));
for (const env of ['a', 'b']) {
  fs.mkdirSync(path.join(dir, env), { recursive: true });
  fs.writeFileSync(path.join(dir, env, 'app.log'), `2026-10-28 17:00:0${env === 'a' ? 1 : 2}.000 INFO  demo | ${env} 的日志\n`);
}
const configFile = path.join(dir, 'logmcp.config.json');
fs.writeFileSync(
  configFile,
  JSON.stringify({
    envs: {
      'dev-a': { source: { name: 'src-a', type: 'file', roots: [path.join(dir, 'a')], glob: '**/*.log*' }, services: { app: { glob: 'app.log' } } },
      'dev-b': { source: { name: 'src-b', type: 'file', roots: [path.join(dir, 'b')], glob: '**/*.log*' }, services: { app: { glob: 'app.log' } } },
    },
  }),
);

const child = spawn(process.execPath, [BIN, '--config', configFile], { stdio: ['pipe', 'pipe', 'pipe'] });
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
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  }
});
const send = (method, params) => {
  const id = ++seq;
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolve) => pending.set(id, resolve));
};
const call = async (name, args) => {
  const res = await send('tools/call', { name, arguments: args });
  return { text: res.result?.content?.[0]?.text ?? '', isError: !!res.result?.isError };
};

try {
  const init = await send('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  assert.match(init.result.instructions, /log_confirm_env/, '服务端下发 instructions（相当于内置技能）');
  assert.match(init.result.instructions, /不允许自己挑/, '明确规定不许自己挑标签');
  assert.ok((await send('tools/list')).result.tools.some((t) => t.name === 'log_confirm_env'), '有确认工具');

  // 1) 不带 env → 拒绝，并给出候选
  const first = await call('log_search', { last: '7d' });
  assert.equal(first.isError, true);
  assert.match(first.text, /必须先确定用哪个/);
  assert.match(first.text, /dev-a \| dev-b/);
  assert.match(first.text, /不要逐个标签去试|不要再逐个标签/);

  // 2) 紧接着想去试 dev-a：仍然被拒（pending 期间不放行）
  const tryA = await call('log_search', { env: 'dev-a', last: '7d' });
  assert.equal(tryA.isError, true, 'pending 期间带 env 也拒绝');
  assert.match(tryA.text, /还没有确定日志数据源/);

  // 3) 再试 dev-b：同样被拒，并升级提示
  const tryB = await call('log_summarize', { env: 'dev-b', last: '7d' });
  assert.equal(tryB.isError, true);
  assert.match(tryB.text, /第 \d+ 次被拒绝/);

  // 4) log_sources / log_playbook 不受影响（不下结论）
  const overview = await call('log_sources', {});
  assert.equal(overview.isError, false);
  assert.match(overview.text, /dev-a/);
  assert.equal((await call('log_playbook', {})).isError, false);

  // 5) 确认必须带 evidence
  const noEvidence = await call('log_confirm_env', { env: 'dev-a' });
  assert.equal(noEvidence.isError, true);
  assert.match(noEvidence.text, /evidence/);

  // 6) 确认后放行，并且锁定
  const confirm = await call('log_confirm_env', { env: 'dev-a', evidence: '用户说：看 dev-a' });
  assert.equal(confirm.isError, false);
  assert.match(confirm.text, /已确认数据源：dev-a/);

  const okA = await call('log_search', { env: 'dev-a', last: '7d' });
  assert.equal(okA.isError, false);
  assert.match(okA.text, /a 的日志/);

  // 7) 锁定后换标签被拒（"每个都试一遍"在这里断掉）
  const switchB = await call('log_search', { env: 'dev-b', last: '7d' });
  assert.equal(switchB.isError, true);
  assert.match(switchB.text, /已确认为 dev-a/);

  // 8) 不带 env 也不再放行（不会偷偷用默认值）
  const noEnv = await call('log_search', { last: '7d' });
  assert.equal(noEnv.isError, true);

  // 9) 用户明确要换 → 重新确认后可以查 dev-b
  const confirmB = await call('log_confirm_env', { env: 'dev-b', evidence: '用户改主意：看 dev-b' });
  assert.equal(confirmB.isError, false);
  const okB = await call('log_search', { env: 'dev-b', last: '7d' });
  assert.equal(okB.isError, false);
  assert.match(okB.text, /b 的日志/);

  // 10) 确认不存在的标签要报错
  const bad = await call('log_confirm_env', { env: 'nope', evidence: '瞎猜' });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /没有 nope 这个标签/);

  console.log('guard-check 全部通过');
} finally {
  child.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}
