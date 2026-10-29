import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, 'tmp', 'apps', 'order', 'logs');
const TZ = 'Asia/Shanghai';

const partsFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function ts(date) {
  const p = {};
  for (const part of partsFmt.formatToParts(date)) if (part.type !== 'literal') p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

const line = (date, level, logger, msg) => `${ts(date)} ${level.padEnd(5)} 18234 --- [nio-8080-exec-3] ${logger} : ${msg}`;

const STACK = [
  'java.net.SocketTimeoutException: Read timed out',
  '\tat java.base/java.net.SocketInputStream.socketRead0(Native Method)',
  '\tat java.base/java.net.SocketInputStream.read(SocketInputStream.java:168)',
  '\tat com.example.order.gateway.AlipayClient.post(AlipayClient.java:88)',
  '\tat com.example.order.service.PaymentService.callback(PaymentService.java:142)',
  '\tat com.example.order.controller.PaymentController.callback(PaymentController.java:56)',
  '\t... 27 common frames omitted',
  'Caused by: java.net.SocketTimeoutException: connect timed out',
  '\tat java.base/java.net.SocketInputStream.socketRead0(Native Method)',
  '\t... 31 more',
];

const traceOf = (i) => `4f2a9c3b8d${String(i).padStart(4, '0')}`;
const base = Date.now() - 40 * 60 * 1000;
const out = [];

for (let i = 0; i < 120; i += 1) {
  const t = new Date(base + i * 10_000);
  const TRACE = traceOf(i);
  if (i % 20 === 0) {
    out.push(line(t, 'INFO', 'c.e.order.HeartbeatTask', 'heartbeat ok uptime=3120s'));
    continue;
  }
  if (i % 17 === 0) {
    out.push(line(t, 'WARN', 'c.e.order.OrderService', `慢查询 cost=${300 + i}ms sql=select * from t_order where id=${1000 + i}`));
    continue;
  }
  out.push(line(t, 'INFO', 'c.e.order.OrderController', `收到下单请求 traceId=${TRACE} orderId=${1000 + i} userId=${9000 + i}`));
  out.push(line(t, 'INFO', 'c.e.order.OrderService', `订单创建成功 traceId=${TRACE} orderId=${1000 + i} cost=${40 + (i % 30)}ms`));
  if (i % 23 === 0) {
    out.push(line(t, 'INFO', 'c.e.order.PaymentService', `调用支付网关 traceId=${TRACE} gateway=alipay cost=${60 + (i % 50)}ms`));
    out.push(line(t, 'ERROR', 'c.e.order.PaymentService', `支付回调失败 traceId=${TRACE} gateway=alipay code=500 orderId=${1000 + i}`));
    out.push(...STACK);
  }
}

fs.rmSync(path.join(HERE, 'tmp'), { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });
fs.writeFileSync(path.join(ROOT, 'app.log'), `${out.join('\n')}\n`, 'utf8');

const old = [];
const oldBase = base - 24 * 60 * 60 * 1000;
for (let i = 0; i < 30; i += 1) {
  const t = new Date(oldBase + i * 60_000);
  old.push(line(t, 'INFO', 'c.e.order.OrderController', `历史请求 traceId=old${i} orderId=${2000 + i}`));
  if (i === 12) {
    old.push(line(t, 'ERROR', 'c.e.order.OrderService', `历史异常 traceId=old${i} java.lang.IllegalStateException: bad state`));
  }
}
const gz = zlib.gzipSync(Buffer.from(`${old.join('\n')}\n`, 'utf8'));
fs.writeFileSync(path.join(ROOT, 'app.2026-08-12.0.log.gz'), gz);

console.log(`fixture ready: ${path.join(ROOT, 'app.log')} (${out.length} 行) + 1 gz, 时间基准 ${ts(new Date(base))}`);
