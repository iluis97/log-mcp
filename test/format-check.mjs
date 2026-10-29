/**
 * 格式档案（format profile）校验：
 * - 内置格式自动识别（spring / star-mvc / json / loose）
 * - 自定义格式只改配置就能用
 * - JSON 行的时间归一（ISO / 毫秒时间戳 → 配置时区）
 * - 每类格式生成的远端 awk 是否合理（JSON 不做行首时间门）
 */
import { buildFormats, buildHeadPattern } from '../src/formats.mjs';
import { parseHead, buildEntries } from '../src/parse.mjs';
import { buildDockerScript } from '../src/sources.mjs';

const { formats, formatOrder } = buildFormats({
  'my-app': {
    kind: 'regex',
    pattern:
      '^(?<ts>\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2})\\s+\\|(?<level>[A-Z]+)\\|\\s+(?<logger>[\\w.$]+)\\s+::\\s+(?<msg>.*)$',
    head: '^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] ',
    ts: { prefix: true, offset: 0, length: 19 },
  },
});

const cfg = {
  formats,
  formatOrder,
  timezone: 'Asia/Shanghai',
  tracePatterns: ['(?:traceId)[=:]\\s*([0-9a-zA-Z-]{6,})'],
  noisePatterns: [],
};

const cases = [
  {
    name: 'spring',
    line: '2026-10-28 10:34:51.796  INFO 18234 --- [nio-8080-exec-3] c.e.order.OrderController : 收到下单请求 orderId=1001',
    expect: { level: 'INFO', logger: 'c.e.order.OrderController', thread: 'nio-8080-exec-3' },
  },
  {
    name: 'star-mvc',
    line: '\u001b[34m2026-10-28 10:34:51.796 [main] X-Request-Id=968d23ad-95a1-4a30-9061-6f7e55f173e2 WARN  c.x.framework.mq.StarMQConsumerRegister:158 - [init] consumer started\u001b[0;39m',
    expect: { level: 'WARN', logger: 'c.x.framework.mq.StarMQConsumerRegister', requestId: '968d23ad-95a1-4a30-9061-6f7e55f173e2' },
  },
  {
    name: 'star-id-first',
    line: '2026-10-28 16:39:56.043 af48810f-5187-4c68-86b5-d3a0ff091b5d [http-nio-8080-exec-9] INFO  c.x.f.a.core.interceptor.ApiAccessLogInterceptor:51 - [preHandle][开始请求 URL(/rpc-api/iot/gateway/v2/heartbeat)',
    expect: {
      level: 'INFO',
      thread: 'http-nio-8080-exec-9',
      logger: 'c.x.f.a.core.interceptor.ApiAccessLogInterceptor',
      requestId: 'af48810f-5187-4c68-86b5-d3a0ff091b5d',
    },
  },
  {
    name: 'my-app',
    line: '2026-10-28 10:34:51 |ERROR| com.acme.Foo :: boom happened',
    expect: { level: 'ERROR', logger: 'com.acme.Foo', msg: 'boom happened' },
  },
  {
    name: 'loose',
    line: '2026-10-28 10:34:51 WARN 磁盘使用率 91%',
    expect: { level: 'WARN', msg: '磁盘使用率 91%' },
  },
];

for (const c of cases) {
  const head = parseHead(c.line, cfg);
  if (!head) throw new Error(`[${c.name}] 未识别`);
  for (const [k, v] of Object.entries(c.expect)) {
    if (head[k] !== v) throw new Error(`[${c.name}] ${k} 期望 ${JSON.stringify(v)} 实际 ${JSON.stringify(head[k])}`);
  }
  console.log(`[${c.name}] ok → ${head.level} ${head.logger}${head.requestId ? ` req=${head.requestId.slice(0, 8)}…` : ''}`);
}

// 显式指定格式时，不应被其它格式"抢走"
const onlySpring = parseHead(cases[1].line, cfg, 'spring');
if (onlySpring) throw new Error('显式 spring 格式不应匹配 star-mvc 行');
const onlyStar = parseHead(cases[0].line, cfg, 'star-mvc');
if (onlyStar) throw new Error('显式 star-mvc 格式不应匹配 spring 行');
console.log('[explicit format] ok');

// JSON 行：ISO / 毫秒时间戳都要归一成配置时区的 tsKey
async function entryOf(text) {
  const lines = (async function* gen() {
    yield { offset: 0, text };
  })();
  const out = [];
  for await (const e of buildEntries(lines, cfg, { sourceName: 't', file: 'x.log' })) out.push(e);
  return out[0];
}

const isoEntry = await entryOf('{"timestamp":"2026-10-28T02:34:51.798Z","level":"ERROR","logger":"a.b.C","message":"boom https://x/y","traceId":"abc12345"}');
if (isoEntry.tsKey !== '2026-10-28 10:34:51') throw new Error(`ISO 时间归一错误: ${isoEntry.tsKey}`);
if (isoEntry.traceId !== 'abc12345') throw new Error('JSON traceId 未提取');
if (isoEntry.level !== 'ERROR') throw new Error('JSON level 未提取');
console.log('json ISO → tsKey', isoEntry.tsKey, '| trace', isoEntry.traceId);

const epochEntry = await entryOf('{"time":1793154891798,"severity":"warn","msg":"slow sql","logger":"d.e.F"}');
if (epochEntry.tsKey !== '2026-10-28 10:34:51') throw new Error(`毫秒时间归一错误: ${epochEntry.tsKey}`);
console.log('json epoch → tsKey', epochEntry.tsKey);

// 远端时间门：文本格式有 head；JSON 无 head（本地过滤）
const auto = buildHeadPattern(cfg, null);
if (!auto.headPattern || !auto.headPattern.includes('|')) throw new Error('自动识别应合并多个 head');
const jsonHead = buildHeadPattern(cfg, 'json');
if (jsonHead.headPattern !== null) throw new Error('JSON 格式不应有行首时间门');
console.log('head(auto) =', auto.headPattern.slice(0, 60), '…');
console.log('head(json) =', jsonHead.headPattern);

const filter = {
  startStr: '2026-10-28 10:00:00',
  endStr: '2026-10-28 11:00:00',
  start: new Date('2026-10-28T10:00:00+08:00'),
  end: new Date('2026-10-28T11:00:00+08:00'),
  timezone: 'Asia/Shanghai',
  q: [],
  order: 'desc',
  scanCap: 100,
  tailBytes: 0,
  grepPushdown: false,
  timeoutMs: 5000,
};
const jsonTarget = { type: 'docker', source: { name: 't', dockerPath: 'docker' }, container: 'x', head: jsonHead };
const jsonScript = buildDockerScript(jsonTarget, filter);
if (jsonScript.includes('ishead')) throw new Error('JSON 格式的脚本不应包含 ishead 时间门');
console.log('docker script(json) 无时间门 ✓');

const textTarget = { ...jsonTarget, head: buildHeadPattern(cfg, 'my-app') };
const textScript = buildDockerScript(textTarget, filter);
if (!textScript.includes('ishead')) throw new Error('文本格式的脚本应包含 ishead 时间门');
if (!textScript.includes('substr(ln, 1, 19)')) throw new Error('时间取位未按格式配置生成');
console.log('docker script(my-app) 含时间门 ✓');

console.log('\n--- 格式档案校验通过 ---');
