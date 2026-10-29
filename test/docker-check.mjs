/**
 * docker 源的两层校验：
 * 1) 解析层：容器自定义 logback 格式（ANSI + X-Request-Id + logger:line）能否被正确拆成条目
 * 2) 下推层：用本地 sh 执行 buildDockerScript（docker() 打桩为 cat fixture），校验偏移/时间窗/关键字下推
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseHead, fingerprint } = await import('../src/parse.mjs');
const { buildDockerScript } = await import('../src/sources.mjs');

const FIXTURE = 'test/tmp/docker/b-detect.log';
const raw = fs.readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean);

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const clean = (s) => s.replace(ANSI_RE, '');

let checked = 0;
const entries = [];
for (const line of raw) {
  const head = parseHead(clean(line));
  if (head) entries.push(head);
  checked += 1;
}
console.log(`解析行数=${checked} 条目数=${entries.length}`);

const first = entries[0];
console.log('首条:', JSON.stringify({ level: first.level, thread: first.thread, logger: first.logger, requestId: first.requestId, msg: first.msg.slice(0, 40) }));
if (first.level !== 'WARN') throw new Error('级别解析错误');
if (!first.requestId) throw new Error('X-Request-Id 未解析');
if (first.thread !== 'main') throw new Error('线程解析错误');

const err = entries.find((e) => e.level === 'ERROR');
console.log('错误条:', JSON.stringify({ logger: err.logger, msg: err.msg.slice(0, 30) }));
if (!err || !err.msg.includes('code=500')) throw new Error('ERROR 条目解析错误');

const plain = entries.find((e) => e.requestId === null);
console.log('无 Request-Id 条目:', plain?.msg.slice(0, 40));
if (!plain) throw new Error('空 X-Request-Id 未处理');

const noisy = entries.filter((e) => /[\u001b]/.test(e.msg)).length;
console.log('残留 ANSI 的条目:', noisy);
if (noisy) throw new Error('ANSI 未剥离');

// ---- 下推层 ----
const filter = {
  startStr: '2000-01-01 00:00:00',
  endStr: '2999-12-31 23:59:59',
  start: new Date('2000-01-01T00:00:00+08:00'),
  end: new Date('2999-12-31T23:59:59+08:00'),
  timezone: 'Asia/Shanghai',
  q: [],
  order: 'desc',
  scanCap: 5000,
  tailBytes: 0,
  grepPushdown: false,
};

const target = { type: 'docker', source: { name: 't', dockerPath: 'docker' }, file: 'b-detect', container: 'b-detect' };
const script = buildDockerScript(target, filter);

function run(extraPre, f) {
  const out = execFileSync('sh', ['-c', `${extraPre}\n${buildDockerScript(target, f)}`], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const lines = out.split('\n');
  if (!lines[0]?.startsWith('__LOGMCP_META__')) throw new Error('缺少 meta 头');
  const records = [];
  for (const line of lines.slice(1)) {
    const sep = line.indexOf(':');
    if (sep <= 0) continue;
    records.push({ offset: Number(line.slice(0, sep)), text: line.slice(sep + 1) });
  }
  return records;
}

const shim = `docker() { cat ${FIXTURE}; }`;
const all = run(shim, filter);
console.log('docker 下推总行数:', all.length, '首偏移:', all[0]?.offset);
if (all.length !== raw.length) throw new Error(`行数不符: ${all.length} != ${raw.length}`);
if (all.some((r, i) => i > 0 && r.offset <= all[i - 1].offset)) throw new Error('偏移非单调');

const pushed = run(shim, { ...filter, q: ['处理无人机数据失败'], grepPushdown: true });
console.log('关键字下推命中:', pushed.length);
if (!pushed.length || !pushed.every((r) => clean(r.text).includes('处理无人机数据失败'))) throw new Error('grep 下推异常');

const gated = run(shim, { ...filter, startStr: '2026-01-01 00:00:00', endStr: '2026-12-31 23:59:59' });
const outside = gated.filter((r) => /^\d{4}-\d{2}-\d{2}/.test(clean(r.text)) && !clean(r.text).startsWith('2026-'));
console.log('时间窗内行数:', gated.length, '窗口外:', outside.length);
if (outside.length) throw new Error('时间窗过滤失效');
const stackKept = gated.filter((r) => r.text.startsWith('\tat ') || r.text.startsWith('Caused by:'));
console.log('保留的堆栈续行:', stackKept.length);
if (!stackKept.length) throw new Error('堆栈续行被切断');

console.log('\n--- docker 源解析与下推校验通过 ---');
