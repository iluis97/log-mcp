const DURATION_UNITS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const formatters = new Map();

function partsOf(date, timeZone) {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, fmt);
  }
  const out = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== 'literal') out[part.type] = part.value;
  }
  return out;
}

/** 按 IANA 时区格式化为 yyyy-MM-dd HH:mm:ss（与日志行前缀可直接做字符串比较）。 */
export function formatZoned(date, timeZone) {
  const p = partsOf(date, timeZone);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/** docker logs --since/--until 需要的 RFC3339（带配置时区的偏移）。 */
export function toRfc3339(date, timeZone) {
  const p = partsOf(date, timeZone);
  const offset = tzOffsetMs(date, timeZone);
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const hh = String(Math.floor(abs / 3_600_000)).padStart(2, '0');
  const mm = String(Math.floor((abs % 3_600_000) / 60_000)).padStart(2, '0');
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${sign}${hh}:${mm}`;
}

function tzOffsetMs(date, timeZone) {
  const p = partsOf(date, timeZone);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** 解析不带时区的时间字符串，按配置时区解释。 */
export function parseZoned(text, timeZone) {
  const m = /^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:[.,](\d{1,6}))?$/.exec(String(text).trim());
  if (!m) {
    const d = new Date(text);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0), Number(String(m[7] ?? '0').slice(0, 3).padEnd(3, '0')));
  let ts = guess - tzOffsetMs(new Date(guess), timeZone);
  ts = guess - tzOffsetMs(new Date(ts), timeZone);
  return new Date(ts);
}

export function parseDuration(text) {
  const m = /^(\d+)\s*(s|m|h|d)$/i.exec(String(text).trim());
  return m ? Number(m[1]) * DURATION_UNITS[m[2].toLowerCase()] : null;
}

/** 解析时间窗口：支持 last="15m" 或 from/to（本地墙钟时间按配置时区解释）。 */
export function resolveWindow(cfg, params = {}) {
  const tz = cfg.timezone;
  const now = new Date();
  let start;
  let end;

  if (params.last) {
    const ms = parseDuration(params.last);
    if (!ms) throw new Error(`last 格式非法: ${params.last}（示例 "15m" / "2h" / "30s"）`);
    end = now;
    start = new Date(now.getTime() - ms);
  } else if (params.from || params.to) {
    end = params.to ? parseZoned(params.to, tz) : now;
    start = params.from ? parseZoned(params.from, tz) : new Date(end.getTime() - 900_000);
    if (!end || !start) throw new Error('from/to 时间格式非法，示例 "2026-08-13 10:00:00"');
  } else {
    const ms = parseDuration(cfg.defaults.last) ?? 900_000;
    end = now;
    start = new Date(now.getTime() - ms);
  }

  if (start.getTime() > end.getTime()) throw new Error('时间窗口非法：from 晚于 to');
  return {
    start,
    end,
    startStr: formatZoned(start, tz),
    endStr: formatZoned(end, tz),
    label: `${formatZoned(start, tz)} ~ ${formatZoned(end, tz)}`,
  };
}
