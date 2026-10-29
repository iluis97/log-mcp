import fs from 'node:fs';
import path from 'node:path';

const META = /[*?[]/;

export function hasMeta(p) {
  return META.test(p);
}

/** 把 glob 转成正则（支持 **、*、?、[abc]）。路径统一按 '/' 比较。 */
export function globToRegExp(glob) {
  if (glob === '**') return /^.*$/;
  let re = '^';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i += 2;
        if (glob[i] === '/') {
          re += '(?:.*/)?';
          i += 1;
        } else {
          re += '.*';
        }
        continue;
      }
      re += '[^/]*';
      i += 1;
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      i += 1;
      continue;
    }
    if (c === '[') {
      const j = glob.indexOf(']', i + 1);
      if (j > i) {
        re += glob.slice(i, j + 1);
        i = j + 1;
        continue;
      }
    }
    re += c.replace(/[.+^${}()|\\]/g, '\\$&');
    i += 1;
  }
  return new RegExp(re + '$');
}

export function matchAnyPattern(file, patterns) {
  const normalized = file.replace(/\\/g, '/');
  return patterns.some((p) => globToRegExp(p).test(normalized));
}

/** 取 glob 中第一个通配符之前的目录，作为遍历起点。 */
export function baseDirOf(pattern) {
  const segs = pattern.split('/');
  const literal = [];
  for (const seg of segs) {
    if (hasMeta(seg)) break;
    literal.push(seg);
  }
  const base = literal.join('/');
  return base || (pattern.startsWith('/') ? '/' : '.');
}

async function* walkFiles(dir, depth = 0) {
  if (depth > 8) return;
  let items;
  try {
    items = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const item of items) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      yield* walkFiles(full, depth + 1);
    } else if (item.isFile()) {
      yield full;
    }
  }
}

/** 展开本地 glob：绝对模式直接遍历，相对模式拼到 root 上。 */
export async function expandLocal(root, pattern, limit = 40) {
  const raw = pattern.startsWith('/') || /^[A-Za-z]:[/\\]/.test(pattern) ? pattern : path.join(root, pattern);
  const abs = path.resolve(raw);
  const normalized = abs.replace(/\\/g, '/');

  if (!hasMeta(normalized)) {
    try {
      const st = await fs.promises.stat(abs);
      if (!st.isFile()) return [];
      return [{ file: abs, size: st.size, mtime: st.mtimeMs }];
    } catch {
      return [];
    }
  }

  const regex = globToRegExp(normalized);
  const base = baseDirOf(normalized);
  const out = [];
  for await (const file of walkFiles(path.resolve(base))) {
    if (out.length >= limit) break;
    if (!regex.test(file.replace(/\\/g, '/'))) continue;
    try {
      const st = await fs.promises.stat(file);
      if (st.isFile()) out.push({ file, size: st.size, mtime: st.mtimeMs });
    } catch {
      /* ignore */
    }
  }
  return out;
}
