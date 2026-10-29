import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 配置文件里的「环境标签」（envs）读写。
 *
 * 一个标签 = 一个日志源 + 多个服务（services 不再指向具体的源，因为只有一个）。
 * 唯一事实源就是配置文件本身：这里不缓存任何内容，每次调用都重新读盘，
 * 所以手改 JSON 或改配置页，谁最后写都覆盖成最新内容。
 *
 * 兼容旧格式：
 *   - 没有 envs 时，顶层 source/sources + services 视为一个标签，第一次写盘自动迁移；
 *   - 标签里写的是 sources 数组时，只接受 1 个（只取第一个，多出来的在校验里报错）。
 */

export const ENV_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,40}$/;

export function assertEnvName(name) {
  if (typeof name !== 'string' || !ENV_NAME_RE.test(name)) {
    throw new Error(`标签名非法: ${name}（只能包含字母数字 _ . -，且以字母数字开头，最长 41 字符）`);
  }
  return name;
}

export function readDoc(file) {
  if (!fs.existsSync(file)) return { doc: {}, exists: false, version: 'missing', mtime: null };
  const text = fs.readFileSync(file, 'utf8');
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new Error(`配置文件不是合法 JSON: ${err.message}`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('配置文件根节点必须是对象');
  return { doc, exists: true, version: versionOf(text), mtime: fs.statSync(file).mtimeMs };
}

/** 内容指纹：用来判断"文件被外部改过"，比 mtime 更可靠（编辑器可能保留 mtime）。 */
export function versionOf(text) {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);
}

function legacyName(doc) {
  return typeof doc.activeEnv === 'string' && doc.activeEnv ? doc.activeEnv : typeof doc.defaultEnv === 'string' && doc.defaultEnv ? doc.defaultEnv : 'default';
}

/**
 * 统一视图：{ legacy, envs: { [name]: { source, services } } }
 * 所有标签同时有效——没有「全局生效标签」，选哪个标签是调用时决定的。
 * legacy=true 表示配置还是旧格式（顶层 source/sources），尚未落成 envs。
 */
export function describeEnvs(doc) {
  const raw = doc.envs && typeof doc.envs === 'object' && !Array.isArray(doc.envs) ? doc.envs : null;
  const names = raw ? Object.keys(raw) : [];
  if (!names.length) {
    const name = legacyName(doc);
    return { legacy: true, envs: { [name]: { ...bodyOf(doc), legacy: true } } };
  }
  const envs = {};
  for (const name of names) envs[name] = { ...bodyOf(raw[name]), legacy: false };
  return { legacy: false, envs };
}

/** 从一段配置里抽出单个 source（兼容 sources 数组，取第一个）+ services。 */
function bodyOf(part) {
  const body = part && typeof part === 'object' && !Array.isArray(part) ? part : {};
  const list = Array.isArray(body.sources) ? body.sources : [];
  const source = body.source ?? list[0] ?? null;
  return { source, services: body.services && typeof body.services === 'object' ? body.services : {} };
}

function ensureEnvs(doc) {
  if (!doc.envs || typeof doc.envs !== 'object' || !Object.keys(doc.envs).length) {
    const name = legacyName(doc);
    doc.envs = { [name]: bodyOf(doc) };
    delete doc.sources;
    delete doc.source;
    delete doc.services;
  }
  // 旧字段：全局生效标签已废弃（所有标签同时有效），清掉避免误导
  delete doc.activeEnv;
  delete doc.defaultEnv;
  return doc;
}

export function writeDoc(file, doc) {
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  fs.renameSync(tmp, file);
  return versionOf(text);
}

/** 整标签覆盖写：只替换该标签的 source/services，其它标签与顶层字段原样保留。 */
export function saveEnv(file, name, { source, services } = {}) {
  assertEnvName(name);
  const { doc } = readDoc(file);
  const base = ensureEnvs(doc);
  base.envs[name] = { source: source ?? null, services: services ?? {} };
  const version = writeDoc(file, base);
  return { envs: Object.keys(base.envs), version };
}

export function deleteEnv(file, name) {
  assertEnvName(name);
  const { doc } = readDoc(file);
  if (!doc.envs || !doc.envs[name]) throw new Error(`标签不存在: ${name}`);
  if (Object.keys(doc.envs).length <= 1) throw new Error('至少保留一个环境标签');
  delete doc.envs[name];
  const version = writeDoc(file, doc);
  return { envs: Object.keys(doc.envs), version };
}
