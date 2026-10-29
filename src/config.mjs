import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePattern } from './regex.mjs';
import { buildFormats, checkFormatName } from './formats.mjs';

const PKG_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** 默认脱敏规则：口令、令牌、手机号、身份证。 */
const BUILTIN_REDACT = [
  '(?i)\\b(password|passwd|pwd)\\s*[=:]\\s*\\S+',
  '(?i)\\b(authorization|access[_-]?token|refresh[_-]?token|secret|api[_-]?key)\\s*[=:]\\s*\\S+',
  '\\b1[3-9]\\d{9}\\b',
  '\\b\\d{17}[\\dXx]\\b',
];

/** 默认 traceId 提取规则（Spring Boot + MDC 常见写法）。 */
const DEFAULT_TRACE_PATTERNS = [
  '(?:traceId|trace_id|traceid)["\']?\\s*[=:]\\s*["\']?([0-9a-zA-Z_-]{8,64})',
  '\\[([0-9a-f]{16,32}(?:-[0-9a-f]{4,16})*)\\]',
];

const DEFAULTS = {
  user: undefined,
  maxLines: 200,
  maxLinesCap: 2000,
  tokenBudget: 4000,
  tailBytes: 64 * 1024 * 1024,
  files: 8,
  stackLines: 12,
  last: '15m',
  timeoutMs: 25000,
};

export function defaultSshPath() {
  if (process.platform !== 'win32') return 'ssh';
  const bundled = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe';
  return fs.existsSync(bundled) ? bundled : 'ssh';
}

export function expandHome(p) {
  if (!p) return p;
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

export function resolveConfigPath(argv = process.argv.slice(2), { create = false } = {}) {
  const i = argv.indexOf('--config');
  const explicit = i >= 0 ? argv[i + 1] : undefined;
  const candidates = [process.env.LOGMCP_CONFIG, explicit, path.join(process.cwd(), 'logmcp.config.json'), path.join(PKG_DIR, 'logmcp.config.json')].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return path.resolve(c);
  // 配置页允许从零开始：没有现成文件就落在 --config/LOGMCP_CONFIG/包目录
  if (create) return path.resolve(explicit ?? process.env.LOGMCP_CONFIG ?? path.join(PKG_DIR, 'logmcp.config.json'));
  throw new Error(`找不到配置文件，请用 --config <file> 或环境变量 LOGMCP_CONFIG 指定。已尝试: ${candidates.join(' | ')}`);
}

export function normalizeSource(raw, index, formats) {
  if (!raw || typeof raw !== 'object') throw new Error(`sources[${index}] 不是对象`);
  const name = raw.name ?? `source-${index}`;
  const format = checkFormatName(formats, raw.format, `source=${name}`);
  const type = raw.type ?? (raw.host ? 'ssh' : 'file');
  const allowPaths = raw.allowPaths ?? (type === 'file' ? ['**'] : ['/**']);

  if (type === 'file') {
    const roots = (raw.roots ?? []).map((p) => path.resolve(expandHome(p)));
    if (!roots.length) throw new Error(`source=${name}: file 源必须配置 roots`);
    return { name, type, roots, allowPaths, defaultGlob: raw.glob ?? '**/*.log*', format, tailBytes: raw.tailBytes };
  }
  if (type === 'ssh') {
    if (!raw.host || !raw.user) throw new Error(`source=${name}: ssh 源必须配置 host 和 user`);
    if (!/^[A-Za-z0-9_.:-]+$/.test(String(raw.host))) throw new Error(`source=${name}: host 非法`);
    if (!/^[A-Za-z0-9_.-]+$/.test(String(raw.user))) throw new Error(`source=${name}: user 非法`);
    const port = Number(raw.port ?? 22);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`source=${name}: port 非法`);
    return {
      name,
      type,
      host: String(raw.host),
      user: String(raw.user),
      port,
      keyFile: raw.keyFile ? expandHome(raw.keyFile) : undefined,
      sshPath: raw.sshPath ?? defaultSshPath(),
      allowPaths,
      defaultGlob: raw.glob ?? '/**/*.log*',
      format,
      tailBytes: raw.tailBytes,
    };
  }
  if (type === 'docker') {
    if (!raw.host || !raw.user) throw new Error(`source=${name}: docker 源必须配置 host 和 user（通过 SSH 执行 docker 命令）`);
    if (!/^[A-Za-z0-9_.:-]+$/.test(String(raw.host))) throw new Error(`source=${name}: host 非法`);
    if (!/^[A-Za-z0-9_.-]+$/.test(String(raw.user))) throw new Error(`source=${name}: user 非法`);
    const port = Number(raw.port ?? 22);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`source=${name}: port 非法`);
    const dockerPath = raw.dockerPath ?? 'docker';
    if (!/^[A-Za-z0-9_./-]+$/.test(dockerPath)) throw new Error(`source=${name}: dockerPath 非法`);
    const containers = raw.containers ?? [];
    for (const c of containers) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(c)) throw new Error(`source=${name}: 容器名非法 ${c}`);
    }
    return {
      name,
      type,
      host: String(raw.host),
      user: String(raw.user),
      port,
      keyFile: raw.keyFile ? expandHome(raw.keyFile) : undefined,
      sshPath: raw.sshPath ?? defaultSshPath(),
      dockerPath,
      containers,
      allowPaths: ['/**'],
      defaultGlob: null,
      format,
      tailBytes: raw.tailBytes,
    };
  }
  throw new Error(`source=${name}: 不支持的类型 ${type}（仅支持 file / ssh / docker）`);
}

/** 错误信息里已经带了 `source=x:` / `service=y:` 前缀时去掉，避免 scope 与文案重复。 */
function bare(message, re) {
  return String(message).replace(re, '');
}

/**
 * 归一化一个「环境标签」：**一个标签只有一个源**，下面可以挂多个服务。
 * source 允许写成对象；也兼容旧格式的 sources 数组（只允许 1 个）。
 * 同时收集全部错误而不是遇错即停，供配置页逐条展示；strict=true 时第一个错误直接抛出。
 */
export function normalizeEnv(rawEnv, formats, { strict = false, env = null } = {}) {
  const where = `环境标签${env ? ` ${env}` : ''}`;
  if (!rawEnv || typeof rawEnv !== 'object' || Array.isArray(rawEnv)) throw new Error(`${where} 的内容必须是对象`);
  if (rawEnv.sources != null && !Array.isArray(rawEnv.sources)) throw new Error(`${where}: sources 必须是数组`);
  if (rawEnv.source != null && (typeof rawEnv.source !== 'object' || Array.isArray(rawEnv.source))) {
    throw new Error(`${where}: source 必须是对象`);
  }

  const errors = [];
  const warnings = [];
  const sources = [];

  // 一个标签一个源：source 对象优先，其次兼容 sources 数组
  const legacyList = rawEnv.sources ?? [];
  const rawSource = rawEnv.source ?? (legacyList.length ? legacyList[0] : null);
  if (legacyList.length > 1) {
    errors.push({
      scope: 'source',
      message: `一个标签只能有一个日志源，当前有 ${legacyList.length} 个（${legacyList.map((s) => s?.name ?? '?').join(', ')}）；请拆成多个标签`,
    });
  }
  if (!rawSource) {
    errors.push({ scope: 'source', message: '未配置日志源（每个标签必须有且只有一个 source）' });
  } else {
    try {
      sources.push(normalizeSource({ name: env ?? undefined, ...rawSource }, 0, formats));
    } catch (err) {
      errors.push({ scope: rawSource?.name ? `source:${rawSource.name}` : 'source', message: bare(err.message, /^source=[^:]+:\s*/) });
    }
  }
  const source = sources[0] ?? null;

  const services = {};
  for (const [name, def] of Object.entries(rawEnv.services ?? {})) {
    try {
      if (!def || typeof def !== 'object' || Array.isArray(def)) throw new Error('定义必须是对象');
      if (!source) {
        // 源本身已经报错了就不再重复；否则明确告诉用户缺源
        if (!errors.some((e) => String(e.scope).startsWith('source'))) throw new Error('该标签还没有可用的源');
        continue;
      }
      // 一个标签只有一个源，service.source 不再需要；配了也忽略，但要提醒迁移
      if (def.source && def.source !== source.name) {
        warnings.push({ scope: `service:${name}`, message: `source=${def.source} 已忽略，本标签唯一的源是 ${source.name}` });
      }
      if (!def.glob && !def.container) {
        warnings.push({
          scope: `service:${name}`,
          message:
            source.type === 'docker'
              ? 'docker 源建议配置 container（否则用运行中全部容器）'
              : '未配置 glob，将使用源的默认 glob',
        });
      }
      if (def.container && source.type !== 'docker') {
        warnings.push({ scope: `service:${name}`, message: `source 是 ${source.type} 类型，container 会被忽略` });
      }
      services[name] = {
        name,
        source: source.name,
        glob: def.glob ?? null,
        container: def.container ?? null,
        format: checkFormatName(formats, def.format, `service=${name}`),
      };
    } catch (err) {
      errors.push({ scope: `service:${name}`, message: bare(err.message, /^service=[^:]+:\s*/) });
    }
  }

  if (strict && errors.length) {
    const first = errors[0];
    throw new Error(first.scope ? `${first.scope}: ${first.message}` : first.message);
  }
  return { sources, services, errors, warnings };
}

/** 校验（不写盘），给配置页做即时反馈：返回逐条错误/告警 + 归一化预览。 */
export function validateEnv(rawEnv, { formats = {}, env = null } = {}) {
  try {
    const built = buildFormats(formats);
    const result = normalizeEnv(rawEnv, built.formats, { env });
    return { ok: result.errors.length === 0, ...result };
  } catch (err) {
    return { ok: false, errors: [{ scope: 'env', message: err.message }], warnings: [], sources: [], services: {} };
  }
}

/** 选择一个标签用：显式 env > --env/LOGMCP_ENV 默认 > 只有一个标签时就是它；多个标签未指定就报错。 */
function pickEnvName(envNames, requested, fallback) {
  if (!envNames.length) {
    if (requested) throw new Error(`配置里没有任何环境标签，无法使用 env=${requested}`);
    return null;
  }
  const wanted = requested ?? fallback;
  if (!wanted) return envNames.length === 1 ? envNames[0] : null;
  if (!envNames.includes(wanted)) throw new Error(`未知的环境标签: ${wanted}（可用: ${envNames.join(', ')}）`);
  return wanted;
}

/** 一个标签的摘要，用于「请先确定数据源」的提示。 */
function describeForPrompt(name, env) {
  const s = env.sources[0];
  const where = !s ? '（源配置有误）' : s.type === 'docker' || s.type === 'ssh' ? `${s.type} ${s.user}@${s.host}` : `file ${s.roots.join(',')}`;
  const svc = Object.keys(env.services);
  return `${name}（${where}，${svc.length} 个服务${svc.length ? `: ${svc.slice(0, 6).join(', ')}${svc.length > 6 ? '…' : ''}` : ''}）`;
}

/**
 * 所有标签同时有效。工具必须明确用哪个标签：调用时传 env，或配置里只有一个标签。
 * 否则抛出带候选列表的错误，让模型先去问用户「看哪个数据源」。
 */
export function scopeConfig(cfg, envName) {
  if (!cfg.envs.length) return { ...cfg, env: null };
  const name = pickEnvName(cfg.envs, envName, cfg.env ?? null);
  if (!name) {
    const list = cfg.envs.map((n) => describeForPrompt(n, cfg.envMap[n])).join('\n  - ');
    throw new Error(
      [
        '还没有确定日志数据源，不能直接查。请先确认这次要看哪个标签（env），再带上 env 参数重试：',
        `  - ${list}`,
        cfg.envs.length > 1 ? `可选 env: ${cfg.envs.join(' | ')}` : '',
        '如果用户已经说了环境（如“dev-123”“测试环境”），直接用它；不确定就问一句再查。',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
  const entry = cfg.envMap[name];
  if (!entry) throw new Error(`未知的环境标签: ${name}（可用: ${cfg.envs.join(', ')}）`);
  if (entry.errors?.length) {
    throw new Error(`标签 ${name} 的配置有误，先修配置再查：\n  - ${entry.errors.map((e) => `${e.scope}: ${e.message}`).join('\n  - ')}`);
  }
  if (!entry.sources.length) throw new Error(`标签 ${name} 没有可用的日志源（到配置页补一个）`);
  return { ...cfg, env: name, sources: entry.sources, services: entry.services };
}

/** 不限标签的视图：所有标签的源/服务合并，只用于跟着 hit id 回取上下文这类已经定位过的场景。 */
export function allScope(cfg) {
  const sources = cfg.envs.flatMap((n) => cfg.envMap[n]?.sources ?? []);
  const services = Object.assign({}, ...cfg.envs.map((n) => cfg.envMap[n]?.services ?? {}));
  return { ...cfg, sources, services };
}

export function loadConfig(file, { env } = {}) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { formats, formatOrder } = buildFormats(raw.formats ?? {});

  // 所有标签一起加载，不做「全局生效标签」；env 只是调用时的默认值
  const declared = Object.keys(raw.envs ?? {});
  const legacy = !declared.length;
  const envNames = legacy ? [raw.activeEnv ?? raw.defaultEnv ?? 'default'] : declared;
  const envMap = {};
  const envErrors = [];
  const warnings = [];
  for (const name of envNames) {
    const body = legacy ? raw : raw.envs[name];
    const result = normalizeEnv(body, formats, { env: name });
    envMap[name] = { name, sources: result.sources, services: result.services, errors: result.errors };
    for (const e of result.errors) envErrors.push({ env: name, ...e });
    for (const w of result.warnings) warnings.push({ env: name, ...w });
  }

  const fallback = env ?? process.env.LOGMCP_ENV;
  const resolved = envErrors.length === envNames.length ? null : pickEnvName(envNames, fallback, null);
  const redactPatterns = [...BUILTIN_REDACT, ...(raw.redact?.patterns ?? [])];
  const tracePatterns = raw.traceIdPatterns ?? DEFAULT_TRACE_PATTERNS;
  const noisePatterns = raw.noisePatterns ?? [];
  redactPatterns.forEach((p, i) => validatePattern(p, 'g', `redact.patterns[${i}]`));
  tracePatterns.forEach((p, i) => validatePattern(p, '', `traceIdPatterns[${i}]`));
  noisePatterns.forEach((p, i) => validatePattern(p, 'i', `noisePatterns[${i}]`));
  const active = resolved && !envMap[resolved]?.errors?.length ? envMap[resolved] : null;
  return {
    file: path.resolve(file),
    env: resolved,
    envs: envNames,
    envMap,
    envErrors,
    warnings,
    timezone: raw.timezone ?? 'Asia/Shanghai',
    defaults: { ...DEFAULTS, ...(raw.defaults ?? {}) },
    redact: {
      enabled: raw.redact?.enabled !== false,
      patterns: redactPatterns,
    },
    tracePatterns,
    noisePatterns,
    formats,
    formatOrder,
    services: active?.services ?? {},
    sources: active?.sources ?? [],
  };
}

export function getSource(cfg, name) {
  const s = cfg.sources.find((x) => x.name === name);
  if (!s) throw new Error(`未知的日志源: ${name}（可用: ${cfg.sources.map((x) => x.name).join(', ')}）`);
  return s;
}
