/**
 * 兼容配置里的 Java/POSIX 风格内联忽略大小写标记 (?i)。
 * JS 的 RegExp 不支持内联标记，这里统一转成 flags。
 */
export function compilePattern(source, flags = '') {
  if (typeof source !== 'string' || !source) throw new Error(`非法正则: ${source}`);
  const inlineCase = source.includes('(?i)');
  const body = source.replace(/\(\?i\)/g, '');
  const set = new Set(flags);
  if (inlineCase) set.add('i');
  return new RegExp(body, [...set].join(''));
}

/** 启动时校验配置中的正则，避免排查时才发现写错。 */
export function validatePattern(source, flags, where) {
  try {
    compilePattern(source, flags);
  } catch (err) {
    throw new Error(`${where} 正则非法: ${source} → ${err.message}`);
  }
}
