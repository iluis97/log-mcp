import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, 'tmp', 'docker');
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

// 与线上 b-detect 容器一致的 logback 自定义格式：带 ANSI 颜色、线程、X-Request-Id
const C = { WARN: '\u001b[31mWARN \u001b[0;39m', INFO: '\u001b[34mINFO \u001b[0;39m', ERROR: '\u001b[31mERROR\u001b[0;39m' };
const G = (name) => `\u001b[36m${name}\u001b[0;39m`;
const REQ = '968d23ad-95a1-4a30-9061-6f7e55f173e2';

const line = (date, req, level, logger, msg) =>
  `${ts(date)} [main] X-Request-Id=${req ?? ''} ${C[level]} ${G(logger)}:158 - ${msg}`;

const base = Date.now() - 30 * 60 * 1000;
const out = [];
const t0 = new Date(base);
out.push(line(t0, REQ, 'WARN', 'c.x.framework.mq.consumer.StarMQConsumerRegister', '[init] StarMQ consumer started. group=b-detect_CONSUMER topic=system-user tag=deleted consumeThreadCount=20'));
out.push(line(t0, REQ, 'INFO', 'c.a.cloud.nacos.refresh.NacosContextRefresher', '[Nacos Config] Listening config: dataId=b-detect, group=DEFAULT_GROUP'));
out.push(line(new Date(base + 20_000), '', 'INFO', 'o.a.c.core.ContainerBase.[Tomcat].[localhost].[/]', "Initializing Spring DispatcherServlet 'dispatcherServlet'"));

for (let i = 1; i <= 20; i += 1) {
  const t = new Date(base + i * 60_000);
  out.push(line(t, `req-${1000 + i}`, 'INFO', 'c.x.detect.service.DetectService', `收到检测数据 traceId=req-${1000 + i} deviceId=D${i} rssi=${-40 - i}dBm`));
  if (i === 7) {
    out.push(line(t, 'req-1007', 'ERROR', 'c.x.detect.service.UavDataService', '处理无人机数据失败 traceId=req-1007 deviceId=D7 code=500'));
    out.push('java.lang.NullPointerException: Cannot invoke "com.x.detect.model.Device.getSn()" because "device" is null');
    out.push('\tat com.x.detect.service.UavDataService.handle(UavDataService.java:142)');
    out.push('\tat com.x.detect.service.DetectService.onMessage(DetectService.java:88)');
    out.push('\t... 27 common frames omitted');
    out.push('Caused by: java.lang.IllegalStateException: device cache expired');
    out.push('\tat com.x.detect.cache.DeviceCache.get(DeviceCache.java:61)');
  }
  if (i % 10 === 0) {
    out.push(line(t, '', 'INFO', 'o.s.web.socket.config.WebSocketMessageBrokerStats', 'WebSocketSession[1 current WS(1)-HttpStream(0)-HttpPoll(0), 15 total, 0 closed abnormally]'));
  }
}

fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(path.join(DIR, 'b-detect.log'), `${out.join('\n')}\n`, 'utf8');
console.log(`docker fixture ready: ${path.join(DIR, 'b-detect.log')} (${out.length} 行)`);
