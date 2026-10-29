import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStatus } from './build.mjs';
import { buildFormats } from './formats.mjs';
import { normalizeSource, validateEnv, defaultSshPath } from './config.mjs';
import { assertEnvName, deleteEnv, describeEnvs, readDoc, saveEnv } from './envs.mjs';
import { discoverHost, probeSource } from './sources.mjs';
import { expandLocal } from './glob.mjs';

const PKG_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC_DIR = path.join(PKG_DIR, 'public');
const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

const MAX_BODY = 1024 * 1024;

/**
 * 配置页的字段元数据：页面完全按这里渲染，新增/调整字段不需要改 HTML。
 * 与 src/config.mjs 的 normalizeSource / loadConfig 保持一致。
 */
const SOURCE_FIELDS = [
  { key: 'name', label: '名称', type: 'string', required: true, placeholder: 'b-detect-host', appliesTo: ['file', 'ssh', 'docker'] },
  { key: 'type', label: '类型', type: 'enum', options: ['file', 'ssh', 'docker'], required: true, default: 'ssh' },
  { key: 'host', label: '主机', type: 'string', required: true, placeholder: '192.168.1.123', appliesTo: ['ssh', 'docker'] },
  { key: 'user', label: '用户', type: 'string', required: true, placeholder: 'root', appliesTo: ['ssh', 'docker'] },
  { key: 'port', label: '端口', type: 'number', default: 22, placeholder: '22', appliesTo: ['ssh', 'docker'] },
  { key: 'keyFile', label: '私钥', type: 'string', placeholder: '~/.ssh/id_ed25519', appliesTo: ['ssh', 'docker'] },
  { key: 'roots', label: '根目录', type: 'list', required: true, placeholder: 'F:/logs，多个用逗号分隔', appliesTo: ['file'] },
  { key: 'glob', label: '默认 glob', type: 'string', placeholder: '**/*.log*', appliesTo: ['file', 'ssh'] },
  { key: 'containers', label: '容器白名单', type: 'list', placeholder: '留空=运行中全部容器', appliesTo: ['docker'] },
  { key: 'allowPaths', label: '路径白名单', type: 'list', placeholder: '/opt/apps/**', advanced: true, appliesTo: ['file', 'ssh'] },
  { key: 'dockerPath', label: 'docker 命令', type: 'string', placeholder: 'docker', advanced: true, appliesTo: ['docker'] },
  { key: 'sshPath', label: 'ssh 命令', type: 'string', placeholder: '默认用系统 OpenSSH', advanced: true, appliesTo: ['ssh', 'docker'] },
  { key: 'tailBytes', label: '单文件扫描上限', type: 'number', placeholder: '默认 64MB', advanced: true, appliesTo: ['file', 'ssh', 'docker'] },
  { key: 'format', label: '格式', type: 'format', advanced: true, appliesTo: ['file', 'ssh', 'docker'] },
];

const SERVICE_FIELDS = [
  { key: 'name', label: '服务名', type: 'string', required: true, placeholder: 'b-detect' },
  { key: 'container', label: '容器', type: 'string', placeholder: 'docker 容器名（docker 源）' },
  { key: 'glob', label: '日志 glob', type: 'string', placeholder: '/opt/apps/x/logs/app*.log*' },
  { key: 'format', label: '格式', type: 'format' },
];

const FORMAT_FIELDS = ['spring', 'star-mvc', 'star-id-first', 'json', 'loose', 'generic'];

function formatsOf(doc) {
  try {
    return buildFormats(doc?.formats ?? {}).formats;
  } catch {
    return buildFormats({}).formats;
  }
}

function formatNames(doc) {
  return Object.keys(formatsOf(doc));
}

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(data);
}

function text(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大（上限 1MB）'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`请求体不是合法 JSON: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

/** 落盘用的服务定义：只留业务字段，丢掉已归一化掉的 source/空值。 */
function canonicalServices(services) {
  const out = {};
  for (const [name, s] of Object.entries(services ?? {})) {
    const def = {};
    if (s.glob) def.glob = s.glob;
    if (s.container) def.container = s.container;
    if (s.format) def.format = s.format;
    out[name] = def;
  }
  return out;
}

function configState(configFile, doc, exists, version) {
  const view = describeEnvs(doc);
  return {
    configFile,
    exists,
    version,
    legacy: view.legacy,
    envs: view.envs,
    envNames: Object.keys(view.envs),
    build: buildStatus(),
    meta: {
      timezone: doc.timezone ?? 'Asia/Shanghai',
      defaults: doc.defaults ?? {},
      formats: formatNames(doc),
      builtinFormats: FORMAT_FIELDS,
      sourceTypes: ['file', 'ssh', 'docker'],
      sourceFields: SOURCE_FIELDS,
      serviceFields: SERVICE_FIELDS,
      sshPathHint: defaultSshPath(),
    },
  };
}

/** 直接的源探测：页面里"探测"按钮用，不需要先保存配置。 */
async function probeSourceDraft(doc, rawSource) {
  const formats = formatsOf(doc);
  const source = normalizeSource(rawSource, 0, formats);
  const base = await probeSource(source);
  if (source.type === 'file') {
    const files = [];
    for (const root of source.roots) {
      if (!fs.existsSync(root)) continue;
      files.push(...(await expandLocal(root, source.defaultGlob, 20)));
    }
    return {
      ok: base.ok,
      detail: base.detail,
      files: files.slice(0, 20).map((f) => ({ file: f.file, size: f.size })),
    };
  }
  try {
    const discovery = await discoverHost(source);
    return { ok: base.ok, detail: base.detail, discovery };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

function matchRoute(route, method, pathname) {
  if (route.method !== method) return null;
  if (typeof route.path === 'string') return route.path === pathname ? [] : null;
  const m = route.path.exec(pathname);
  return m ? m.slice(1).map(decodeURIComponent) : null;
}

export function createWebServer({ configFile }) {
  const configPath = path.resolve(configFile);

  const routes = [
    {
      method: 'GET',
      path: '/api/config',
      async handle(req, res, _m, url) {
        const { doc, exists, version } = readDoc(configPath);
        if (url.searchParams.get('since') === version) return json(res, 200, { unchanged: true, version, build: buildStatus() });
        return json(res, 200, configState(configPath, doc, exists, version));
      },
    },
    {
      method: 'POST',
      path: '/api/validate',
      async handle(req, res) {
        const body = await readBody(req);
        const { doc } = readDoc(configPath);
        const result = validateEnv({ source: body.source ?? null, sources: body.sources, services: body.services ?? {} }, { formats: doc.formats ?? {} });
        return json(res, 200, {
          ok: result.ok,
          errors: result.errors,
          warnings: result.warnings,
          preview: { source: result.sources[0]?.name ?? null, services: Object.keys(result.services) },
        });
      },
    },
    {
      method: 'POST',
      path: '/api/probe',
      async handle(req, res) {
        const body = await readBody(req);
        if (!body.source) return json(res, 400, { ok: false, detail: '缺少 source' });
        const { doc } = readDoc(configPath);
        try {
          return json(res, 200, await probeSourceDraft(doc, body.source));
        } catch (err) {
          return json(res, 200, { ok: false, detail: err.message });
        }
      },
    },
    {
      method: 'PUT',
      path: /^\/api\/envs\/([^/]+)$/,
      async handle(req, res, [name]) {
        const body = await readBody(req);
        const { doc } = readDoc(configPath);
        const payload = {
          source: body.source ?? body.sources?.[0] ?? null,
          services: canonicalServices(body.services),
        };
        const result = validateEnv({ ...payload, sources: body.sources }, { formats: doc.formats ?? {}, env: name });
        if (!result.ok) return json(res, 400, { ok: false, errors: result.errors, warnings: result.warnings });
        const saved = saveEnv(configPath, assertEnvName(name), payload);
        const fresh = readDoc(configPath);
        return json(res, 200, { ok: true, warnings: result.warnings, ...configState(configPath, fresh.doc, fresh.exists, saved.version) });
      },
    },
    {
      method: 'DELETE',
      path: /^\/api\/envs\/([^/]+)$/,      async handle(req, res, [name]) {
        const result = deleteEnv(configPath, assertEnvName(name));
        const fresh = readDoc(configPath);
        return json(res, 200, { ok: true, ...configState(configPath, fresh.doc, fresh.exists, result.version) });
      },
    },
  ];

  const server = http.createServer(async (req, res) => {
    // 只服务本机：防 DNS rebinding / 局域网访问
    const hostHeader = String(req.headers.host ?? '');
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(hostHeader)) {
      return text(res, 403, '只允许本机访问');
    }
    const url = new URL(req.url ?? '/', `http://${hostHeader}`);

    if (req.method === 'GET' || req.method === 'HEAD') {
      const entry = STATIC_FILES[url.pathname];
      if (entry) {
        const [file, type] = entry;
        try {
          const buf = await fs.promises.readFile(path.join(PUBLIC_DIR, file));
          res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
          return res.end(req.method === 'HEAD' ? undefined : buf);
        } catch (err) {
          return text(res, 500, `静态文件读取失败: ${err.message}`);
        }
      }
    }

    for (const route of routes) {
      const params = matchRoute(route, req.method, url.pathname);
      if (!params) continue;
      try {
        return await route.handle(req, res, params, url);
      } catch (err) {
        return json(res, 400, { ok: false, error: err.message });
      }
    }
    return text(res, 404, 'Not Found');
  });

  return server;
}

export function startWebServer({ configFile, port = 4780, host = '127.0.0.1' } = {}) {
  if (!configFile) throw new Error('缺少配置文件路径');
  const server = createWebServer({ configFile });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
