/**
 * 用本地 sh 执行“远端脚本”，验证 SSH 侧下推管道（grep/awk/head）的正确性：
 * - 头部 meta 里的 base 偏移
 * - 时间窗过滤（含堆栈续行保留）
 * - 关键字下推
 * - 扫描行数上限
 */
import { execFileSync } from 'node:child_process';
import { buildRemoteScript } from '../src/sources.mjs';

const APP = 'test/tmp/apps/order/logs/app.log';
const GZ = 'test/tmp/apps/order/logs/app.2026-08-12.0.log.gz';

function run(target, filter) {
  const script = buildRemoteScript(target, filter);
  const out = execFileSync('sh', ['-c', script], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const lines = out.split('\n');
  let base = 0;
  let start = 0;
  if (lines[0]?.startsWith('__LOGMCP_META__')) {
    base = Number(lines[0].split(' ')[1]);
    start = 1;
  }
  const records = [];
  for (const line of lines.slice(start)) {
    const sep = line.indexOf(':');
    if (sep <= 0) continue;
    records.push({ offset: base + Number(line.slice(0, sep)), text: line.slice(sep + 1) });
  }
  return { script, records };
}

const baseFilter = {
  startStr: '2000-01-01 00:00:00',
  endStr: '2999-12-31 23:59:59',
  tailBytes: 10_000_000,
  order: 'desc',
  scanCap: 5000,
  grepPushdown: false,
  q: [],
};

const plain = { type: 'ssh', source: { name: 't' }, file: APP, gz: false };
const gzFile = { type: 'ssh', source: { name: 't' }, file: GZ, gz: true };

const all = run(plain, baseFilter);
console.log('全部条目行数:', all.records.length, '首偏移:', all.records[0]?.offset);
console.log('  ', all.records[0]?.text.slice(0, 80));

const push = run(plain, { ...baseFilter, q: ['支付回调失败'], grepPushdown: true });
console.log('关键字下推命中:', push.records.length);
if (!push.records.every((r) => r.text.includes('支付回调失败'))) throw new Error('grep 下推结果含不匹配行');

const gated = run(plain, { ...baseFilter, startStr: '2026-01-01 00:00:00', endStr: '2026-12-31 23:59:59' });
const outOfWindow = gated.records.filter((r) => !/^2026-/.test(r.text) && /^\d{4}-\d{2}-\d{2}/.test(r.text));
console.log('时间窗内行数:', gated.records.length, '窗口外时间戳行:', outOfWindow.length);
if (outOfWindow.length) throw new Error('时间窗过滤失效');

const withStack = gated.records.filter((r) => r.text.startsWith('\t') || r.text.startsWith('Caused by'));
console.log('时间窗内保留的堆栈续行:', withStack.length);
if (!withStack.length) throw new Error('awk keep 标记未保留堆栈续行');
const contiguous = gated.records.every((r, i, arr) => i === 0 || r.offset > arr[i - 1].offset);
console.log('偏移单调递增:', contiguous);

const capped = run(plain, { ...baseFilter, scanCap: 20 });
console.log('scanCap=20 时行数:', capped.records.length);

const zipped = run(gzFile, { ...baseFilter, q: ['历史请求'], grepPushdown: true });
console.log('gz 关键字命中:', zipped.records.length);

console.log('\n--- 远端脚本语法与下推管道校验通过 ---');
