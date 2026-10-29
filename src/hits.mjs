const MAX_HITS = 5000;
const store = new Map();
let seq = 0;

/** 为命中的日志条目分配短 id，供 log_context 回取。 */
export function recordHit(hit) {
  const id = `h${(++seq).toString(36)}`;
  store.set(id, hit);
  if (store.size > MAX_HITS) store.delete(store.keys().next().value);
  return id;
}

export function getHit(id) {
  return store.get(String(id ?? '').trim());
}

export function hitCount() {
  return store.size;
}
