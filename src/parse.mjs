import { compilePattern } from './regex.mjs';
import { parseZoned, formatZoned } from './time.mjs';
import { buildFormats } from './formats.mjs';

export const LEVEL_RANK = { TRACE: 0, DEBUG: 1, INFO: 2, WARN: 3, ERROR: 4, FATAL: 5 };
export const LEVEL_NAMES = Object.keys(LEVEL_RANK);

/** 不同框架/语言的级别写法统一到 5 档 */
const LEVEL_ALIASES = {
  WARNING: 'WARN',
  ERR: 'ERROR',
  SEVERE: 'ERROR',
  CRITICAL: 'FATAL',
  PANIC: 'FATAL',
  NOTICE: 'INFO',
  INFORMATIONAL: 'INFO',
};

function normLevel(raw) {
  const up = String(raw ?? '').trim().toUpperCase();
  if (!up) return null;
  const mapped = LEVEL_ALIASES[up] ?? up;
  return mapped in LEVEL_RANK ? mapped : null;
}

/** 未传配置时（如单元测试直接调 parseHead）使用的内置格式集合 */
const DEFAULT_PROFILES = buildFormats();

const FP_RULES = [
  [/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, '<uuid>'],
  [/\b[0-9a-fA-F]{16,}\b/g, '<hex>'],
  // 不纯 hex 但形如 traceId=4f2a9c3b8d0023 的 id（≥8 位、含字母和数字）
  [/\b(?=[0-9a-fA-F]*[a-fA-F])(?=[0-9a-fA-F]*\d)[0-9a-fA-F]{8,32}\b/g, '<id>'],
  [/(?=[0-9a-fA-F]*[a-fA-F])(?=[0-9a-fA-F]*\d)[0-9a-fA-F]{8,32}/g, '<id>'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '<ip>'],
  [/'(?:[^'\\]|\\.)*'/g, "'<str>'"],
  [/"(?:[^"\\]|\\.)*"/g, '"<str>"'],
  [/\b\d+(?:\.\d+)?(?:ms|s|MB|GB|KB|B)?\b/g, '<n>'],
];

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const ZONED_TS = /[Zz]$|[+-]\d{2}:?\d{2}$/;

const patternCache = new WeakMap();

function stripAnsi(text) {
  return text.includes('\x1b') ? text.replace(ANSI_RE, '') : text;
}

function compiledPatterns(cfg) {
  let p = patternCache.get(cfg);
  if (!p) {
    p = {
      trace: cfg.tracePatterns.map((s) => compilePattern(s)),
      noise: cfg.noisePatterns.map((s) => compilePattern(s, 'i')),
    };
    patternCache.set(cfg, p);
  }
  return p;
}

function profilesFor(cfg, formatName) {
  if (!cfg?.formats) {
    const list = formatName ? [DEFAULT_PROFILES.formats[formatName]].filter(Boolean) : DEFAULT_PROFILES.formatOrder.map((n) => DEFAULT_PROFILES.formats[n]);
    return list;
  }
  if (formatName) {
    const f = cfg.formats[formatName];
    return f ? [f] : [];
  }
  return cfg.formatOrder.map((n) => cfg.formats[n]);
}

export function isEntryHead(text) {
  return /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(text);
}

/** 数字时间戳（秒/毫秒）统一成 ISO，便于后续按配置时区归一。 */
function normalizeEpochTs(raw) {
  const s = String(raw).trim();
  if (!/^\d{10,13}$/.test(s)) return s;
  const ms = s.length === 10 ? Number(s) * 1000 : Number(s);
  return new Date(ms).toISOString();
}

function pickField(obj, keys) {
  for (const key of keys) {
    const value = obj[key];
    if (value != null && value !== '') return String(value);
  }
  return null;
}

function parseJsonLine(text, profile) {
  if (!text.startsWith('{')) return null;
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const rawTs = pickField(obj, profile.fields.ts);
  if (!rawTs) return null;
  const level = normLevel(pickField(obj, profile.fields.level)) ?? 'INFO';
  return {
    rawTs: normalizeEpochTs(rawTs),
    level,
    thread: '',
    logger: pickField(obj, profile.fields.logger) ?? '',
    requestId: pickField(obj, profile.fields.trace),
    msg: pickField(obj, profile.fields.msg) ?? '',
  };
}

function parseRegexLine(text, profile) {
  const m = profile.re.exec(text);
  if (!m) return null;
  const g = m.groups ?? {};
  let level = normLevel(g.level);
  let msg = g.msg ?? '';
  if (!level) {
    // 通用格式允许没有级别：把被误当级别的首词放回消息
    if (!profile.levelOptional) return null;
    if (g.level) msg = `${g.level}${msg ? ` ${msg}` : ''}`;
    level = 'INFO';
    // 常见装饰写法：[ERROR] xxx / |ERROR| xxx / <ERROR> xxx / ERROR: xxx
    const decorated = /^(?:\[([A-Za-z]{3,10})\]|\|([A-Za-z]{3,10})\||<([A-Za-z]{3,10})>|([A-Za-z]{3,10})\s*[:|-])\s*/.exec(msg);
    const decoratedLevel = decorated ? normLevel(decorated[1] ?? decorated[2] ?? decorated[3] ?? decorated[4]) : null;
    if (decoratedLevel) {
      level = decoratedLevel;
      msg = msg.slice(decorated[0].length);
    }
  }
  return {
    rawTs: g.ts ?? '',
    level,
    thread: g.thread ?? '',
    logger: g.logger ?? '',
    requestId: g.requestId ? g.requestId : null,
    msg,
  };
}

function parseLine(text, profile) {
  return profile.kind === 'json' ? parseJsonLine(text, profile) : parseRegexLine(text, profile);
}

/** 按格式档案解析一行；不传 cfg 时使用内置格式，自动识别。 */
export function parseHead(text, cfg, formatName) {
  const cleaned = stripAnsi(text);
  for (const profile of profilesFor(cfg, formatName)) {
    const head = parseLine(cleaned, profile);
    if (head) return head;
  }
  return null;
}

/** 模板指纹：把变量替换成占位符，用于聚合与"新错误"判定。 */
export function fingerprint(msg) {
  let s = String(msg ?? '').split('\n')[0].slice(0, 400);
  for (const [re, rep] of FP_RULES) s = s.replace(re, rep);
  return s.slice(0, 200) || '(空消息)';
}

function extractTrace(msg, patterns) {
  for (const re of patterns) {
    const m = re.exec(msg);
    if (m?.[1]) return m[1];
  }
  return null;
}

function exceptionOf(lines) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:Exception|Error))\b/.exec(lines[i]);
    if (m) return m[1];
  }
  return null;
}

/** 时间键：本地墙钟直接切片（快），带时区的 ISO 先换算到配置时区。 */
function tsKeyOf(rawTs, cfg) {
  const fast = rawTs.slice(0, 19).replace('T', ' ');
  if (!ZONED_TS.test(rawTs)) return fast;
  const parsed = parseZoned(rawTs, cfg.timezone);
  return parsed ? formatZoned(parsed, cfg.timezone) : fast;
}

function finalize(entry, cfg, patterns) {
  const headLine = entry.lines[0] ?? '';
  entry.traceId =
    extractTrace(headLine, patterns.trace) ?? extractTrace(entry.msg, patterns.trace) ?? entry.requestId ?? null;
  entry.tsKey = tsKeyOf(entry.rawTs, cfg);
  entry.template = fingerprint(entry.msg);
  entry.exception = exceptionOf(entry.lines);
  entry.noise = patterns.noise.length > 0 && patterns.noise.some((re) => entry.lines.some((l) => re.test(l)));
  entry.text = entry.lines.join('\n').slice(0, 16 * 1024);
  entry.messageLines = entry.lines.length;
  return entry;
}

/**
 * 把行流聚合成"日志条目"：多行堆栈归属到上一条时间戳行。
 * meta.format 可指定格式档案，未指定则按配置顺序自动识别。
 */
export async function* buildEntries(lines, cfg, meta) {
  const patterns = compiledPatterns(cfg);
  const profiles = profilesFor(cfg, meta.format ?? null);
  let cur = null;

  for await (const rec of lines) {
    const text = stripAnsi(rec.text);
    let head = null;
    for (const profile of profiles) {
      head = parseLine(text, profile);
      if (head) break;
    }
    if (head) {
      if (cur) yield finalize(cur, cfg, patterns);
      cur = {
        ...head,
        format: meta.format ?? null,
        offset: rec.offset,
        gz: rec.gz ?? meta.gz ?? false,
        sourceName: meta.sourceName,
        file: meta.file,
        container: meta.container ?? null,
        targetType: meta.targetType ?? 'file',
        source: meta.source ?? null,
        service: meta.service ?? meta.sourceName,
        lines: [text],
        hiddenLines: 0,
      };
    } else if (cur) {
      if (cur.lines.length < 400) cur.lines.push(text);
      else cur.hiddenLines += 1;
    }
  }
  if (cur) yield finalize(cur, cfg, patterns);
}
