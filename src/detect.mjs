/**
 * 格式自适应（format auto-detection）。
 *
 * 目标：不同服务、不同服务器上的日志格式各不相同（时间戳样式、级别写法、
 * traceId 位置、日志器字段都不同）。这里先"抽样 → 打分 → 记住"，之后
 * 每次排查直接用记住的档案，无需人工配置。
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { runCommand } from './exec.mjs';
import { sshArgs, shq } from './sources.mjs';
import path from 'node:path';
import { buildFormats, buildHeadPattern } from './formats.mjs';
import { compilePattern } from './regex.mjs';

const CACHE_VERSION = 3;
const SAMPLE_BYTES = 256 * 1024;

/* ---------------------------------- trace 规则学习 --------------------------------- */

const TRACE_KEYS = [
  'traceId', 'trace_id', 'traceid', 'trace', 'tid',
  'requestId', 'request_id', 'requestid', 'reqId', 'req_id',
  'X-Request-Id', 'x-request-id', 'X-Trace-Id', 'x-trace-id',
  'spanId', 'span_id', 'correlationId', 'correlation_id',
];

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const HEX_RE = /^[0-9a-fA-F]{16,64}$/;

function looksLikeTraceId(value) {
  const v = String(value ?? '').trim().replace(/^["']|["']$/g, '');
  if (!v || v.length < 8 || v.length > 64) return false;
  if (UUID_RE.test(v) || HEX_RE.test(v)) return true;
  // 短横线/下划线连接的 id，且包含数字
  return /^[A-Za-z0-9_-]{8,64}$/.test(v) && /\d/.test(v) && v.length >= 10;
}

/** 从样本里学习 traceId 的"键名 + 形态"，生成正则（含第 1 个捕获组）。 */
export function learnTracePattern(samples, existing = []) {
  const hits = new Map();

  const bump = (key, value) => {
    if (!looksLikeTraceId(value)) return;
    const pattern = UUID_RE.test(String(value).trim()) ? 'uuid' : 'token';
    const id = `${key}|${pattern}`;
    hits.set(id, (hits.get(id) ?? 0) + 1);
  };

  for (const text of samples) {
    for (const key of TRACE_KEYS) {
      const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // key=value / key: value / "key":"value"
      const re = new RegExp(`["']?${esc}["']?\\s*[=:]\\s*["']?([A-Za-z0-9_-]{8,64})`, 'i');
      const m = re.exec(text);
      if (m) bump(key, m[1]);
    }
    // 裸 UUID（常见于 [] 或日志开头）
    const uuid = /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/.exec(text);
    if (uuid) bump('<bare-uuid>', uuid[1]);
  }

  const learned = [...hits.entries()].sort((a, b) => b[1] - a[1]);
  if (!learned.length) return { pattern: null, source: 'none', samples: 0 };

  const [best, count] = learned[0];
  const [key, shape] = best.split('|');
  const valueRe = shape === 'uuid'
    ? '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
    : '[A-Za-z0-9_-]{8,64}';

  const pattern = key === '<bare-uuid>'
    ? `(${valueRe})`
    : `(?:${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})["']?\\s*[=:]\\s*["']?(${valueRe})`;

  try {
    compilePattern(pattern);
  } catch {
    return { pattern: null, source: 'invalid', samples: count };
  }
  return { pattern, source: `learned:${key}`, samples: count };
}

/* ------------------------------------ 格式打分 ------------------------------------ */

function candidateLines(lines) {
  // 只拿"像条目首行"的行做样本，避免堆栈/空行拉低命中率
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (/^\s+at\s|^Caused by:|^\s*\.\.\.\s|\t/.test(t)) continue;
    out.push(line);
    if (out.length >= 200) break;
  }
  return out;
}

/** 给每个格式档案打分：命中行数 / 样本行数。 */
export function scoreFormats(lines, cfg) {
  const samples = candidateLines(lines);
  if (!samples.length) return { best: null, scores: [], samples: 0 };

  const scores = [];
  for (const name of cfg.formatOrder) {
    const profile = cfg.formats[name];
    if (!profile) continue;
    let matched = 0;
    for (const line of samples) {
      const cleaned = line.includes('\x1b') ? line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '') : line;
      let ok = false;
      if (profile.kind === 'json') {
        ok = cleaned.startsWith('{') && /"(timestamp|time|@timestamp|ts|level|message)"/.test(cleaned);
      } else {
        ok = profile.re.test(cleaned);
        if (ok && !profile.levelOptional) {
          const m = profile.re.exec(cleaned);
          const lvl = String(m?.groups?.level ?? '').toUpperCase();
          ok = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'WARNING', 'ERROR', 'FATAL', 'CRITICAL'].includes(lvl);
        }
      }
      if (ok) matched += 1;
    }
    scores.push({ name, matched, total: samples.length, ratio: matched / samples.length });
  }

  scores.sort((a, b) => b.ratio - a.ratio || b.matched - a.matched);
  const best = scores[0] && scores[0].matched > 0 ? scores[0] : null;
  return { best, scores, samples: samples.length };
}

/* ------------------------------------- 缓存 ------------------------------------- */

function cacheFile(cfg) {
  return path.join(path.dirname(cfg.file), '.logmcp-cache.json');
}

function readCache(cfg) {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(cfg), 'utf8'));
    if (raw.version !== CACHE_VERSION) return {};
    return raw.entries ?? {};
  } catch {
    return {};
  }
}

function writeCache(cfg, entries) {
  try {
    fs.writeFileSync(cacheFile(cfg), JSON.stringify({ version: CACHE_VERSION, entries }, null, 2), 'utf8');
  } catch {
    /* 缓存写不了不影响功能 */
  }
}

export function cacheKeyFor(target) {
  return `${target.source.name}|${target.type === 'docker' ? target.container : target.file}`;
}

export function getCachedProfile(cfg, key) {
  const entry = readCache(cfg)[key];
  if (!entry) return null;
  if (entry.format && !cfg.formats[entry.format]) return null;
  return entry;
}

export function rememberProfile(cfg, key, profile) {
  const entries = readCache(cfg);
  entries[key] = { ...profile, learnedAt: new Date().toISOString() };
  writeCache(cfg, entries);
}

/* ------------------------------------ 抽样读取 ------------------------------------ */

/** 取一段开头样本（用于格式识别）：远端 head / docker logs --tail，本地读文件头。 */
export async function sampleLines(target, { timeoutMs = 20000 } = {}) {
  if (target.source.type === 'file') {
    const buf = await new Promise((resolve) => {
      const chunks = [];
      let size = 0;
      let stream;
      try {
        stream = target.gz
          ? fs.createReadStream(target.file).pipe(zlib.createGunzip())
          : fs.createReadStream(target.file, { start: 0 });
      } catch {
        resolve(Buffer.alloc(0));
        return;
      }
      stream.on('data', (c) => {
        chunks.push(c);
        size += c.length;
        if (size >= SAMPLE_BYTES) stream.destroy();
      });
      stream.on('close', () => resolve(Buffer.concat(chunks)));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', () => resolve(Buffer.concat(chunks)));
    });
    return buf.toString('utf8').split('\n').filter(Boolean).slice(0, 400);
  }

  const source = target.source;
  const cmd = target.type === 'docker'
    ? `${shq(source.dockerPath ?? 'docker')} logs --tail 400 ${shq(target.container)} 2>&1 | head -c ${SAMPLE_BYTES}`
    : `head -c ${SAMPLE_BYTES} -- ${shq(target.file)} | head -n 400`;
  const res = await runCommand(source.sshPath, sshArgs(source, cmd), { timeoutMs, maxBytes: SAMPLE_BYTES * 2 });
  const text = res.stdout.toString('utf8');
  if (!text.trim() && res.code !== 0) throw new Error(`采样失败(${source.name}): ${res.stderr.trim() || `exit ${res.code}`}`);
  return text.split('\n').filter(Boolean).slice(0, 400);
}

/* ------------------------------------ 主入口 ------------------------------------ */

/**
 * 对一个目标做格式自适应：命中缓存则直接用，否则抽样 → 打分 → 学习 trace → 落缓存。
 * 返回 { format, tracePattern, samples, scores, cached }
 */
export async function adaptTarget(cfg, target, { force = false, enrichTrace = true } = {}) {
  const key = cacheKeyFor(target);
  const fixed = target.format ?? null;
  if (fixed && !force) {
    return { key, format: fixed, tracePattern: null, samples: 0, cached: true, fixed: true, scores: [] };
  }

  if (!force) {
    const cached = getCachedProfile(cfg, key);
    if (cached) return { key, cached: true, scores: [], ...cached };
  }

  let lines = [];
  let sampleError = null;
  try {
    lines = await sampleLines(target);
  } catch (err) {
    sampleError = err.message;
  }

  if (!lines.length) {
    return { key, format: null, tracePattern: null, samples: 0, cached: false, scores: [], error: sampleError ?? '采样为空' };
  }

  const { best, scores, samples } = scoreFormats(lines, cfg);
  const learnedTrace = enrichTrace ? learnTracePattern(lines, cfg.tracePatterns) : { pattern: null, source: 'skipped' };
  const headSamples = lines.filter((l) => /^\d{4}[-/]\d{2}|\{/.test(l)).slice(0, 3);

  const profile = {
    format: best?.name ?? null,
    formatRatio: best ? Number(best.ratio.toFixed(3)) : 0,
    tracePattern: learnedTrace.pattern,
    traceSource: learnedTrace.source,
    tsSample: headSamples[0] ?? null,
    samples,
  };

  rememberProfile(cfg, key, profile);
  return { key, cached: false, scores, ...profile };
}

/** 把学到/配置的 trace 规则合进 cfg（供 parse 使用），返回新的 cfg 视图。 */
export function withTraceOverride(cfg, pattern) {
  if (!pattern) return cfg;
  if (cfg.tracePatterns.includes(pattern)) return cfg;
  return { ...cfg, tracePatterns: [pattern, ...cfg.tracePatterns] };
}

/** 重新加载格式定义（用户改了配置里的 formats 时调用）。 */
export function rebuildFormats(custom = {}) {
  return buildFormats(custom);
}

