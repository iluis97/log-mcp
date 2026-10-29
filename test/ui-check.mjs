/**
 * 配置页前端的最小 DOM 桩测试：不需要浏览器，验证 app.js 在真实 API 数据下
 * 能渲染、能新增服务、能保存，且不会因为字段/模型变化而炸。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startWebServer } from '../src/web.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.dirname(HERE);
const APP = path.join(PKG, 'public', 'app.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logmcp-ui-'));
const configFile = path.join(dir, 'logmcp.config.json');
fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
fs.writeFileSync(path.join(dir, 'logs', 'app.log'), '2026-10-28 10:00:00.000 INFO  demo | hello\n');
fs.writeFileSync(
  configFile,
  JSON.stringify(
    {
      activeEnv: 'dev-123',
      envs: {
        'dev-123': {
          source: { name: 'local', type: 'file', roots: [path.join(dir, 'logs')], glob: '**/*.log*' },
          services: { app: { glob: '**/*.log*' }, other: { glob: 'other/*.log*' } },
        },
        empty: { services: {} },
      },
    },
    null,
    2,
  ),
);

// ---------- 极简 DOM ----------
class Node {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.className = '';
    this.textContent = '';
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.type = '';
    this.placeholder = '';
    this.dataset = {};
    this.listeners = {};
    this.classList = { toggle: (cls, on) => this._toggle(cls, on) };
  }
  _toggle(cls, on) {
    const set = new Set(this.className.split(/\s+/).filter(Boolean));
    if (on === undefined ? !set.has(cls) : on) set.add(cls);
    else set.delete(cls);
    this.className = [...set].join(' ');
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  fire(type, event = {}) {
    for (const fn of this.listeners[type] ?? []) fn({ target: this, ...event });
  }
  get text() {
    return [this.textContent, ...this.children.map((c) => (c?.text != null ? c.text : ''))].join(' ');
  }
  set innerHTML(v) {
    this.children = [];
    this.textContent = '';
    this._html = v;
  }
}

const ids = new Map();
const document = {
  getElementById(id) {
    if (!ids.has(id)) ids.set(id, new Node());
    return ids.get(id);
  },
  createElement: (tag) => new Node(tag),
  querySelector(sel) {
    const key = `sel:${sel}`;
    if (!ids.has(key)) ids.set(key, new Node());
    return ids.get(key);
  },
};
const timers = [];
const g = {
  document,
  fetch: (...args) => fetch(...args),
  setInterval: () => 0,
  setTimeout: (fn, ms) => {
    timers.push(fn);
    return timers.length;
  },
  clearTimeout: () => {},
  clearInterval: () => {},
  confirm: () => true,
  alert: (msg) => {
    throw new Error(`意外弹出 alert: ${msg}`);
  },
  prompt: () => null,
  console,
};

const server = await startWebServer({ configFile, port: 0 });
const base = `http://127.0.0.1:${server.address().port}`;
const g2 = { ...g, fetch: (url, init) => fetch(String(url).startsWith('http') ? url : base + url, init) };

const code = fs.readFileSync(APP, 'utf8');
new Function(...Object.keys(g2), code)(...Object.values(g2));

// 等 boot 里的异步渲染完成
const flush = async (rounds = 6) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((r) => setTimeout(r, 80));
    for (const fn of timers.splice(0)) await fn();
  }
};
await flush();

try {
  // 标签栏：有 dev-123 + 生效徽标 + 新标签按钮
  const tabs = document.getElementById('tabs');
  const tabText = tabs.children.map((c) => c.text).join('|');
  assert.match(tabText, /dev-123/, '标签名');
  assert.match(tabText, /empty/, '所有标签都列出来');
  assert.doesNotMatch(tabText, /生效/, '没有“生效标签”概念');

  // 源卡片：单源渲染，字段来自 meta（type 下拉 + host/roots 等）
  const sources = document.getElementById('sources');
  assert.equal(sources.children.length, 1, '一个标签只渲染一个源卡片');
  const head = sources.children[0].children[0];
  assert.equal(head.children.length, 4, '源卡片头部：名称 / 类型 / 探测 / 清空');

  // 服务表：两行，表头来自 meta（name/container/glob/format）
  const rows = document.getElementById('service-rows');
  assert.equal(rows.children.length, 2);
  const headRow = document.querySelector('#services thead tr');
  assert.deepEqual(
    headRow.children.slice(0, -1).map((th) => th.textContent.replace(' *', '')),
    ['服务名', '容器', '日志 glob', '格式'],
  );

  // 未配置源的标签：显示空状态 + 「+ 添加日志源」
  const emptyTab = document
    .getElementById('tabs')
    .children.find((c) => c.text.includes('empty') && !c.className.includes('tab-add'));
  emptyTab.fire('click');
  await flush(2);
  const emptyCard = document.getElementById('sources').children[0];
  assert.match(emptyCard.className, /source-empty/);
  assert.match(emptyCard.text, /添加日志源/);
  assert.equal(document.getElementById('service-rows').children.length, 0, '空标签没有服务');

  // 切回 dev-123 再改、保存
  const devTab = document
    .getElementById('tabs')
    .children.find((c) => c.text.includes('dev-123') && !c.className.includes('tab-add'));
  devTab.fire('click');
  await flush(2);

  // 点「+ 新增服务」→ 出现第三行
  document.getElementById('btn-add-service').fire('click');
  assert.equal(document.getElementById('service-rows').children.length, 3, '新增服务后多一行');

  // 名字列改名（模拟用户输入后 blur）
  const firstRow = document.getElementById('service-rows').children[0];
  const nameInput = firstRow.children[0].children[0];
  nameInput.value = 'renamed';
  nameInput.fire('change');

  // 保存：走真实 API，落盘后校验文件结构
  await document.getElementById('btn-save').fire('click');
  await flush();

  const doc = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const env = doc.envs['dev-123'];
  assert.equal(env.sources, undefined, '不再写 sources 数组');
  assert.equal(env.source.name, 'local');
  assert.deepEqual(Object.keys(env.services).sort(), ['other', 'renamed', 'service-1'], '多服务 + 改名 + 新增');
  assert.equal(env.services.renamed.source, undefined, '服务不写 source');
  assert.deepEqual(env.services.renamed, { glob: '**/*.log*' });

  console.log('ui-check 全部通过');
} finally {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
