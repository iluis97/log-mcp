import { scan } from './pipeline.mjs';
import { buildEntries, LEVEL_NAMES } from './parse.mjs';
import { allScope, getSource, scopeConfig } from './config.mjs';
import { getHit } from './hits.mjs';
import { buildAdhocSource, discoverHost, listSourceFiles, probeSource, readSegment, readContainerWindow } from './sources.mjs';
import { budget, redact, renderContext, renderEnvConfirmation, renderEnvOverview, renderInvestigation, renderSearch, renderSources, renderSummarize, renderTrace, allocHit } from './format.mjs';
import { renderPlaybook } from './playbook.mjs';
import { resolveWindow } from './time.mjs';

const strOrArray = { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] };

const hostProps = {
  host: { type: 'string', description: '任意 Linux 服务器地址：与 user 一起使用可临时连接，无需写配置' },
  user: { type: 'string', description: 'SSH 用户名（配合 host 使用）' },
  port: { type: 'number', description: 'SSH 端口，默认 22' },
  keyFile: { type: 'string', description: '私钥路径，默认复用 ssh-agent / ~/.ssh' },
};

const filterProps = {
  ...hostProps,
  env: { type: 'string', description: '环境标签（日志数据源）。所有标签同时有效；配置里有多个标签时必须传，不传会返回候选列表让你先确认' },
  service: { ...strOrArray, description: '配置中的服务名（自动映射到本标签唯一的源 + 容器/日志路径）' },
  source: { ...strOrArray, description: '日志源名称（每个标签只有一个源，一般不用传；不填即用生效标签那个）' },
  glob: { type: 'string', description: '日志文件 glob，可覆盖服务/源的默认值' },
  container: { ...strOrArray, description: 'docker 源上的容器名（如 "b-detect"）；需 docker 类型源' },
  format: { type: 'string', description: '日志格式档案名（默认自动识别）：spring / star-mvc / json / loose，或配置里自定义的名字' },
  last: { type: 'string', description: '相对时间窗，如 "15m" / "2h" / "7d"（优先于 from/to）' },
  from: { type: 'string', description: '起始时间，本地时区，如 "2026-08-13 10:00:00"' },
  to: { type: 'string', description: '结束时间，本地时区' },
  q: { type: 'array', items: { type: 'string' }, description: '关键字（任一命中即可，忽略大小写；会下推到远端 grep）' },
  regex: { type: 'string', description: '正则过滤（下推到远端 grep -E）' },
  exclude: { type: 'string', description: '排除正则（本地条目级）' },
  level: { type: 'string', enum: LEVEL_NAMES, description: '最低级别，如 WARN 表示 WARN/ERROR' },
  maxLines: { type: 'number', description: '最多返回条数，默认 200（上限 2000）' },
  tailBytes: { type: 'number', description: '每个文件只扫描末尾 N 字节，默认 64MB' },
  files: { type: 'number', description: '最多扫描的文件数，默认 8' },
  order: { type: 'string', enum: ['asc', 'desc'], description: 'asc=最早优先；desc=最近优先（默认）' },
  tokenBudget: { type: 'number', description: '输出 token 预算，默认 4000' },
};

function finish(text, cfg, args) {
  const { text: cut } = budget(text, args.tokenBudget ?? cfg.defaults.tokenBudget);
  return redact(cut, cfg);
}

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/** 空数组等同未传，避免“扫全部源”被误判为“扫 0 个源”。 */
function optional(v) {
  return v == null || (Array.isArray(v) && v.length === 0) ? undefined : v;
}

async function listSources(cfg, args) {
  // 不写配置直接连一台机器：host + user
  if (args.host) {
    const source = buildAdhocSource(cfg, args);
    const discovery = args.probe === false ? null : await discoverHost(source);
    return finish(renderSources(cfg, { sources: [source], services: {}, discovery }), cfg, args);
  }

  // 多个标签又没指定：先给全景，让模型去确认数据源，不自己挑
  if (cfg.envs.length > 1 && !args.env && !cfg.env) return finish(renderEnvOverview(cfg), cfg, args);

  const scoped = cfg.envs.length ? scopeConfig(cfg, args.env) : cfg;
  const sources = args.source ? [getSource(scoped, args.source)] : scoped.sources;
  const probeResults = {};
  let discovery = null;
  if (args.probe) {
    for (const s of sources) {
      if (s.type === 'file') {
        probeResults[s.name] = await probeSource(s);
        continue;
      }
      try {
        discovery = await discoverHost(s);
      } catch (err) {
        probeResults[s.name] = { ok: false, detail: err.message };
      }
    }
  }
  let files;
  if (args.source && args.files !== false) {
    files = await listSourceFiles(scoped, sources[0].name, args.glob);
  }
  return finish(renderSources(scoped, { sources, services: scoped.services, files, probeResults, discovery }), cfg, args);
}

async function search(cfg, args) {
  const result = await scan(cfg, { ...args, service: optional(args.service), source: optional(args.source) });
  return finish(renderSearch(result, cfg), cfg, args);
}

async function summarize(cfg, args) {
  const groupBy = asArray(args.groupBy);
  if (!groupBy.length) groupBy.push('level');
  const topN = Math.min(Number(args.topN ?? 10) || 10, 50);
  const params = { ...args, maxLines: Math.min(Number(args.maxLines ?? 20000) || 20000, 50_000) };
  const result = await scan(cfg, params, { maxLinesCap: params.maxLines });
  const { entries, stats, window } = result;

  const valueOf = (e, key) => {
    switch (key) {
      case 'level': return e.level;
      case 'logger': return e.logger || '(未知)';
      case 'template': return e.template;
      case 'traceId': return e.traceId ?? '(无)';
      case 'exception': return e.exception ?? '(无异常类)';
      case 'service': return e.service ?? '(未知)';
      default: return String(key);
    }
  };

  let noise = 0;
  const groups = new Map();
  for (const e of entries) {
    if (e.noise && !args.includeNoise) {
      noise += 1;
      continue;
    }
    const key = groupBy.map((k) => valueOf(e, k)).join(' | ');
    let g = groups.get(key);
    if (!g) {
      g = { label: key, count: 0, first: e.rawTs, last: e.rawTs, sample: e.msg, entry: e };
      groups.set(key, g);
    }
    g.count += 1;
    if (e.tsKey < g.first) g.first = e.tsKey;
    if (e.tsKey > g.last) g.last = e.tsKey;
    if (e.level === 'ERROR' || e.level === 'FATAL') g.entry = e;
  }

  const total = entries.length - noise;
  const sorted = [...groups.values()].sort((a, b) => b.count - a.count).slice(0, topN).map((g) => ({
    label: g.label,
    count: g.count,
    first: g.first.slice(11),
    last: g.last.slice(11),
    sample: g.sample,
    id: allocHit(g.entry, cfg),
  }));

  let bucketRows;
  if (args.bucket) {
    const bucketKey = (tsKey) => {
      if (args.bucket === '1h') return tsKey.slice(0, 13);
      if (args.bucket === '5m') {
        const minute = Math.floor(Number(tsKey.slice(14, 16)) / 5) * 5;
        return `${tsKey.slice(0, 14)}${String(minute).padStart(2, '0')}`;
      }
      return tsKey.slice(0, 16);
    };
    const map = new Map();
    for (const e of entries) {
      if (e.noise && !args.includeNoise) continue;
      const bucket = bucketKey(e.tsKey);
      map.set(bucket, (map.get(bucket) ?? 0) + 1);
    }
    bucketRows = [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([bucket, count]) => ({ bucket, count }));
  }

  return finish(renderSummarize({ groups: sorted, stats, window, bucketRows, total, noise, groupBy, topN }, cfg), cfg, args);
}

async function context(cfg, args) {
  const hit = getHit(args.hit);
  if (!hit) throw new Error('hit id 无效或已过期，请先执行 log_search 获取最新 id');
  const clamped = (v, min, max) => Math.min(max, Math.max(min, Number(v) || 0));
  let lines;
  let meta;
  if (hit.targetType === 'docker') {
    lines = await readContainerWindow(cfg, hit, {
      beforeSec: clamped(args.beforeSeconds ?? 120, 1, 1800),
      afterSec: clamped(args.afterSeconds ?? 180, 1, 3600),
    });
    meta = { sourceName: hit.sourceName, file: hit.container, gz: false, service: hit.service, container: hit.container, targetType: 'docker' };
  } else {
    if (hit.gz) throw new Error('该命中来自 .gz 归档文件，不支持取上下文；请直接查看该条或改用压缩前的日志');
    lines = await readSegment(cfg, hit, { beforeBytes: Number(args.beforeBytes ?? 65536), maxBytes: 131072 });
    meta = { sourceName: hit.sourceName, file: hit.file, gz: false, service: hit.service, targetType: hit.targetType ?? 'file' };
  }

  const entries = [];
  for await (const e of buildEntries(lines, cfg, meta)) entries.push(e);
  if (!entries.length) {
    return finish(`未能解析上下文（${hit.container ?? hit.file} @${hit.rawTs ?? hit.offset}）`, cfg, args);
  }

  let targetIndex;
  if (hit.targetType === 'docker') {
    // 容器日志按时间重取，可能有秒级空缺：取时间最接近的那条
    const toSec = (key) => {
      const [d, t] = String(key ?? '').split(' ');
      return d && t ? Date.parse(`${d}T${t}`) / 1000 : NaN;
    };
    const hitSec = toSec(hit.tsKey);
    let best = Infinity;
    targetIndex = 0;
    entries.forEach((e, i) => {
      const diff = Math.abs(toSec(e.tsKey) - hitSec);
      if (Number.isFinite(diff) && diff < best) {
        best = diff;
        targetIndex = i;
      }
    });
  } else {
    targetIndex = entries.findIndex((e, i) => e.offset <= hit.offset && (i === entries.length - 1 || entries[i + 1].offset > hit.offset));
    if (targetIndex < 0) targetIndex = 0;
  }

  const before = Math.min(Number(args.before ?? 2) || 0, 20);
  const after = Math.min(Number(args.after ?? 8) || 0, 50);
  const slice = entries.slice(Math.max(0, targetIndex - before), targetIndex + after + 1);
  const adjusted = slice.findIndex((e) => e === entries[targetIndex]);

  return finish(
    renderContext({ entries: slice, targetIndex: adjusted, refInfo: { file: hit.file, container: hit.container, sourceName: hit.sourceName, rawTs: hit.rawTs } }, cfg, cfg.defaults.stackLines),
    cfg,
    args,
  );
}

async function trace(cfg, args) {
  const traceId = String(args.traceId ?? '').trim();
  if (!traceId) throw new Error('缺少 traceId');
  const window = resolveWindow(cfg, args);
  const result = await scan(
    cfg,
    {
      ...args,
      service: optional(args.service),
      source: optional(args.source),
      traces: [traceId],
      level: undefined,
      q: undefined,
      regex: undefined,
      order: 'asc',
      maxLines: Math.min(Number(args.maxLines ?? 300) || 300, 1000),
    },
    { maxLinesCap: 1000 },
  );
  return finish(renderTrace({ traceId, entries: result.entries, window, stats: result.stats }, cfg), cfg, args);
}

export const toolDefs = [
  {
    name: 'log_confirm_env',
    description:
      '【必须先做的一步】确认本次要查哪个环境标签（数据源）。配置里有多套标签时：先问用户看哪个环境/哪台机器，拿到答复后再调用本工具；evidence 填用户原话或依据。调用后本次会话锁定在该标签上，其它标签一律拒绝，想换环境必须重新确认。不要自己猜、不要逐个标签试。只读。',
    inputSchema: {
      type: 'object',
      properties: {
        env: { type: 'string', description: '标签名（必须在配置的 envs 里）' },
        evidence: { type: 'string', description: '依据：用户怎么说/哪里看出来的，例如“用户说：看 106 那台测试机”。不能为空' },
      },
      required: ['env', 'evidence'],
    },
  },
  {
    name: 'log_investigate',
    description:
      '多服务首轮排查（推荐入口）：一次给全部服务 + 同一时间窗 + 同一组关键词，自动定位日志、按各自格式自适应、检索并聚类，返回"每个服务的命中概况 + 关键日志证据（hit id）+ 异常模式 + 下一步建议"。配合技能 log-troubleshooting 使用。【要求】多套环境标签时必须先 log_confirm_env 确定数据源，带 env。只读。',
    inputSchema: {
      type: 'object',
      properties: {
        env: filterProps.env,
        service: { ...strOrArray, description: '服务名数组；未配置且给了 host 时按容器名处理' },
        services: { type: 'array', items: { type: 'string' }, description: 'service 的别名' },
        targets: {
          type: 'array',
          description: '显式目标列表，可混合不同服务器/容器/文件',
          items: {
            type: 'object',
            properties: {
              service: { type: 'string' },
              host: { type: 'string' },
              user: { type: 'string' },
              container: { type: 'string' },
              glob: { type: 'string' },
              format: { type: 'string' },
            },
          },
        },
        keywords: { type: 'array', items: { type: 'string' }, description: '关键词（任一命中），会下推到远端 grep；不给则取该时间窗全部日志' },
        ...hostProps,
        last: filterProps.last,
        from: filterProps.from,
        to: filterProps.to,
        level: filterProps.level,
        regex: filterProps.regex,
        exclude: filterProps.exclude,
        maxLines: { type: 'number', description: '每个服务最多参与分析的条数，默认 300' },
        maxEvidence: { type: 'number', description: '每个服务最多给几条证据，默认 4' },
        detect: { type: 'boolean', description: '是否做格式自适应，默认开；false 则只用显式/自动识别' },
      },
    },
  },
  {
    name: 'log_playbook',
    description: '返回内置排查手册（步骤、关键词库、时间窗策略、证据规则）。技能 log-troubleshooting 与本工具共享同一份内容，不确定下一步查什么时先读它。只读。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'log_sources',
    description:
      '列出可用日志源（本地文件 / SSH 远端）、服务映射与匹配到的日志文件，可选探测连通性。多标签时会先给全景，用来和用户确定「看哪个数据源」。只读。排查第一步先调用它。',
    inputSchema: {
      type: 'object',
      properties: {
        env: { ...filterProps.env, description: '环境标签（日志数据源）。不传时：只有一个标签就直接用，有多个就返回所有标签的全景让你先确认' },
        ...hostProps,
        container: { type: 'string', description: '指定容器名（配合 host 时直接按 docker 源处理）' },
        source: { type: 'string', description: '只看某个已配置的源' },
        glob: { type: 'string', description: '列出文件时使用的 glob' },
        probe: { type: 'boolean', description: '发现主机信息：OS / 容器 / 运行中服务 / 近 3 天活跃日志（SSH 会真实连接一次）' },
        files: { type: 'boolean', description: '设为 false 可跳过文件列表' },
      },
    },
  },
  {
    name: 'log_search',
    description:
      '按时间窗 / 级别 / 关键字 / 正则 / traceId 检索 Spring Boot 文本日志，返回带短 id 的命中行（含堆栈行数）。过滤会下推到远端 grep，只回传命中内容。用 log_context 取上下文，用 log_summarize 做聚类。【要求】多套环境标签时必须先 log_confirm_env 确定数据源，带 env，否则会被拒绝。只读。',
    inputSchema: { type: 'object', properties: { ...filterProps } },
  },
  {
    name: 'log_summarize',
    description:
      '对日志做聚合统计而不是罗列：按 level / logger / template（模板指纹）/ exception / traceId / service 分组计数，可加时间分桶。用于判断“哪类错误最多、增长率、什么时候开始”。只读。',
    inputSchema: {
      type: 'object',
      properties: {
        ...filterProps,
        groupBy: { type: 'array', items: { type: 'string', enum: ['level', 'logger', 'template', 'exception', 'traceId', 'service'] }, description: '分组维度，默认 ["level"]' },
        topN: { type: 'number', description: '返回前 N 组，默认 10' },
        bucket: { type: 'string', enum: ['1m', '5m', '1h'], description: '时间分桶粒度（可选）' },
        includeNoise: { type: 'boolean', description: '是否把 noisePatterns 命中的噪音行计入统计' },
      },
    },
  },
  {
    name: 'log_context',
    description: '根据 log_search / log_trace 返回的短 id，回取该条日志前后的完整条目（含多行堆栈，超长自动折叠）。只读。',
    inputSchema: {
      type: 'object',
      properties: {
        hit: { type: 'string', description: '命中短 id，如 "h3f"' },
        before: { type: 'number', description: '向前取几条条目，默认 2（上限 20）' },
        after: { type: 'number', description: '向后取几条条目，默认 8（上限 50）' },
        beforeSeconds: { type: 'number', description: 'docker 源：向前取多少秒日志，默认 120' },
        afterSeconds: { type: 'number', description: 'docker 源：向后取多少秒日志，默认 180' },
      },
      required: ['hit'],
    },
  },
  {
    name: 'log_trace',
    description: '按 traceId 跨服务、跨文件还原一次请求的时间线，带相对耗时（+ms）与 >1s 的时间空洞标记。适合排查慢请求 / 跨服务失败。只读。',
    inputSchema: {
      type: 'object',
      properties: {
        env: filterProps.env,
        traceId: { type: 'string', description: '链路 id' },
        service: filterProps.service,
        source: filterProps.source,
        glob: filterProps.glob,
        container: filterProps.container,
        format: filterProps.format,
        host: filterProps.host,
        user: filterProps.user,
        port: filterProps.port,
        keyFile: filterProps.keyFile,
        last: filterProps.last,
        from: filterProps.from,
        to: filterProps.to,
        maxLines: { type: 'number', description: '最多返回条目数，默认 300' },
      },
      required: ['traceId'],
    },
  },
];

function pick(args, keys) {
  const out = {};
  for (const key of keys) if (args[key] !== undefined) out[key] = args[key];
  return out;
}

/** 多服务首轮排查：定位 → 自适应格式 → 关键词检索 → 聚类 → 证据。 */
async function investigate(cfg, args) {
  const keywords = asArray(args.keywords ?? args.q).filter(Boolean);
  const services = asArray(args.service ?? args.services).filter(Boolean);
  const explicit = asArray(args.targets).filter(Boolean);
  const maxEvidence = Math.min(Number(args.maxEvidence ?? 4) || 4, 10);
  const common = pick(args, ['last', 'from', 'to', 'level', 'regex', 'exclude', 'files', 'glob', 'format', 'host', 'user', 'port', 'keyFile', 'detect']);
  const maxLines = Math.min(Number(args.maxLines ?? 300) || 300, 2000);

  const jobs = [];
  if (explicit.length) {
    for (const t of explicit) jobs.push({ ...common, ...t, q: keywords, maxLines, order: 'asc' });
  } else if (services.length) {
    const conn = args.host ? { host: args.host, user: args.user, port: args.port, keyFile: args.keyFile } : null;
    for (const name of services) {
      const svc = cfg.services[name];
      let job;
      if (!svc) {
        // 未配置：给了 host 就把服务名当容器名，否则交给配置解析（会报未知服务）
        job = conn ? { ...conn, container: name } : { service: name };
      } else if (!conn) {
        job = { service: name };
      } else {
        // 用户显式指定了服务器：沿用服务映射的容器/文件位置，但连到用户给的机器
        job = svc.container ? { ...conn, container: svc.container } : { ...conn, glob: svc.glob };
      }
      jobs.push({ ...common, ...job, q: keywords, maxLines, order: 'asc' });
    }
  } else {
    jobs.push({ ...common, q: keywords, maxLines, order: 'asc' });
  }

  const settled = await Promise.allSettled(jobs.map((params) => scan(cfg, params, { maxLinesCap: 2000 })));
  const results = settled.map((res, i) => {
    const job = jobs[i];
    const label = job.service ?? job.container ?? job.glob ?? job.host ?? 'target';
    if (res.status === 'rejected') {
      return { label, entries: [], stats: {}, error: res.reason?.message ?? String(res.reason) };
    }
    const { entries: rawEntries, stats, window } = res.value;
    const noise = rawEntries.filter((e) => e.noise).length;
    const entries = args.includeNoise ? rawEntries : rawEntries.filter((e) => !e.noise);
    const detected = stats.detected ?? [];
    const adapted =
      detected.slice().sort((a, b) => (b.tracePattern ? 1 : 0) - (a.tracePattern ? 1 : 0) || (b.formatRatio ?? 0) - (a.formatRatio ?? 0) || (b.samples ?? 0) - (a.samples ?? 0))[0] ??
      null;
    return { label, entries, noise, stats, window, adapted };
  });

  const window = results.find((r) => r.window)?.window ?? scanWindowFallback(cfg, args);
  return finish(renderInvestigation(cfg, { keywords, window, results, maxEvidence }), cfg, args);
}

function scanWindowFallback(cfg, args) {
  return resolveWindow(cfg, args);
}

/** 用户确认数据源（唯一能解除 pending / 切标签的入口）。 */
async function confirmEnv(cfg, args, guard) {
  const env = String(args.env ?? '').trim();
  const evidence = String(args.evidence ?? '').trim();
  if (cfg.envs.length <= 1) {
    const only = cfg.envs[0] ?? '(未命名)';
    return finish(`只有一个标签 ${only}，不需要确认，直接查即可：log_search(last="30m", q=["Exception"])。`, cfg, args);
  }
  if (!cfg.envs.includes(env)) throw new Error(`没有 ${env} 这个标签（可用: ${cfg.envs.join(' | ')}）`);
  if (evidence.length < 2) {
    throw new Error('必须填写 evidence：用户是怎么说的（例如“用户说：看 106 那台”）。先去问用户，拿到答复再调用本工具。');
  }
  const entry = cfg.envMap[env];
  const state = guard ? guard.confirm(env, evidence) : null;
  process.stderr.write(`[logmcp][audit] 确认数据源 env=${env} evidence="${evidence}"
`);
  const scoped = scopeConfig(cfg, env);
  return finish(renderEnvConfirmation(scoped, entry, state), cfg, args);
}

async function playbook(cfg, args) {
  return finish(renderPlaybook(), cfg, args);
}

const handlers = {
  log_confirm_env: confirmEnv,
  log_playbook: playbook,
  log_investigate: investigate,
  log_sources: listSources,
  log_search: search,
  log_summarize: summarize,
  log_context: context,
  log_trace: trace,
};

/**
 * 需要「已确定数据源」才能跑的工具：都会被会话锁检查。
 * 不属于这里的：
 *  - log_playbook（不碰日志）
 *  - log_sources（用来给全景，本身不下结论）
 *  - log_context（跟着 hit id 走，已经定位过）
 *  - log_confirm_env（就是确认入口）
 */
const GUARDED = new Set(['log_investigate', 'log_search', 'log_summarize', 'log_trace']);

export async function callTool(cfg, name, args = {}, guard = null) {
  const handler = handlers[name];
  if (!handler) throw new Error(`未知工具: ${name}`);
  if (name === 'log_playbook' || name === 'log_sources') return handler(cfg, args ?? {});
  if (name === 'log_confirm_env') return handler(cfg, args ?? {}, guard);

  if (GUARDED.has(name) && guard) {
    const verdict = guard.check(args?.env, cfg.envs);
    if (!verdict.ok) {
      process.stderr.write(`[logmcp][guard] 拒绝 ${name}（${verdict.kind}，第 ${verdict.refusals} 次）
`);
      throw new Error(verdict.message);
    }
    const scoped = scopeConfig(cfg, verdict.env);
    const result = await handler(scoped, args ?? {});
    // 多标签且还没走过确认流程时，提醒模型：本次会话已锁在这个数据源上
    const note =
      cfg.envs.length > 1 && !guard.state.confirmed
        ? `

（本次会话数据源已锁定为 ${scoped.env}；要换环境先问用户，再 log_confirm_env）`
        : '';
    return note ? `${result}${note}` : result;
  }

  if (name === 'log_context') {
    return handler(cfg.envs.length ? (args?.env ? scopeConfig(cfg, args.env) : allScope(cfg)) : cfg, args ?? {});
  }
  return handler(scopeConfig(cfg, args?.env), args ?? {});
}
