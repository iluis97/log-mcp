import { listTargets, readTarget } from './sources.mjs';
import { buildEntries, LEVEL_RANK } from './parse.mjs';
import { resolveWindow } from './time.mjs';
import { compilePattern } from './regex.mjs';
import { buildHeadPattern, checkFormatName } from './formats.mjs';
import { adaptTarget, withTraceOverride } from './detect.mjs';

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function toArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/** 条目级过滤：时间、级别、traceId、关键词、排除条件。 */
function passes(entry, params, window) {
  if (params.level && entry.level in LEVEL_RANK && LEVEL_RANK[entry.level] < LEVEL_RANK[params.level]) return false;
  if (params.traces?.length) {
    // 支持前缀匹配：显示里被截断的 traceId 也能直接用来串联
    const t = (entry.traceId ?? '').toLowerCase();
    const hit = t && params.traces.some((p) => {
      const q = String(p).toLowerCase();
      return t === q || t.startsWith(q);
    });
    if (!hit) return false;
  }
  if (window && entry.tsKey) {
    if (entry.tsKey < window.startStr || entry.tsKey > window.endStr) return false;
  }
  if (params.exclude) {
    if (params.excludeRe.test(entry.text)) return false;
  }
  if (params.q?.length) {
    const lower = entry.text.toLowerCase();
    if (!params.q.some((p) => lower.includes(String(p).toLowerCase()))) return false;
  }
  if (params.regex && !new RegExp(params.regex, 'i').test(entry.text)) return false;
  return true;
}

/**
 * 扫描 → 解析 → 过滤 → 按时间排序 → 按预算裁剪。
 * 下推在 sources 层完成（远端 grep/awk），这里只做条目级收尾。
 */
export async function scan(cfg, params, { maxLinesCap } = {}) {
  const forcedFormat = checkFormatName(cfg.formats, params.format, 'format 参数');
  const window = resolveWindow(cfg, params);
  const maxLines = clamp(params.maxLines ?? cfg.defaults.maxLines, 1, maxLinesCap ?? cfg.defaults.maxLinesCap);
  const order = params.order === 'asc' ? 'asc' : 'desc';
  const filter = {
    q: toArray(params.q),
    regex: params.regex,
    startStr: window.startStr,
    endStr: window.endStr,
    start: window.start,
    end: window.end,
    timezone: cfg.timezone,
    tailBytes: clamp(params.tailBytes ?? cfg.defaults.tailBytes, 64 * 1024, 2 * 1024 * 1024 * 1024),
    order,
    scanCap: Math.max(5000, maxLines * 40),
    timeoutMs: cfg.defaults.timeoutMs,
    grepPushdown: Boolean(params.regex || toArray(params.q).length),
  };
  if (filter.regex) {
    try {
      filter.regexRe = compilePattern(filter.regex, 'i');
    } catch (err) {
      throw new Error(`regex 非法: ${err.message}`);
    }
  }
  if (params.exclude) {
    try {
      params.excludeRe = compilePattern(params.exclude, 'i');
    } catch (err) {
      throw new Error(`exclude 非法: ${err.message}`);
    }
  }

  const maxFiles = clamp(params.files ?? cfg.defaults.files, 1, 50);
  const targets = await listTargets(cfg, params);
  const stats = { files: 0, entries: 0, bytes: 0, truncated: false, stopped: false };
  const collected = [];
  const cap = Math.min(50_000, Math.max(2000, maxLines * 4));

  for (const target of targets) {
    if (stats.files >= maxFiles) {
      stats.truncated = true;
      break;
    }
    stats.files += 1;
    stats.bytes += target.size ?? 0;

    // 未显式指定格式时：抽样自适应（命中缓存则不产生额外开销）
    let formatName = forcedFormat ?? target.format ?? null;
    let targetCfg = cfg;
    let adapted = null;
    if (!formatName && params.detect !== false) {
      try {
        adapted = await adaptTarget(cfg, target, { force: params.detect === 'force' });
        formatName = adapted.format ?? null;
        if (adapted.tracePattern) targetCfg = withTraceOverride(cfg, adapted.tracePattern);
      } catch {
        adapted = null; // 采样失败就退回逐行自动识别
      }
    }
    target.head = buildHeadPattern(targetCfg, formatName);
    if (adapted) {
      stats.detected = stats.detected ?? [];
      stats.detected.push({ target: target.container ?? target.file, ...adapted, scores: undefined });
    }
    const meta = {
      sourceName: target.source.name,
      file: target.file,
      gz: target.gz,
      service: target.service,
      container: target.container ?? null,
      targetType: target.type,
      source: target.source,
      format: formatName,
    };
    for await (const entry of buildEntries(readTarget(target, filter), targetCfg, meta)) {
      stats.entries += 1;
      if (!passes(entry, params, window)) continue;
      collected.push(entry);
      if (collected.length >= cap) {
        stats.truncated = true;
        stats.stopped = true;
        break;
      }
    }
    if (stats.stopped) break;
  }

  collected.sort((a, b) => (a.tsKey < b.tsKey ? -1 : a.tsKey > b.tsKey ? 1 : a.offset - b.offset));
  let entries = collected;
  if (collected.length > maxLines) {
    stats.truncated = true;
    entries = order === 'asc' ? collected.slice(0, maxLines) : collected.slice(-maxLines);
  }

  return { entries, stats, window, order, maxLines, filter, targets: targets.length };
}
