/**
 * 格式自适应：抽样打分 / trace 规则学习 / 缓存。
 */
import fs from 'node:fs';
import { buildFormats } from '../src/formats.mjs';
import { scoreFormats, learnTracePattern, adaptTarget } from '../src/detect.mjs';

const { formats, formatOrder } = buildFormats();
const cfg = {
  file: 'test/tmp/adapt-cache.dummy.json',
  formats,
  formatOrder,
  timezone: 'Asia/Shanghai',
  tracePatterns: ['(?:traceId|trace_id)["\']?\\s*[=:]\\s*["\']?([0-9a-zA-Z_-]{8,64})'],
  noisePatterns: [],
};

const springLines = fs.readFileSync('test/tmp/apps/order/logs/app.log', 'utf8').split('\n').slice(0, 200);
const starLines = fs.readFileSync('test/tmp/docker/b-detect.log', 'utf8').split('\n').slice(0, 100);

const springScore = scoreFormats(springLines, cfg);
const starScore = scoreFormats(starLines, cfg);
console.log('spring 最佳:', springScore.best?.name, springScore.best?.ratio, '| 样本', springScore.samples);
console.log('star-mvc 最佳:', starScore.best?.name, starScore.best?.ratio);
if (springScore.best?.name !== 'spring') throw new Error(`spring 识别错误: ${springScore.best?.name}`);
if (starScore.best?.name !== 'star-mvc') throw new Error(`star-mvc 识别错误: ${starScore.best?.name}`);
if (springScore.samples < 10) throw new Error('样本行过少');

// 首行/少量行也要能认出来（新服务、日志刚轮转）
const tiny = scoreFormats(springLines.slice(0, 3), cfg);
console.log('3 行样本:', tiny.best?.name, tiny.best?.ratio);
if (tiny.best?.name !== 'spring') throw new Error('少量样本识别失败');

// 另一种 Star 风格（id 在时间戳后）：不应被 generic 抢走
const idFirstLines = [
  '2026-10-28 16:39:56.043 af48810f-5187-4c68-86b5-d3a0ff091b5d [http-nio-8080-exec-9] INFO  c.x.f.a.core.interceptor.ApiAccessLogInterceptor:51 - [preHandle][开始请求 URL(/rpc-api/iot/gateway/v2/heartbeat)',
  '2026-10-28 16:39:56.097 af48810f-5187-4c68-86b5-d3a0ff091b5d [http-nio-8080-exec-9] INFO  c.x.f.a.core.interceptor.ApiAccessLogInterceptor:90 - [afterCompletion][完成请求 耗时 54ms',
];
const idFirstScore = scoreFormats(idFirstLines, cfg);
console.log('id-first 最佳:', idFirstScore.best?.name, idFirstScore.best?.ratio);
if (idFirstScore.best?.name !== 'star-id-first') throw new Error(`id-first 识别错误: ${idFirstScore.best?.name}`);

// trace 规则学习
const learned = learnTracePattern(starLines, cfg.tracePatterns);
console.log('star-mvc trace:', learned.source, learned.pattern?.slice(0, 60));
if (!learned.pattern) throw new Error('未学到 trace 规则');
const sample = starLines.find((l) => l.includes('X-Request-Id='));
const got = new RegExp(learned.pattern).exec(sample)?.[1];
console.log('提取结果:', got);
if (!got) throw new Error('学到的规则无法提取 trace id');

const learnedSpring = learnTracePattern(springLines, cfg.tracePatterns);
console.log('spring trace:', learnedSpring.source);
const springSample = springLines.find((l) => l.includes('traceId='));
if (!new RegExp(learnedSpring.pattern).exec(springSample)?.[1]) throw new Error('spring trace 规则失效');

// 缓存：同一目标第二次应命中缓存，不再采样
try {
  fs.rmSync('test/tmp/.logmcp-cache.json', { force: true });
} catch {
  /* ignore */
}
const target = { type: 'file', source: { name: 'local-dev', type: 'file' }, file: 'test/tmp/apps/order/logs/app.log', gz: false };
const first = await adaptTarget(cfg, target);
const second = await adaptTarget(cfg, target);
console.log('首次:', first.format, first.cached, '| 二次:', second.format, second.cached);
if (first.format !== 'spring') throw new Error('自适应结果不是 spring');
if (second.cached !== true) throw new Error('缓存未生效');
if (!fs.existsSync('test/tmp/.logmcp-cache.json')) throw new Error('缓存文件未生成');

// force 应绕过缓存
const forced = await adaptTarget(cfg, target, { force: true });
if (forced.cached !== false) throw new Error('force 未绕过缓存');

console.log('\n--- 格式自适应校验通过 ---');
