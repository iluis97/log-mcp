import path from 'node:path';
import { recordHit } from './hits.mjs';
import { parseZoned } from './time.mjs';
import { compilePattern } from './regex.mjs';

const MAX_MSG_CHARS = 240;
const redacted = new WeakMap();

function redactPatterns(cfg) {
  let list = redacted.get(cfg);
  if (!list) {
    list = cfg.redact.enabled ? cfg.redact.patterns.map((p) => compilePattern(p, 'g')) : [];
    redacted.set(cfg, list);
  }
  return list;
}

export function redact(text, cfg) {
  let out = text;
  for (const re of redactPatterns(cfg)) out = out.replace(re, '***');
  return out;
}

/** 按 token 预算裁剪，只保留完整行。 */
export function budget(text, tokenBudget) {
  const maxChars = Math.max(800, Math.round(Number(tokenBudget) * 2.5));
  if (text.length <= maxChars) return { text, truncated: false };
  const cut = text.slice(0, maxChars);
  const nl = cut.lastIndexOf('\n');
  return { text: `${nl > 0 ? cut.slice(0, nl) : cut}\n…（输出已按 token 预算截断，请缩小时间窗、加条件或降低 maxLines）`, truncated: true };
}

export function humanBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)}${units[i]}`;
}

function shortFile(file) {
  return path.posix.basename(String(file).replace(/\\/g, '/'));
}

function clip(text, max = MAX_MSG_CHARS) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function allocHit(entry, cfg) {
  return recordHit({
    sourceName: entry.sourceName,
    sourceSnapshot: entry.source ?? null,
    file: entry.file,
    container: entry.container ?? null,
    targetType: entry.targetType ?? 'file',
    offset: entry.offset,
    gz: entry.gz,
    service: entry.service,
    rawTs: entry.rawTs,
    tsKey: entry.tsKey,
    epoch: cfg ? (parseZoned(entry.rawTs, cfg.timezone)?.getTime() ?? null) : null,
  });
}

export { allocHit };

export function entryRow(entry, { cfg, traceWidth = 12 } = {}) {
  const id = allocHit(entry, cfg);
  const trace = entry.traceId ? ` trace=${entry.traceId.slice(0, traceWidth)}` : '';
  const more = entry.lines.length > 1 ? ` (+${entry.lines.length - 1}行)` : '';
  return `[${id}] ${entry.rawTs} ${entry.level.padEnd(5)} ${clip(entry.logger || '-', 40)}${trace} | ${clip(entry.msg)}${more}  @${shortFile(entry.file)}`;
}

export function renderSearch(result, cfg) {
  const { entries, stats, window, order, maxLines, targets } = result;
  const head = [
    `区间 ${window.label}　命中 ${entries.length} 条　扫描 ${stats.files}/${targets} 个目标${stats.bytes ? ` ${humanBytes(stats.bytes)}` : ''}　顺序 ${order}${stats.truncated ? '　⚠ 已截断' : ''}`,
  ];
  if (!entries.length) {
    head.push('没有命中。可尝试：扩大 last/from~to、去掉 level/q 限制、检查 glob 是否匹配到文件（log_sources）。');
    return head.join('\n');
  }
  const rows = entries.map((e) => entryRow(e, { cfg }));
  const traces = [...new Set(entries.map((e) => e.traceId).filter(Boolean))].slice(0, 3);
  const tail = [];
  if (result.filter?.grepPushdown) tail.push('提示：使用 q/regex 时只回传命中的行，堆栈续行不随行返回；需要堆栈用 log_context(hit=...)。');
  if (stats.truncated) tail.push(`⚠ 只返回了最近/最早的 ${maxLines} 条，请缩小时间窗或加 q/level/service 条件。`);
  if (traces.length) tail.push(`可用 traceId 深入：${traces.join(', ')}（log_trace traceId=...）`);
  tail.push('下一步：log_context(hit="<id>") 看上下文；log_summarize(groupBy=["template"]) 聚类。');
  return [...head, '', ...rows, '', ...tail].join('\n');
}

export function renderSummarize({ groups, stats, window, bucketRows, total, noise, groupBy, topN }, cfg) {
  const lines = [
    `区间 ${window.label}　参与统计 ${total} 条${noise ? `（忽略噪音 ${noise} 条）` : ''}　扫描 ${stats.files} 个目标${stats.bytes ? ` ${humanBytes(stats.bytes)}` : ''}${stats.truncated ? '　⚠ 扫描已截断' : ''}`,
    '',
    `按 ${groupBy.join(' + ')} 分组（Top ${topN}）：`,
  ];
  if (!groups.length) lines.push('  无数据');
  for (const g of groups) {
    const pct = total ? ((g.count / total) * 100).toFixed(1) : '0.0';
    lines.push(`  ${String(g.count).padStart(5)}  ${pct.padStart(5)}%  ${g.label}`);
    lines.push(`        首 ${g.first}　末 ${g.last}　示例 [${g.id}] ${clip(g.sample, 160)}`);
  }
  if (bucketRows?.length) {
    lines.push('', '时间分布：');
    const max = Math.max(...bucketRows.map((b) => b.count), 1);
    for (const b of bucketRows) {
      const bar = '▇'.repeat(Math.max(1, Math.round((b.count / max) * 12)));
      lines.push(`  ${b.bucket} ${bar} ${b.count}`);
    }
  }
  lines.push('', '下一步：对增长最快的分组用 log_search(q=["..."]) 取样，或 log_trace 串联请求。');
  return lines.join('\n');
}

export function renderContext({ entries, targetIndex, refInfo }, cfg, stackLines) {
  if (!entries.length) return '未能在该位置附近解析出日志条目。';
  const target = refInfo.container ?? shortFile(refInfo.file);
  const lines = [`上下文：${target} @${refInfo.rawTs ?? ''}（源 ${refInfo.sourceName}）`, ''];
  entries.forEach((entry, i) => {
    const marker = i === targetIndex ? '→' : ' ';
    const head = `${marker} ${entry.rawTs} ${entry.level.padEnd(5)} ${clip(entry.logger || '-', 40)}${entry.traceId ? ` trace=${entry.traceId}` : ''} | ${clip(entry.msg, 400)}`;
    lines.push(head);
    const cont = entry.lines.slice(1);
    const keep = cont.slice(0, stackLines);
    for (const line of keep) lines.push(`  ${clip(line, 300)}`);
    const dropped = cont.length - keep.length + (entry.hiddenLines ?? 0);
    if (dropped > 0) lines.push(`  …（省略 ${dropped} 行）`);
  });
  return lines.join('\n');
}

export function renderTrace({ traceId, entries, window, stats }, cfg) {
  if (!entries.length) {
    return `traceId=${traceId} 在 ${window.label} 内没有命中。可尝试扩大时间窗（last="6h"）、换 source，或确认 traceId 字段格式（当前规则: ${cfg.tracePatterns.length} 条）。`;
  }
  const tz = cfg.timezone;
  const epoch = (e) => parseZoned(e.rawTs, tz)?.getTime() ?? null;
  const first = epoch(entries[0]);
  const lines = [
    `traceId=${traceId}　${entries.length} 条　${window.label}　服务: ${[...new Set(entries.map((e) => e.service))].join(', ')}`,
    '',
  ];
  let prev = null;
  for (const e of entries) {
    const t = epoch(e);
    const delta = t != null && first != null ? t - first : null;
    const gap = prev != null && t != null && t - prev >= 1000 ? `  ← Δ${((t - prev) / 1000).toFixed(1)}s` : '';
    lines.push(`${delta == null ? '?' : `+${delta}ms`}  [${allocHit(e, cfg)}] ${e.rawTs} ${e.level.padEnd(5)} ${clip(e.logger || '-', 36)} | ${clip(e.msg, 200)}${gap}`);
    if (e.lines.length > 1) lines.push(`        ${clip(e.lines.at(-1), 200)}`);
    if (t != null) prev = t;
  }
  const loggers = [...new Set(entries.map((e) => e.logger).filter(Boolean))];
  lines.push('', `调用链关键点: ${loggers.slice(0, 8).join(' → ')}`);
  return lines.join('\n');
}

export function renderSources(cfg, { sources, services, files, probeResults, discovery }) {
  const others = (cfg.envs ?? []).filter((n) => n !== cfg.env);
  const envTag = !cfg.envs?.length
    ? ''
    : cfg.env
      ? `　标签 ${cfg.env}${others.length ? `（其它可用: ${others.join(',')}）` : ''}`
      : `　标签 (未选，共 ${cfg.envs.length} 个)`;
  const lines = [`配置 ${cfg.file}${envTag}　时区 ${cfg.timezone}　只读模式`, '', '日志源（每个标签一个）:'];
  for (const s of sources) {
    const where = s.type === 'ssh' || s.type === 'docker' ? `${s.user}@${s.host}:${s.port}` : s.roots.join(', ');
    const probe = probeResults?.[s.name];
    const kind = s.type === 'docker'
      ? `容器=${s.containers.length ? s.containers.join(',') : '(运行中全部)'}`
      : `glob=${s.defaultGlob}  单次扫描上限=${humanBytes(s.tailBytes ?? cfg.defaults.tailBytes)}`;
    lines.push(`  - ${s.name} [${s.type}] ${where}  ${kind}${probe ? `  探测=${probe.ok ? 'OK' : `失败: ${probe.detail}`}` : ''}`);
  }
  if (!sources.length) lines.push('  （未配置）');
  const svcNames = Object.keys(services);
  if (svcNames.length) {
    lines.push('', '服务映射（同一标签共用一个源）:');
    for (const name of svcNames) {
      const s = services[name];
      const target = s.container ? `container=${s.container}` : `glob=${s.glob ?? '(源默认)'}`;
      const fmt = s.format ? ` format=${s.format}` : '';
      lines.push(`  - ${name} → ${target}${fmt}`);
    }
  }
  if (discovery) {
    const { os, docker, services: units, hotLogs, journald } = discovery;
    lines.push('', `主机发现（${os}${journald ? '，journald 可用' : ''}）:`);
    if (docker.length) {
      lines.push(`  容器 ${docker.length} 个:`);
      for (const d of docker.slice(0, 15)) lines.push(`    - ${d.name}  ${d.image ?? ''}  ${d.status ?? ''}`.trimEnd());
    }
    if (units.length) lines.push(`  运行中服务: ${units.slice(0, 15).join(' ')}${units.length > 15 ? ' …' : ''}`);
    if (hotLogs.length) {
      lines.push('  近 3 天活跃日志:');
      for (const f of hotLogs.slice(0, 15)) lines.push(`    - ${humanBytes(f.size).padStart(7)}  ${f.file}`);
    }
    lines.push('  下一步：log_sources 结果里选一个 glob 或容器，用 log_search(host="…", user="…", glob=…/container=…, last="30m")。');
  }
  if (files?.length) {
    const isContainer = files[0].container != null;
    lines.push('', isContainer ? '容器列表:' : '匹配文件（最新在前）:');
    for (const f of files) {
      lines.push(isContainer ? `  - ${f.container}` : `  - ${f.file}  ${humanBytes(f.size)}  ${f.mtime ?? ''}${f.gz ? '  (gz)' : ''}`);
    }
  }
  const scoped = cfg.env ? `env=\"${cfg.env}\"` : 'env=\"<标签>\"';
  lines.push('', `用法：log_search(${scoped}, last="30m", q=["Exception"], level="ERROR")；log_summarize(${scoped}, groupBy=["template"])。`);
  return lines.join('\n');
}

/**
 * 数据源确认回执：告诉模型锁定了哪个标签、能查哪些服务，可以开始查了。
 */
export function renderEnvConfirmation(cfg, entry, state) {
  const s = cfg.sources[0];
  const where = !s ? '（源配置有误）' : s.type === 'file' ? s.roots.join(', ') : `${s.user}@${s.host}:${s.port}`;
  const svc = Object.keys(cfg.services);
  const lines = [
    `已确认数据源：${cfg.env}`,
    `  源 ${s?.name ?? '-'} [${s?.type ?? '-'}] ${where}`,
    svc.length ? `  服务: ${svc.join(', ')}` : '  服务: （未配置，可直接用 glob/container）',
    '',
    `本会话已锁定在 ${cfg.env}。其它标签会被拒绝；要换环境先问用户，再 log_confirm_env。`,
    `下一步：log_search(env="${cfg.env}", last="30m", q=["Exception"], level="ERROR") / log_investigate(env="${cfg.env}", services=[…], last="2h")`,
  ];
  if (entry?.errors?.length) lines.push('', `注意：该标签还有 ${entry.errors.length} 条配置错误：${entry.errors.map((e) => `${e.scope}: ${e.message}`).join('; ')}`);
  if (state?.evidence) lines.push('', `依据：${state.evidence}`);
  return lines.join('\n');
}

/**
 * 未指定标签时给模型看的全景：所有标签 + 各自的源与服务。
 * 目的：让模型先把「看哪个数据源」问清楚，而不是随机挑一个。
 */
export function renderEnvOverview(cfg) {
  const lines = [
    `配置 ${cfg.file}　时区 ${cfg.timezone}　只读模式`,
    '',
    `环境标签 ${cfg.envs.length} 个，全部同时有效。查日志前必须先确定用哪个（调用时带 env）：`,
  ];
  for (const name of cfg.envs) {
    const e = cfg.envMap[name] ?? { sources: [], services: {}, errors: [] };
    const s = e.sources[0];
    if (e.errors?.length) {
      lines.push(`  - ${name}: 配置有误（${e.errors.map((x) => `${x.scope}: ${x.message}`).join('; ')}）`);
    } else if (!s) {
      lines.push(`  - ${name}: 没有日志源（到配置页补一个）`);
    } else {
      const where = s.type === 'file' ? s.roots.join(', ') : `${s.user}@${s.host}:${s.port}`;
      const target = s.type === 'docker' ? `容器=${s.containers.length ? s.containers.join(',') : '(运行中全部)'}` : `glob=${s.defaultGlob}`;
      lines.push(`  - ${name}: 源 ${s.name} [${s.type}] ${where}  ${target}`);
      const svc = Object.keys(e.services);
      if (svc.length) {
        lines.push('      服务:');
        for (const n of svc) {
          const d = e.services[n];
          const t = d.container ? `container=${d.container}` : `glob=${d.glob ?? '(源默认)'}`;
          lines.push(`        · ${n} → ${t}${d.format ? `  format=${d.format}` : ''}`);
        }
      } else {
        lines.push('      服务: （无，需在配置里加服务或用 glob/container 直连）');
      }
    }
  }
  lines.push(
    '',
    '下一步：先确认用户要看哪个标签（环境 / 服务器 / 容器组），然后带 env 参数重试，例如：',
    `  log_sources(${cfg.envs.map((n) => `env="${n}"`).join(' / ')}…)`,
    '  log_search(env="<标签>", last="30m", q=["Exception"], level="ERROR")',
    '用户已明确说了环境就直接用；没说就问一句，不要自己挑。',
  );
  return lines.join('\n');
}

/* --------------------------- 多服务排查汇总（log_investigate） --------------------------- */

function levelCounts(entries) {
  const counts = {};
  for (const e of entries) counts[e.level] = (counts[e.level] ?? 0) + 1;
  return counts;
}

function templateTable(entries) {
  const map = new Map();
  for (const e of entries) {
    const key = e.template;
    let g = map.get(key);
    if (!g) {
      g = { template: key, count: 0, first: e.tsKey, last: e.tsKey, entry: e, worst: e.level };
      map.set(key, g);
    }
    g.count += 1;
    if (e.tsKey < g.first) g.first = e.tsKey;
    if (e.tsKey > g.last) g.last = e.tsKey;
    if (levelWeight(e.level) > levelWeight(g.worst)) {
      g.worst = e.level;
      g.entry = e;
    }
  }
  return [...map.values()].sort((a, b) => levelWeight(b.worst) - levelWeight(a.worst) || b.count - a.count);
}

const LEVEL_WEIGHT = { TRACE: 0, DEBUG: 1, INFO: 2, WARN: 3, ERROR: 4, FATAL: 5 };
function levelWeight(level) {
  return LEVEL_WEIGHT[level] ?? 2;
}

/** 选证据：优先高等级、同类只留一条（首/末），最多 max 条。 */
export function pickEvidence(entries, max = 4) {
  const ranked = [...entries].sort(
    (a, b) => levelWeight(b.level) - levelWeight(a.level) || (a.tsKey < b.tsKey ? -1 : 1),
  );
  const seen = new Set();
  const out = [];
  for (const e of ranked) {
    const key = `${e.template}|${e.level}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
    if (out.length >= max) break;
  }
  return out.sort((a, b) => (a.tsKey < b.tsKey ? -1 : 1));
}

export function renderInvestigation(cfg, { keywords, window, results, maxEvidence }) {
  const lines = [
    `排查摘要　关键词: ${keywords.length ? keywords.join(' / ') : '(未指定)'}　区间 ${window.label}　目标 ${results.length} 个`,
  ];

  const traceSets = [];
  for (const r of results) {
    const counts = levelCounts(r.entries);
    const brief = Object.entries(counts)
      .sort((a, b) => levelWeight(b[0]) - levelWeight(a[0]))
      .map(([lv, n]) => `${lv} ${n}`)
      .join(' ');
    const detected = r.adapted
      ? `格式 ${r.adapted.format ?? '未识别'}${r.adapted.formatRatio != null ? ` ${r.adapted.formatRatio}` : ''}${r.adapted.traceSource ? ` / trace ${r.adapted.traceSource}` : ''}${r.adapted.cached ? ' (缓存)' : ''}`
      : '格式 已固定';

    if (!r.error && r.entries.length) {
      const firstTs = r.entries[0]?.rawTs.slice(11);
      const lastTs = r.entries.at(-1)?.rawTs.slice(11);
      const noiseNote = r.noise ? ` | 噪音 ${r.noise} 已忽略` : '';
      lines.push(`  ✓ ${r.label}: 命中 ${r.entries.length}${noiseNote} | ${brief} | ${firstTs}→${lastTs} | 模板 ${templateTable(r.entries).length} | ${detected}`);
    } else if (r.error) {
      lines.push(`  ✗ ${r.label}: 采集失败 → ${r.error}`);
    } else {
      lines.push(`  ○ ${r.label}: 0 命中 | ${detected}`);
    }
    const traces = r.entries.map((e) => e.traceId).filter(Boolean);
    if (traces.length) traceSets.push({ label: r.label, traces: new Set(traces) });
  }

  // 跨服务共享 traceId：排查"同一次请求打穿多个服务"
  const shared = [];
  if (traceSets.length > 1) {
    const [first, ...rest] = traceSets;
    for (const t of first.traces) {
      if (rest.every((s) => s.traces.has(t))) shared.push(t);
    }
  }
  if (shared.length) lines.push(`  共享 traceId: ${shared.slice(0, 3).join(', ')}（log_trace 可串联）`);

  for (const r of results) {
    if (!r.entries.length) continue;
    const templates = templateTable(r.entries);
    lines.push('', `证据（${r.label}）:`);
    const evidence = pickEvidence(r.entries, maxEvidence);
    for (const e of evidence) {
      const same = templates.find((t) => t.template === e.template);
      const meta = same
        ? `同类 ${same.count} 次${same.count > 1 ? `，首 ${same.first.slice(11)} 末 ${same.last.slice(11)}` : ''}`
        : '';
      lines.push(`  [${allocHit(e, cfg)}] ${e.rawTs} ${e.level.padEnd(5)} ${clip(e.logger || '-', 34)} | ${clip(e.msg)}${e.lines.length > 1 ? ` (+${e.lines.length - 1}行)` : ''}${meta ? `　（${meta}）` : ''}`);
    }
    const top = templates.filter((t) => levelWeight(t.worst) >= 3).slice(0, 3);
    if (top.length) {
      lines.push(`  主要异常模式:`);
      for (const t of top) lines.push(`    ${String(t.count).padStart(4)}× [${t.worst}] ${clip(t.template, 110)}`);
    }
  }

  const totalErrors = results.reduce((n, r) => n + r.entries.filter((e) => levelWeight(e.level) >= 4).length, 0);
  lines.push('', '下一步建议:');
  if (!results.some((r) => r.entries.length)) {
    lines.push('  - 全部无命中：先用 log_playbook 的关键词库换关键字，或扩大时间窗（last="6h"）；再核对 glob/容器名是否正确（log_sources）。');
  } else if (totalErrors) {
    lines.push('  - 有 ERROR：对上面证据用 log_context(hit=…) 拿堆栈；用 log_trace 串共享 traceId 找首个失败点。');
    lines.push('  - 用 log_summarize(groupBy=["template","level"], bucket="5m") 确认爆发时间点是否与发布/配置变更重合。');
  } else {
    lines.push('  - 无 ERROR：可能是延迟/指标类问题，用 log_summarize(groupBy=["template"]) 看增长，或换慢查询/超时关键词。');
  }
  if (results.some((r) => (r.adapted?.formatRatio ?? 1) < 0.6)) {
    lines.push('  - 有服务格式识别率偏低：在配置里为该服务显式指定 format，或用 formats 增加自定义档案。');
  }
  return lines.join('\n');
}
