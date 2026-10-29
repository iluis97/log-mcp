import fs from 'node:fs';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { expandLocal, matchAnyPattern, hasMeta } from './glob.mjs';
import { runCommand } from './exec.mjs';
import { getSource, defaultSshPath, expandHome } from './config.mjs';
import { toRfc3339 } from './time.mjs';

const META_PREFIX = '__LOGMCP_META__';
const META_RE = new RegExp(`^${META_PREFIX} (\\d+) (\\d)$`);
const MAX_OUTPUT_BYTES = 60 * 1024 * 1024;
const CONTAINER_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
/** 即使 allowPaths 放行，也不读这些敏感文件 */
const DENY_PATH = /(^|\/)(shadow|gshadow|passwd|\.env|id_rsa|id_dsa|id_ed25519|\.ssh|\.aws|\.gnupg|\.kube)(\/|$)/i;
const DENY_EXT = /\.(pem|key|p12|pfx|jks|keystore)$/i;
function isDeniedPath(file) {
  return DENY_PATH.test(file) || DENY_EXT.test(file);
}

/** POSIX shell 单引号转义；只用于拼接固定模板中的参数。 */
export function shq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function sshArgs(source, script) {
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ConnectionAttempts=1',
    '-o', 'StrictHostKeyChecking=accept-new',
  ];
  if (source.keyFile) args.push('-i', source.keyFile);
  args.push('-p', String(source.port), `${source.user}@${source.host}`);
  if (script != null) args.push(script);
  return args;
}

function toArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/** 不写配置也能连：host/user 直接拼一个临时只读源。 */
export function buildAdhocSource(cfg, params) {
  const host = String(params.host ?? '').trim();
  if (!/^[A-Za-z0-9_.:-]+$/.test(host)) throw new Error(`host 非法: ${params.host}`);
  const user = String(params.user ?? cfg.defaults.user ?? '').trim();
  if (!user) throw new Error('使用 host 参数时需要同时提供 user（或在 defaults.user 里配置默认用户）');
  if (!/^[A-Za-z0-9_.-]+$/.test(user)) throw new Error(`user 非法: ${user}`);
  const port = Number(params.port ?? 22);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`port 非法: ${params.port}`);
  const container = params.container ? String(toArray(params.container)[0]) : null;
  if (container) assertContainer(container);
  return {
    name: `adhoc-${host}`,
    type: container ? 'docker' : 'ssh',
    host,
    user,
    port,
    keyFile: params.keyFile ? expandHome(String(params.keyFile)) : undefined,
    sshPath: defaultSshPath(),
    dockerPath: 'docker',
    containers: container ? [container] : [],
    allowPaths: ['/**'],
    defaultGlob: '/**/*.log*',
    format: params.format ?? null,
  };
}

function resolveQueries(cfg, params) {
  if (params.host) {
    const source = buildAdhocSource(cfg, params);
    return [{
      source,
      glob: params.glob ?? source.defaultGlob,
      container: source.type === 'docker' ? source.containers[0] : null,
      format: source.format,
      service: params.service ? String(toArray(params.service)[0]) : null,
    }];
  }
  const queries = [];
  const services = toArray(params.service);
  for (const name of services) {
    const svc = cfg.services[name];
    if (!svc) throw new Error(`未知服务: ${name}（已配置: ${Object.keys(cfg.services).join(', ') || '无'}）`);
    const source = svc.source ? getSource(cfg, svc.source) : cfg.sources[0];
    if (!source) throw new Error('配置中没有任何日志源');
    queries.push({
      source,
      glob: params.glob ?? svc.glob ?? source.defaultGlob,
      container: params.container ?? svc.container ?? null,
      format: svc.format ?? source.format ?? null,
      service: name,
    });
  }
  if (queries.length) return queries;
  const sources = params.source ? toArray(params.source).map((n) => getSource(cfg, n)) : cfg.sources;
  for (const source of sources) {
    queries.push({
      source,
      glob: params.glob ?? source.defaultGlob,
      container: params.container ?? null,
      format: source.format ?? null,
      service: null,
    });
  }
  return queries;
}

async function listLocalFiles(source, glob, limit) {
  const seen = new Set();
  const out = [];
  for (const root of source.roots) {
    for (const f of await expandLocal(root, glob, limit)) {
      const normalized = f.file.replace(/\\/g, '/');
      if (seen.has(normalized)) continue;
      if (isDeniedPath(normalized)) continue;
      if (!matchAnyPattern(normalized, source.allowPaths)) continue;
      seen.add(normalized);
      out.push({ type: 'file', source, file: normalized, size: f.size, mtime: f.mtime, gz: normalized.toLowerCase().endsWith('.gz') });
    }
  }
  return out;
}

async function listRemoteFiles(source, glob, limit) {
  const abs = glob.startsWith('/') ? glob : `/${glob}`;
  const slash = abs.lastIndexOf('/');
  const dir = abs.slice(0, slash) || '/';
  const name = abs.slice(slash + 1);
  if (hasMeta(dir)) throw new Error(`ssh 源的 glob 目录部分不能含通配符: ${glob}`);
  if (!/^[A-Za-z0-9_./*?@:+-]+$/.test(abs)) throw new Error(`glob 含不安全字符: ${glob}`);

  const script = `find ${shq(dir)} -maxdepth 1 -type f -name ${shq(name)} -printf '%p|%s|%T@\\n' 2>/dev/null | head -n ${limit}`;
  const res = await runCommand(source.sshPath, sshArgs(source, script), { timeoutMs: 20000 });
  const text = res.stdout.toString('utf8');
  if (!text.trim()) {
    if (res.code !== 0) throw new Error(`列出远端文件失败(${source.name}): ${res.stderr.trim() || `exit ${res.code}`}`);
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    const [file, size, mtime] = line.trim().split('|');
    if (!file) continue;
    const normalized = file.replace(/\\/g, '/');
    if (isDeniedPath(normalized)) continue;
    if (!matchAnyPattern(normalized, source.allowPaths)) continue;
    out.push({
      type: 'ssh',
      source,
      file: normalized,
      size: Number(size) || 0,
      mtime: (Number(mtime) || 0) * 1000,
      gz: normalized.toLowerCase().endsWith('.gz'),
    });
  }
  return out;
}

function assertContainer(name) {
  if (!CONTAINER_RE.test(String(name))) throw new Error(`容器名非法: ${name}`);
  return String(name);
}

/** 列出 docker 源上可读的容器：显式指定 > 配置白名单 > 运行中的容器。 */
export async function listDockerContainers(source, requested) {
  const wanted = toArray(requested);
  if (wanted.length) return wanted.map(assertContainer);
  if (source.containers?.length) return source.containers;
  const script = `${shq(source.dockerPath)} ps --format '{{.Names}}' 2>/dev/null`;
  const res = await runCommand(source.sshPath, sshArgs(source, script), { timeoutMs: 20000 });
  const names = res.stdout
    .toString('utf8')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!names.length && res.code !== 0) {
    throw new Error(`列出容器失败(${source.name}): ${res.stderr.trim() || `exit ${res.code}`}`);
  }
  return names;
}

/** 解析查询条件 → 待扫描的日志目标（文件 / 容器，按修改时间倒序）。 */
export async function listTargets(cfg, params) {
  const limit = Math.max(1, Number(params.files ?? cfg.defaults.files));
  const targets = [];
  for (const { source, glob, container, format, service } of resolveQueries(cfg, params)) {
    if (source.type === 'docker') {
      for (const name of await listDockerContainers(source, container)) {
        targets.push({ type: 'docker', source, file: name, container: name, size: 0, mtime: Date.now(), gz: false, format, service });
      }
      continue;
    }
    const files = source.type === 'file' ? await listLocalFiles(source, glob, limit) : await listRemoteFiles(source, glob, limit);
    for (const f of files) targets.push({ ...f, container: null, format, service });
  }
  targets.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
  const seen = new Set();
  return targets.filter((t) => {
    const key = `${t.source.name}|${t.type === 'docker' ? t.container : t.file}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function acceptLine(text, filter) {
  if (filter.regex) return filter.regexRe.test(text);
  if (filter.q?.length) {
    const lower = text.toLowerCase();
    return filter.q.some((p) => lower.includes(String(p).toLowerCase()));
  }
  return true;
}

function awkProgram(target, filter) {
  const S = filter.startStr ?? '0000-00-00 00:00:00';
  const E = filter.endStr ?? '9999-99-99 99:99:99';
  const head = target.head ?? { headPattern: null, ts: { offset: 0, length: 19 } };
  const split = 'i = index($0, ":"); off = substr($0, 1, i-1); ln = substr($0, i+1)';

  // 没有行首时间的格式（如 JSON lines）：远端不过滤，只补偏移，时间过滤交给本地
  if (!head.headPattern) {
    if (filter.grepPushdown) return `BEGIN { keep = 1 } { ${split}; print off ":" ln }`;
    return 'BEGIN { off = 0 } { ln = $0; printf "%d:%s\\n", off, ln; off += length(ln) + 1 }';
  }

  const headFn = `function ishead(l) { return l ~ /${head.headPattern.replace(/\//g, '\/')}/ }`;
  const offset = (head.ts?.offset ?? 0) + 1;
  const length = head.ts?.length ?? 19;
  const gate = `if (ishead(ln)) { ts = substr(ln, ${offset}, ${length}); keep = (ts >= S && ts <= E) }`;
  if (filter.grepPushdown) {
    return `BEGIN { keep = 1; S = "${S}"; E = "${E}" } ${headFn} { ${split}; ${gate} if (keep) print off ":" ln }`;
  }
  return `BEGIN { keep = 1; off = 0; S = "${S}"; E = "${E}" } ${headFn} { ln = $0; ${gate} if (keep) printf "%d:%s\\n", off, ln; off += length(ln) + 1 }`;
}

/** 下推管道：grep(命中行) → awk(条目级时间窗 + 保留堆栈续行 + 行内偏移) → 行数裁剪 → 字节上限 */
function pipelineStages(target, filter) {
  const stages = [];
  if (filter.regex) stages.push(`LC_ALL=C grep -a -b -i -E -- ${shq(filter.regex)}`);
  else if (filter.q?.length) stages.push(`LC_ALL=C grep -a -b -i -F ${filter.q.map((p) => `-e ${shq(p)}`).join(' ')}`);
  stages.push(`LC_ALL=C awk ${shq(awkProgram(target, filter))}`);
  stages.push(filter.order === 'asc' ? `head -n ${filter.scanCap}` : `tail -n ${filter.scanCap}`);
  stages.push(`head -c ${MAX_OUTPUT_BYTES}`);
  return stages;
}

export function buildRemoteScript(target, filter) {
  const pre = ['set -u', `f=${shq(target.file)}`, '[ -r "$f" ] || { echo "__LOGMCP_ERR__ 无法读取 $f" >&2; exit 3; }'];
  let reader;
  if (target.gz) {
    pre.push(`printf '${META_PREFIX} 0 1\\n'`);
    reader = 'zcat -f -- "$f"';
  } else {
    pre.push('s=$(stat -c %s -- "$f" 2>/dev/null || echo 0)');
    pre.push(`if [ "$s" -gt ${filter.tailBytes} ]; then b=$((s-${filter.tailBytes})); else b=0; fi`);
    pre.push(`printf '${META_PREFIX} %s 0\\n' "$b"`);
    reader = 'tail -c +$((b+1)) -- "$f"';
  }
  return [...pre, `${reader} | ${pipelineStages(target, filter).join(' | ')}`].join('\n');
}

/** docker 源：只读 `docker logs --since/--until`，按配置时区传 RFC3339。 */
export function buildDockerScript(target, filter) {
  const source = target.source;
  const container = assertContainer(target.container ?? target.file);
  const since = toRfc3339(filter.start, filter.timezone);
  const until = toRfc3339(filter.end, filter.timezone);
  const pre = ['set -u', `c=${shq(container)}`, `printf '${META_PREFIX} 0 0\\n'`];
  const reader = `${shq(source.dockerPath)} logs --since ${shq(since)} --until ${shq(until)} "$c" 2>&1`;
  return [...pre, `${reader} | ${pipelineStages(target, filter).join(' | ')}`].join('\n');
}

async function* readLocalTarget(target, filter) {
  const stat = await fs.promises.stat(target.file);
  const start = target.gz ? 0 : Math.max(0, stat.size - filter.tailBytes);
  const stream = target.gz
    ? fs.createReadStream(target.file).pipe(zlib.createGunzip())
    : fs.createReadStream(target.file, { start });

  let offset = 0;
  let pending = Buffer.alloc(0);
  let skipFirst = !target.gz && start > 0;

  try {
    for await (const chunk of stream) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let idx;
      while ((idx = pending.indexOf(10)) !== -1) {
        const lineStart = offset;
        const lineBuf = pending.subarray(0, idx);
        pending = pending.subarray(idx + 1);
        offset += idx + 1;
        if (skipFirst) {
          skipFirst = false;
          continue;
        }
        const text = lineBuf.toString('utf8').replace(/\r$/, '');
        if (!acceptLine(text, filter)) continue;
        yield { offset: target.gz ? lineStart : start + lineStart, text, gz: !!target.gz };
      }
      if (pending.length > 4 * 1024 * 1024) pending = pending.subarray(pending.length - 65536);
    }
  } finally {
    stream.destroy();
  }
}

/** 统一处理“在远端执行一段脚本、把 off:line 流回来”的过程。 */
async function* streamRemoteScript(source, script, filter, gz) {
  const child = spawn(source.sshPath, sshArgs(source, script), {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const errChunks = [];
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, filter.timeoutMs);
  child.stderr.on('data', (c) => {
    if (errChunks.length < 64) errChunks.push(c);
  });
  const closed = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  child.on('error', () => {});

  let pending = Buffer.alloc(0);
  let base = 0;
  let sawMeta = false;

  try {
    for await (const chunk of child.stdout) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      if (pending.length > MAX_OUTPUT_BYTES) child.kill('SIGKILL');
      let idx;
      while ((idx = pending.indexOf(10)) !== -1) {
        const line = pending.subarray(0, idx).toString('utf8').replace(/\r$/, '');
        pending = pending.subarray(idx + 1);
        if (!sawMeta) {
          sawMeta = true;
          const meta = META_RE.exec(line);
          if (meta) {
            base = Number(meta[1]);
            continue;
          }
        }
        const sep = line.indexOf(':');
        if (sep <= 0) continue;
        const rel = Number(line.slice(0, sep));
        if (!Number.isFinite(rel)) continue;
        yield { offset: base + rel, text: line.slice(sep + 1), gz };
      }
      if (pending.length > 4 * 1024 * 1024) pending = pending.subarray(pending.length - 65536);
    }
    const code = await closed;
    if (timedOut) throw new Error(`读取 ${source.name} 超时`);
    if (code !== 0) {
      const msg = Buffer.concat(errChunks).toString('utf8').trim();
      if (!sawMeta || msg) throw new Error(`远端读取失败(${source.name}): ${msg || `exit ${code}`}`);
    }
  } finally {
    clearTimeout(timer);
    if (child.exitCode == null) child.kill();
  }
}

export function readTarget(target, filter) {
  if (target.type === 'file') return readLocalTarget(target, filter);
  if (target.type === 'docker') return streamRemoteScript(target.source, buildDockerScript(target, filter), filter, false);
  return streamRemoteScript(target.source, buildRemoteScript(target, filter), filter, !!target.gz);
}

function splitLines(buf, startOffset, dropFirstPartial) {
  const out = [];
  let from = 0;
  if (dropFirstPartial) {
    const nl = buf.indexOf(10);
    if (nl === -1) return out;
    from = nl + 1;
  }
  while (from <= buf.length) {
    const nl = buf.indexOf(10, from);
    const end = nl === -1 ? buf.length : nl;
    if (end > from || nl !== -1) {
      out.push({ offset: startOffset + from, text: buf.subarray(from, end).toString('utf8').replace(/\r$/, '') });
    }
    if (nl === -1) break;
    from = nl + 1;
  }
  return out;
}

/**
 * 命中里带着来源定义（临时 host 源不在 cfg 里），优先用快照，其次查配置。
 */
export function sourceFor(cfg, hit) {
  if (hit.sourceSnapshot) return hit.sourceSnapshot;
  return getSource(cfg, hit.sourceName);
}

/** 读取某个偏移附近的一段原始日志（文件源，用于 log_context）。gz 文件不支持。 */
export async function readSegment(cfg, hit, { beforeBytes = 65536, maxBytes = 131072 } = {}) {
  const source = sourceFor(cfg, hit);
  const start = Math.max(0, hit.offset - beforeBytes);
  let buf;
  if (source.type === 'file') {
    const fh = await fs.promises.open(hit.file, 'r');
    try {
      const st = await fh.stat();
      const len = Math.min(maxBytes, Math.max(0, st.size - start));
      buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, start);
    } finally {
      await fh.close();
    }
  } else {
    const script = `f=${shq(hit.file)}; s=${start}; tail -c +$((s+1)) -- "$f" | head -c ${maxBytes}`;
    const res = await runCommand(source.sshPath, sshArgs(source, script), { timeoutMs: 20000, maxBytes });
    if (!res.stdout.length && res.code !== 0) throw new Error(`读取上下文失败: ${res.stderr.trim() || `exit ${res.code}`}`);
    buf = res.stdout;
  }
  return splitLines(buf, start, start > 0).map((l) => ({ ...l, gz: false }));
}

/** docker 源没有字节偏移，用“命中时间 ± 窗口”重新取一段容器日志。 */
export async function readContainerWindow(cfg, hit, { beforeSec = 120, afterSec = 180, maxBytes = 1048576 } = {}) {
  const source = sourceFor(cfg, hit);
  if (source.type !== 'docker') throw new Error(`源 ${hit.sourceName} 不是 docker 类型`);
  const epoch = hit.epoch ?? Date.now();
  const since = toRfc3339(new Date(epoch - beforeSec * 1000), cfg.timezone);
  const until = toRfc3339(new Date(epoch + afterSec * 1000), cfg.timezone);
  const script = `${shq(source.dockerPath)} logs --since ${shq(since)} --until ${shq(until)} ${shq(hit.container)} 2>&1 | head -c ${maxBytes}`;
  const res = await runCommand(source.sshPath, sshArgs(source, script), { timeoutMs: 25000, maxBytes });
  if (!res.stdout.length && res.code !== 0) throw new Error(`读取容器上下文失败: ${res.stderr.trim() || `exit ${res.code}`}`);
  return splitLines(res.stdout, 0, false).map((l) => ({ ...l, gz: false }));
}

/** 主机发现：OS / 容器 / 运行中服务 / 近 3 天活跃日志 / journald 可用性。 */
export function buildDiscoveryScript(dockerPath = 'docker') {
  const docker = shq(dockerPath);
  return [
    'set +e',
    "echo '##OS'; uname -sr 2>/dev/null || echo unknown",
    `echo '##DOCKER'; ${docker} ps --format '{{.Names}}|{{.Image}}|{{.Status}}' 2>/dev/null | head -30`,
    "echo '##SYSTEMD'; systemctl list-units --type=service --state=running --no-legend --plain 2>/dev/null | head -40",
    "echo '##HOTLOG'; for d in /var/log /opt /app /data /srv /home /usr/local; do find \"$d\" -maxdepth 4 -type f -name '*.log*' -mtime -3 -printf '%s|%p\n' 2>/dev/null || find \"$d\" -maxdepth 4 -type f -name '*.log*' -mtime -3 2>/dev/null | while read -r f; do echo \"0|$f\"; done; done | sort -rn | head -20",
    "echo '##JOURNAL'; (command -v journalctl >/dev/null 2>&1 && echo yes) || echo no",
    "echo '##END'",
  ].join('\n');
}

export async function discoverHost(source) {
  const script = buildDiscoveryScript(source.dockerPath ?? 'docker');
  const res = await runCommand(source.sshPath, sshArgs(source, script), { timeoutMs: 30000 });
  const text = res.stdout.toString('utf8');
  if (!text.trim()) throw new Error(`连接 ${source.host} 失败: ${res.stderr.trim() || `exit ${res.code}`}`);
  return parseDiscovery(text);
}

export function parseDiscovery(text) {
  const sections = new Map();
  let current = null;
  for (const line of text.split('\n')) {
    const m = /^##([A-Z]+)$/.exec(line.trim());
    if (m) {
      current = m[1];
      sections.set(current, []);
      continue;
    }
    if (current) sections.get(current).push(line);
  }
  const rows = (name) => (sections.get(name) ?? []).map((l) => l.trim()).filter(Boolean);
  const docker = rows('DOCKER').map((l) => {
    const [name, image, status] = l.split('|');
    return { name, image, status };
  });
  const services = rows('SYSTEMD').map((l) => l.split(/\s+/)[0]).filter(Boolean);
  const hotLogs = rows('HOTLOG')
    .map((l) => {
      const [size, file] = l.split('|');
      return { size: Number(size) || 0, file };
    })
    .filter((f) => f.file && !isDeniedPath(f.file));
  return { os: rows('OS').join(' ') || 'unknown', docker, services, hotLogs, journald: rows('JOURNAL')[0] === 'yes' };
}

/** 探测远端可达性（只读命令）。 */
export async function probeSource(source) {
  if (source.type === 'file') {
    const ok = fs.existsSync(source.roots[0] ?? '');
    return { ok, detail: ok ? '本地目录可访问' : `目录不存在: ${source.roots[0]}` };
  }
  if (source.type === 'docker') {
    const res = await runCommand(source.sshPath, sshArgs(source, `${shq(source.dockerPath)} version --format '{{.Server.Version}}' 2>&1`), { timeoutMs: 15000 });
    const ok = res.code === 0;
    return { ok, detail: ok ? `docker ${res.stdout.toString('utf8').trim()}` : res.stderr.trim().split('\n')[0] || `exit ${res.code}` };
  }
  const res = await runCommand(source.sshPath, sshArgs(source, 'printf logmcp-ok'), { timeoutMs: 12000 });
  const ok = res.stdout.toString('utf8').includes('logmcp-ok');
  return { ok, detail: ok ? 'SSH 可达' : res.stderr.trim().split('\n')[0] || `exit ${res.code}` };
}

/** 列出某个源当前匹配的文件（用于 log_sources）。 */
export async function listSourceFiles(cfg, sourceName, glob) {
  const source = getSource(cfg, sourceName);
  if (source.type === 'docker') {
    const containers = await listDockerContainers(source, null);
    return containers.map((c) => ({ container: c }));
  }
  const pattern = glob ?? source.defaultGlob;
  const files =
    source.type === 'file' ? await listLocalFiles(source, pattern, 50) : await listRemoteFiles(source, pattern, 50);
  return files.map((f) => ({
    file: f.file,
    size: f.size,
    mtime: f.mtime ? new Date(f.mtime).toISOString() : null,
    gz: f.gz,
  }));
}
