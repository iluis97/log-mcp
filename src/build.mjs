import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIRS = ['src', 'public', 'bin'];

function walk(dir, out) {
  let items;
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const item of items) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) walk(full, out);
    else if (item.isFile() && /\.(mjs|js|html|css|json)$/.test(item.name) && !item.name.endsWith('.bak')) out.push(full);
  }
  return out;
}

/**
 * 代码指纹：src/ + public/ + bin/ 的内容哈希。
 * 进程启动时算一次（START_BUILD），之后每次请求重算磁盘上的值（diskBuild），
 * 两者不一致就说明「改了代码但没重启」——配置页会把这件事直接显示出来。
 */
export function buildHash() {
  const hash = crypto.createHash('sha1');
  const files = DIRS.flatMap((d) => walk(path.join(PKG_DIR, d), [])).sort();
  for (const file of files) {
    hash.update(path.relative(PKG_DIR, file));
    hash.update(fs.readFileSync(file));
  }
  return hash.digest('hex').slice(0, 8);
}

export const START_BUILD = buildHash();
export const STARTED_AT = new Date().toISOString();

/** 运行中进程的代码指纹 + 磁盘上的最新指纹。 */
export function buildStatus() {
  const diskBuild = buildHash();
  return { build: START_BUILD, diskBuild, startedAt: STARTED_AT, stale: diskBuild !== START_BUILD };
}
