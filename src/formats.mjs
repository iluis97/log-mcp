/**
 * 日志格式档案（format profile）。
 * 把"日志行长什么样"从代码里拿出来：parse 用 pattern，远端 awk 用 head，
 * 时间过滤用 ts 前缀信息。新增日志格式只需加配置，不改代码。
 */

const TS = '\\d{4}-\\d{2}-\\d{2}[ T]\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d{1,3})?';
/** POSIX awk 可用的"条目首行"判定（行首时间戳） */
const TS_HEAD = '^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9][ T][0-9][0-9]:[0-9][0-9]:[0-9][0-9]';

export const BUILTIN_FORMATS = {
  // Spring Boot / logback 默认：时间 级别 [pid] --- [线程] logger : 消息
  spring: {
    kind: 'regex',
    pattern: `^(?<ts>${TS})\\s+(?<level>[A-Za-z]{3,7})\\s+(?:\\d+\\s+)?---\\s+\\[\\s*(?<thread>[^\\]]*?)\\s*\\]\\s*(?<logger>\\S*?)\\s*:\\s?(?<msg>[\\s\\S]*)$`,
    head: TS_HEAD,
    ts: { prefix: true, offset: 0, length: 19 },
  },
  // Star 框架容器日志：时间 [线程] X-Request-Id=... 级别 logger:行 - 消息
  'star-mvc': {
    kind: 'regex',
    pattern: `^(?<ts>${TS})\\s+\\[(?<thread>[^\\]]*)\\]\\s+(?:(?:X-Request-Id|X-Trace-Id|x-request-id|x-trace-id)=(?<requestId>\\S*)\\s+)?(?<level>[A-Za-z]{3,7})\\s+(?<logger>[^\\s:]+)(?::\\d+)?\\s+-\\s+(?<msg>[\\s\\S]*)$`,
    head: TS_HEAD,
    ts: { prefix: true, offset: 0, length: 19 },
  },
  // Star 框架另一种容器日志：时间 <requestId> [线程] 级别 logger:行 - 消息
  'star-id-first': {
    kind: 'regex',
    pattern: `^(?<ts>${TS})\\s+(?<requestId>[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\\s+\\[(?<thread>[^\\]]*)\\]\\s+(?<level>[A-Za-z]{3,7})\\s+(?<logger>[^\\s:]+)(?::\\d+)?\\s+-\\s+(?<msg>[\\s\\S]*)$`,
    head: TS_HEAD,
    ts: { prefix: true, offset: 0, length: 19 },
  },
  // JSON lines：字段名可按需覆盖
  json: {
    kind: 'json',
    head: '^[{]',
    ts: { prefix: false },
    fields: {
      ts: ['timestamp', 'time', '@timestamp', 'ts', 'logTime'],
      level: ['level', 'severity', 'lvl'],
      logger: ['logger', 'logger_name', 'name', 'class'],
      msg: ['message', 'msg', 'log'],
      trace: ['traceId', 'trace_id', 'trace', 'X-Request-Id', 'requestId'],
    },
  },
  // 兜底：只有时间 + 级别，其余整体当消息
  loose: {
    kind: 'regex',
    pattern: `^(?<ts>${TS})\\s+(?<level>[A-Za-z]{3,7})\\b\\s*(?:(?<logger>[^\\s:]+):\\s*)?(?<msg>[\\s\\S]*)$`,
    head: TS_HEAD,
    ts: { prefix: true, offset: 0, length: 19 },
  },
  // 通用：任意前导时间戳（- 或 / 分隔、可带 T/Z/时区、毫秒~微秒），级别可有可无
  generic: {
    kind: 'regex',
    pattern: `^(?<ts>\\d{4}[-/]\\d{2}[-/]\\d{2}[ T]\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d{1,6})?(?:Z|[+-]\\d{2}:?\\d{2})?)\\s+(?:(?<level>[A-Za-z]{3,10})\\b\\s*[-|:]?\\s*)?(?<msg>[\\s\\S]*)$`,
    head: null,
    ts: { prefix: false },
    levelOptional: true,
  },
};

const BUILTIN_ORDER = ['spring', 'star-mvc', 'star-id-first', 'json', 'loose', 'generic'];
/** 兜底格式：打分与自动识别时降权，避免抢走更精确的格式 */
export const FALLBACK_FORMATS = new Set(['loose', 'generic']);

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function compileFormat(name, spec) {
  if (!spec || typeof spec !== 'object') throw new Error(`format=${name} 配置非法`);
  const kind = spec.kind ?? 'regex';
  const ts = { prefix: true, offset: 0, length: 19, ...(spec.ts ?? {}) };

  if (kind === 'json') {
    const fields = spec.fields ?? {};
    return {
      name,
      kind,
      ts,
      head: spec.head ?? '^[{]',
      fields: {
        ts: asArray(fields.ts ?? ['timestamp', 'time', '@timestamp', 'ts']),
        level: asArray(fields.level ?? ['level', 'severity']),
        logger: asArray(fields.logger ?? ['logger', 'name']),
        msg: asArray(fields.msg ?? ['message', 'msg']),
        trace: asArray(fields.trace ?? ['traceId', 'trace_id', 'requestId']),
      },
    };
  }
  if (kind !== 'regex') throw new Error(`format=${name}: 不支持的 kind=${kind}（regex / json）`);
  if (!spec.pattern) throw new Error(`format=${name}: regex 格式必须提供 pattern`);

  let re;
  try {
    re = new RegExp(spec.pattern);
  } catch (err) {
    throw new Error(`format=${name}: pattern 非法 → ${err.message}`);
  }
  for (const group of ['ts', 'level', 'msg']) {
    if (!re.source.includes(`?<${group}>`)) throw new Error(`format=${name}: pattern 缺少命名分组 (?<${group}>…)`);
  }
  if (ts.prefix && !spec.head) throw new Error(`format=${name}: 需要行首时间过滤时必须提供 head（awk 可用的行首正则）`);

  return {
    name,
    kind,
    re,
    pattern: spec.pattern,
    head: spec.head ?? null,
    ts,
    levelOptional: !!spec.levelOptional,
  };
}

/** 合并内置 + 用户自定义格式，并按"精确格式 → 自定义 → 兜底"确定自动识别顺序。 */
export function buildFormats(custom = {}) {
  const specs = { ...BUILTIN_FORMATS, ...custom };
  const formats = {};
  for (const [name, spec] of Object.entries(specs)) formats[name] = compileFormat(name, spec);

  const primary = ['spring', 'star-mvc', 'star-id-first', 'json'];
  const order = [
    ...primary.filter((n) => formats[n]),
    ...Object.keys(formats).filter((n) => !BUILTIN_ORDER.includes(n)),
    ...[...BUILTIN_ORDER].filter((n) => FALLBACK_FORMATS.has(n) && formats[n]),
  ];
  return { formats, formatOrder: order };
}

export function checkFormatName(formats, name, where = 'format') {
  if (!name) return null;
  if (!formats[name]) {
    throw new Error(`${where} 引用了未知格式: ${name}（可用: ${Object.keys(formats).join(', ')}）`);
  }
  return name;
}

/**
 * 生成远端 awk 用的条目首行判定：
 * - 显式指定格式：只有该格式的 head；json 这类无行首时间的格式返回 null（不做远端时间门）
 * - 自动识别：合并所有 regex 格式的 head（JSON 行不会被误判，保持 keep=1 放行）
 */
export function buildHeadPattern(cfg, formatName) {
  if (formatName) {
    const f = cfg.formats[formatName];
    if (!f || f.kind === 'json' || !f.ts.prefix || !f.head) {
      return { headPattern: null, ts: f?.ts ?? { offset: 0, length: 19 } };
    }
    const head = f.head.replace(/^\^/, '');
    return { headPattern: `^${head}`, ts: f.ts };
  }

  const heads = new Set();
  let ts = { offset: 0, length: 19 };
  for (const name of cfg.formatOrder) {
    const f = cfg.formats[name];
    if (!f || f.kind === 'json' || !f.ts?.prefix || !f.head) continue;
    heads.add(f.head.replace(/^\^/, ''));
    ts = f.ts;
  }
  if (!heads.size) return { headPattern: null, ts };
  // awk 是 POSIX ERE：用捕获分组，不能用 (?:…)
  const headPattern = heads.size === 1 ? `^${[...heads][0]}` : `^(${[...heads].join('|')})`;
  return { headPattern, ts };
}
