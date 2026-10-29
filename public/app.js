/* log-mcp 配置页。
 * 模型：一个「标签」= 一个日志源 + 多个服务。
 * 页面不内置任何环境/源/服务清单，字段与选项全部来自 /api/config 的 meta。 */
(() => {
  const ENV_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,40}$/;

  const state = {
    configFile: '',
    version: '',
    legacy: false,
    envs: {},
    meta: { sourceFields: [], serviceFields: [], formats: [], sourceTypes: ['file', 'ssh', 'docker'] },
    build: null,
    drafts: {}, // name -> { source, services, baseline, dirty, created }
    current: '',
    external: {}, // name -> true：磁盘上的内容比未保存的草稿新
    probe: null,
  };

  const $ = (id) => document.getElementById(id);
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const draftOf = (name) => state.drafts[name];
  const current = () => state.drafts[state.current];

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function option(value, label) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label ?? value;
    return o;
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error(`HTTP ${res.status}`);
    }
    if (!res.ok && !data.errors) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // ---------- 状态同步 ----------

  function serialize(entry) {
    return JSON.stringify({ source: entry.source, services: entry.services });
  }

  function draftFromEnv(name) {
    const env = state.envs[name];
    return {
      source: clone(env?.source ?? null),
      services: clone(env?.services ?? {}),
      baseline: '',
      dirty: false,
    };
  }

  /** 用服务端返回的配置刷新本地状态；未保存的草稿保留，并标记外部修改。 */
  function applyConfig(data) {
    state.configFile = data.configFile;
    state.version = data.version;
    state.legacy = !!data.legacy;
    state.envs = data.envs ?? {};
    state.meta = data.meta ?? state.meta;
    if (data.build) state.build = data.build;

    const names = Object.keys(state.envs);
    for (const name of names) {
      const entry = state.drafts[name];
      if (!entry) {
        state.drafts[name] = draftFromEnv(name);
        state.drafts[name].baseline = serialize(state.drafts[name]);
        continue;
      }
      if (entry.dirty) {
        state.external[name] = true;
        continue;
      }
      const fresh = draftFromEnv(name);
      fresh.baseline = serialize(fresh);
      state.drafts[name] = fresh;
      delete state.external[name];
    }
    for (const name of Object.keys(state.drafts)) {
      if (names.includes(name)) continue;
      if (state.drafts[name].dirty || state.drafts[name].created) continue; // 未保存/新建的标签不能丢
      delete state.drafts[name];
    }
    if (!state.drafts[state.current]) state.current = names[0] ?? '';
  }

  function touch(name = state.current) {
    const entry = draftOf(name);
    if (!entry) return;
    entry.dirty = serialize(entry) !== entry.baseline;
    renderChrome();
    if (name === state.current) scheduleValidate();
  }

  function setStatus(text, sticky = false) {
    const node = $('status');
    node.textContent = text ?? '';
    if (state.statusTimer) clearTimeout(state.statusTimer);
    if (text && !sticky) state.statusTimer = setTimeout(() => (node.textContent = ''), 4000);
  }

  // ---------- 校验 ----------

  let validateTimer = null;
  function scheduleValidate() {
    if (validateTimer) clearTimeout(validateTimer);
    validateTimer = setTimeout(validateNow, 450);
  }

  async function validateNow() {
    const entry = current();
    if (!entry) return;
    try {
      const result = await api('POST', '/api/validate', { source: entry.source, services: entry.services });
      renderIssues(result.errors ?? [], result.warnings ?? []);
    } catch (err) {
      renderIssues([{ scope: '校验', message: err.message }], []);
    }
  }

  function renderIssues(errors, warnings) {
    const card = $('issues-card');
    const list = $('issues');
    list.innerHTML = '';
    if (!errors.length && !warnings.length) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    for (const e of errors) list.appendChild(issueItem('error', e.scope, e.message));
    for (const w of warnings) list.appendChild(issueItem('warn', w.scope, w.message ?? String(w)));
  }

  function issueItem(kind, scope, message) {
    const li = el('li', `issue ${kind}`);
    if (scope) li.appendChild(el('code', null, scope));
    li.appendChild(el('span', null, message));
    return li;
  }

  // ---------- 渲染：顶栏 / 标签 / 底栏 ----------

  function renderChrome() {
    $('config-path').textContent = state.configFile ? `${state.configFile}${state.legacy ? '（旧格式，保存后自动迁移为标签）' : ''}` : '';
    const entry = current();
    $('dirty').hidden = !entry?.dirty;
    $('remote-change').hidden = !(entry && state.external[state.current]);
    const persisted = !!state.envs[state.current];
    $('btn-delete-env').disabled = !persisted || Object.keys(state.envs).length <= 1;
    renderBuild();
    renderTabs();
  }

  /** 页脚代码指纹：build 与磁盘不一致 = 改了代码但没重启，直接报警。 */
  function renderBuild() {
    const node = $('build');
    const b = state.build;
    if (!b) {
      node.textContent = '';
      node.className = 'build';
      return;
    }
    const started = b.startedAt ? new Date(b.startedAt).toLocaleTimeString() : '';
    node.textContent = b.stale
      ? `⚠ 代码已更新（运行中 ${b.build} → 磁盘 ${b.diskBuild}），请重启 npm start`
      : `build ${b.build}${started ? ` · 启动 ${started}` : ''}`;
    node.className = b.stale ? 'build stale' : 'build';
  }

  function renderTabs() {
    const nav = $('tabs');
    nav.innerHTML = '';
    const persisted = Object.keys(state.envs);
    const unsaved = Object.keys(state.drafts).filter((n) => !persisted.includes(n));
    for (const name of [...persisted, ...unsaved]) {
      const btn = el('button', 'tab');
      btn.type = 'button';
      btn.classList.toggle('active', name === state.current);
      btn.classList.toggle('unsaved', !persisted.includes(name));
      btn.appendChild(el('span', 'tab-name', name));
      const count = Object.keys(state.drafts[name]?.services ?? {}).length;
      if (count) btn.appendChild(el('span', 'tab-badge', String(count)));
      if (state.drafts[name]?.dirty) btn.appendChild(el('span', 'tab-dot', '•'));
      btn.addEventListener('click', () => switchEnv(name));
      nav.appendChild(btn);
    }
    const add = el('button', 'tab tab-add', '+ 新标签');
    add.type = 'button';
    add.addEventListener('click', newEnv);
    nav.appendChild(add);
  }

  function switchEnv(name) {
    if (name === state.current) return;
    state.current = name;
    renderAll();
  }

  function renderAll() {
    renderChrome();
    renderSource();
    renderServices();
    renderProbe();
    scheduleValidate();
  }

  // ---------- 渲染：源（一个标签只有一个） ----------

  function renderSource() {
    const wrap = $('sources');
    const entry = current();
    wrap.innerHTML = '';
    if (!entry) return;
    if (!entry.source) {
      const empty = el('div', 'source-empty');
      empty.appendChild(el('p', 'hint', '这个标签还没有日志源。一个标签对应一个源（本地目录 / 远端日志文件 / 远端容器），下面可以挂多个服务。'));
      const btn = el('button', 'primary', '+ 添加日志源');
      btn.type = 'button';
      btn.addEventListener('click', () => {
        entry.source = { name: state.current, type: 'ssh', host: '', user: '' };
        touch();
        renderSource();
        renderServices();
      });
      empty.appendChild(btn);
      wrap.appendChild(empty);
      return;
    }
    wrap.appendChild(sourceCard(entry.source, entry));
  }

  function sourceCard(src, entry) {
    const card = el('article', 'source');
    const type = src.type ?? 'ssh';

    const head = el('div', 'source-head');
    const name = el('input', 'source-name');
    name.value = src.name ?? '';
    name.placeholder = '源名称（默认用标签名）';
    head.appendChild(name);

    const typeSel = el('select', 'source-type');
    for (const t of state.meta.sourceTypes) typeSel.appendChild(option(t, t));
    typeSel.value = type;
    head.appendChild(typeSel);

    const probeBtn = el('button', 'ghost', '探测');
    probeBtn.type = 'button';
    probeBtn.addEventListener('click', probeSource);
    head.appendChild(probeBtn);

    const clearBtn = el('button', 'danger-ghost', '清空');
    clearBtn.type = 'button';
    clearBtn.addEventListener('click', () => {
      if (!confirm('清空这个标签的日志源？服务会暂时不可用。')) return;
      entry.source = null;
      touch();
      renderSource();
      renderServices();
    });
    head.appendChild(clearBtn);
    card.appendChild(head);

    name.addEventListener('input', () => {
      src.name = name.value.trim();
      touch();
    });

    typeSel.addEventListener('change', () => {
      src.type = typeSel.value;
      if (src.type === 'file' && !Array.isArray(src.roots)) src.roots = [];
      if (src.type !== 'file') delete src.roots;
      touch();
      renderSource();
      renderServices();
    });

    const specs = state.meta.sourceFields.filter((f) => f.key !== 'name' && f.key !== 'type');
    const basic = specs.filter((f) => !f.advanced && (!f.appliesTo || f.appliesTo.includes(type)));
    const advanced = specs.filter((f) => f.advanced && (!f.appliesTo || f.appliesTo.includes(type)));

    const grid = el('div', 'field-grid');
    for (const field of basic) grid.appendChild(fieldControl(field, src));
    card.appendChild(grid);

    if (advanced.length) {
      const details = el('details', 'advanced');
      details.appendChild(el('summary', null, '高级'));
      const advGrid = el('div', 'field-grid');
      for (const field of advanced) advGrid.appendChild(fieldControl(field, src));
      details.appendChild(advGrid);
      card.appendChild(details);
    }
    return card;
  }

  function fieldControl(field, obj) {
    const wrap = el('label', 'field');
    wrap.appendChild(el('span', 'field-label', field.label + (field.required ? ' *' : '')));

    let ctrl;
    if (field.type === 'enum') {
      ctrl = el('select');
      for (const v of field.options ?? []) ctrl.appendChild(option(v, v));
      ctrl.value = obj[field.key] ?? field.default ?? field.options?.[0] ?? '';
      ctrl.addEventListener('change', () => {
        obj[field.key] = ctrl.value;
        touch();
      });
    } else if (field.type === 'format') {
      ctrl = el('select');
      ctrl.appendChild(option('', '自动识别'));
      for (const v of state.meta.formats ?? []) ctrl.appendChild(option(v, v));
      ctrl.value = obj[field.key] ?? '';
      ctrl.addEventListener('change', () => {
        setOrDelete(obj, field.key, ctrl.value || undefined);
        touch();
      });
    } else if (field.type === 'list') {
      ctrl = el('input');
      ctrl.value = Array.isArray(obj[field.key]) ? obj[field.key].join(', ') : obj[field.key] ?? '';
      ctrl.placeholder = field.placeholder ?? '';
      ctrl.addEventListener('input', () => {
        const list = ctrl.value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
        setOrDelete(obj, field.key, list.length ? list : undefined);
        touch();
      });
    } else if (field.type === 'number') {
      ctrl = el('input');
      ctrl.type = 'number';
      ctrl.value = obj[field.key] ?? '';
      ctrl.placeholder = field.placeholder ?? '';
      ctrl.addEventListener('input', () => {
        const n = Number(ctrl.value);
        setOrDelete(obj, field.key, ctrl.value !== '' && Number.isFinite(n) ? n : undefined);
        touch();
      });
    } else {
      ctrl = el('input');
      ctrl.value = obj[field.key] ?? '';
      ctrl.placeholder = field.placeholder ?? '';
      ctrl.addEventListener('input', () => {
        setOrDelete(obj, field.key, ctrl.value.trim() === '' ? undefined : ctrl.value.trim());
        touch();
      });
    }
    if (field.required) ctrl.required = true;
    wrap.appendChild(ctrl);
    return wrap;
  }

  function setOrDelete(obj, key, value) {
    if (value === undefined) delete obj[key];
    else obj[key] = value;
  }

  // ---------- 渲染：服务（一个标签可以有多个） ----------

  function renderServices() {
    const entry = current();
    const tbody = $('service-rows');
    tbody.innerHTML = '';
    const services = entry?.services ?? {};
    const keys = Object.keys(services);
    $('service-count').textContent = keys.length ? `(${keys.length})` : '';
    $('service-empty').hidden = keys.length > 0;
    renderServiceHead();
    const sourceType = entry?.source?.type ?? null;
    for (const key of keys) tbody.appendChild(serviceRow(key, services[key], entry, sourceType));
  }

  /** 表头也来自服务端 meta.serviceFields，不写死列名。 */
  function renderServiceHead() {
    const row = document.querySelector('#services thead tr');
    row.innerHTML = '';
    for (const field of state.meta.serviceFields ?? []) {
      row.appendChild(el('th', `col-${field.key}`, field.label + (field.required ? ' *' : '')));
    }
    row.appendChild(el('th', 'col-act'));
  }

  function serviceRow(key, svc, entry, sourceType) {
    const tr = el('tr');
    for (const field of state.meta.serviceFields ?? []) {
      tr.appendChild(serviceCell(field, svc, key, sourceType, entry));
    }
    const actCell = el('td');
    const del = el('button', 'danger-ghost', '删除');
    del.type = 'button';
    del.addEventListener('click', () => {
      delete entry.services[key];
      touch();
      renderServices();
    });
    actCell.appendChild(del);
    tr.appendChild(actCell);
    return tr;
  }

  function serviceCell(field, svc, key, sourceType, entry) {
    const cell = el('td');
    if (field.key === 'name') {
      const input = el('input', 'svc-name');
      input.value = key;
      input.addEventListener('change', () => renameService(key, input.value.trim()));
      cell.appendChild(input);
      return cell;
    }
    if (field.type === 'format') {
      const select = el('select');
      select.appendChild(option('', '自动识别'));
      for (const f of state.meta.formats ?? []) select.appendChild(option(f, f));
      select.value = svc[field.key] ?? '';
      select.addEventListener('change', () => {
        setOrDelete(svc, field.key, select.value || undefined);
        touch();
      });
      cell.appendChild(select);
      return cell;
    }
    const input = el('input');
    input.value = svc[field.key] ?? '';
    input.placeholder = field.placeholder ?? '';
    const irrelevant =
      (field.key === 'container' && sourceType && sourceType !== 'docker') || (field.key === 'glob' && sourceType === 'docker');
    input.classList.toggle('dim', !!irrelevant);
    input.addEventListener('input', () => {
      setOrDelete(svc, field.key, input.value.trim() || undefined);
      touch();
    });
    void entry;
    cell.appendChild(input);
    return cell;
  }

  function renameService(oldKey, newKey) {
    const entry = current();
    if (!entry || !newKey || newKey === oldKey) return;
    let final = newKey;
    for (let n = 2; entry.services[final]; n += 1) final = `${newKey}-${n}`;
    const out = {};
    for (const [k, v] of Object.entries(entry.services)) out[k === oldKey ? final : k] = v;
    entry.services = out;
    touch();
    renderServices();
  }

  function addService() {
    const entry = current();
    if (!entry) return;
    let name = 'service-1';
    for (let i = 2; entry.services[name]; i += 1) name = `service-${i}`;
    entry.services[name] = {};
    touch();
    renderServices();
  }

  function addServiceFor({ name, container, glob }) {
    const entry = current();
    if (!entry) return;
    const base = name || 'service';
    let key = base;
    for (let i = 2; entry.services[key]; i += 1) key = `${base}-${i}`;
    const svc = {};
    if (container) svc.container = container;
    if (glob) svc.glob = glob;
    entry.services[key] = svc;
    touch();
    renderServices();
    setStatus(`已添加服务 ${key}`);
  }

  // ---------- 探测 ----------

  async function probeSource() {
    const src = current()?.source;
    if (!src) return;
    state.probe = { loading: true, detail: '探测中…' };
    renderProbe();
    try {
      const result = await api('POST', '/api/probe', { source: src });
      state.probe = result;
    } catch (err) {
      state.probe = { ok: false, detail: err.message };
    }
    renderProbe();
  }

  function renderProbe() {
    const card = $('probe-card');
    const body = $('probe-body');
    const probe = state.probe;
    body.innerHTML = '';
    if (!probe) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    body.appendChild(el('p', `probe-detail ${probe.loading ? '' : probe.ok ? 'ok' : 'bad'}`, probe.detail ?? ''));

    const docker = probe.discovery?.docker ?? [];
    if (docker.length) {
      body.appendChild(el('h3', null, `容器（${docker.length}）`));
      const list = el('div', 'chips');
      for (const c of docker) {
        const chip = el('button', 'chip');
        chip.type = 'button';
        chip.title = `${c.image ?? ''}\n${c.status ?? ''}`;
        chip.appendChild(el('span', null, c.name));
        chip.appendChild(el('span', 'chip-sub', c.status ?? ''));
        chip.addEventListener('click', () => addServiceFor({ name: c.name, container: c.name }));
        list.appendChild(chip);
      }
      body.appendChild(list);
      body.appendChild(el('p', 'hint', '点容器即添加为服务（container = 容器名）。'));
    }

    const hot = probe.discovery?.hotLogs ?? [];
    if (hot.length) {
      body.appendChild(el('h3', null, `近 3 天活跃日志（${hot.length}）`));
      const list = el('div', 'chips');
      for (const f of hot) {
        const chip = el('button', 'chip');
        chip.type = 'button';
        chip.title = f.file;
        chip.appendChild(el('span', null, f.file.split('/').pop()));
        chip.appendChild(el('span', 'chip-sub', formatBytes(f.size)));
        chip.addEventListener('click', () => addServiceFor({ name: f.file.split('/').pop().replace(/\.log.*$/, ''), glob: f.file }));
        list.appendChild(chip);
      }
      body.appendChild(list);
    }

    const files = probe.files ?? [];
    if (files.length) {
      body.appendChild(el('h3', null, `匹配到的本地文件（${files.length}）`));
      const ul = el('ul', 'filelist');
      for (const f of files) ul.appendChild(el('li', null, `${f.file}  ${formatBytes(f.size)}`));
      body.appendChild(ul);
    }

    if (probe.discovery?.services?.length) {
      body.appendChild(el('p', 'hint', `运行中的 systemd 服务：${probe.discovery.services.slice(0, 12).join(', ')}`));
    }
  }

  function formatBytes(n) {
    if (!n) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i += 1;
    }
    return `${v.toFixed(i ? 1 : 0)} ${units[i]}`;
  }

  // ---------- 标签操作 ----------

  function newEnv() {
    const name = prompt('新标签名（例如 dev-123）：', '');
    if (name == null) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    if (!ENV_NAME_RE.test(trimmed)) {
      alert('标签名只能包含字母数字 _ . -，以字母数字开头，最长 41 字符');
      return;
    }
    if (state.envs[trimmed] || state.drafts[trimmed]) {
      alert('标签已存在');
      return;
    }
    state.drafts[trimmed] = { source: null, services: {}, baseline: '', dirty: false, created: true };
    state.drafts[trimmed].baseline = serialize(state.drafts[trimmed]);
    state.current = trimmed;
    renderAll();
    setStatus(`新标签 ${trimmed}：填好日志源和服务后点「保存」`);
  }

  async function save() {
    const entry = current();
    if (!entry) return;
    if (!ENV_NAME_RE.test(state.current)) {
      setStatus('标签名非法，无法保存');
      return;
    }
    setStatus('保存中…', true);
    try {
      const data = await api('PUT', `/api/envs/${encodeURIComponent(state.current)}`, { source: entry.source, services: entry.services });
      const name = state.current;
      applyConfig(data);
      state.drafts[name] = draftFromEnv(name);
      state.drafts[name].baseline = serialize(state.drafts[name]);
      renderAll();
      renderIssues([], data.warnings ?? []);
      setStatus(`已保存 ${name} → ${state.configFile}`);
    } catch (err) {
      setStatus(`保存失败：${err.message}`);
    }
  }

  async function removeEnv() {
    const name = state.current;
    if (!confirm(`删除标签 ${name}？配置文件里该标签的源和服务会一起删除。`)) return;
    try {
      const data = await api('DELETE', `/api/envs/${encodeURIComponent(name)}`);
      delete state.drafts[name];
      state.current = '';
      applyConfig(data);
      renderAll();
      setStatus(`已删除 ${name}`);
    } catch (err) {
      setStatus(`删除失败：${err.message}`);
    }
  }

  async function reload() {
    const entry = current();
    if (entry?.dirty && !confirm('当前标签有未保存的修改，重新加载会丢弃它们。继续？')) return;
    const data = await api('GET', '/api/config');
    applyConfig(data);
    if (state.current && draftOf(state.current)) {
      const fresh = draftFromEnv(state.current);
      fresh.baseline = serialize(fresh);
      state.drafts[state.current] = fresh;
      delete state.external[state.current];
    }
    renderAll();
    setStatus('已从配置文件重新加载');
  }

  // ---------- 外部改动轮询 ----------

  async function poll() {
    if (!state.version) return;
    try {
      const data = await api('GET', `/api/config?since=${encodeURIComponent(state.version)}`);
      if (data.unchanged) {
        if (data.build) {
          state.build = data.build;
          renderBuild();
        }
        return;
      }
      applyConfig(data);
      renderAll();
      setStatus('配置文件已被外部修改，已同步');
    } catch {
      /* 轮询失败静默重试 */
    }
  }

  // ---------- 启动 ----------

  function bind() {
    $('btn-save').addEventListener('click', save);
    $('btn-reload').addEventListener('click', reload);
    $('btn-delete-env').addEventListener('click', removeEnv);
    $('btn-add-service').addEventListener('click', addService);
    $('btn-close-probe').addEventListener('click', () => {
      state.probe = null;
      renderProbe();
    });
  }

  async function boot() {
    bind();
    try {
      const data = await api('GET', '/api/config');
      applyConfig(data);
      if (!state.current) {
        state.drafts.default = { source: null, services: {}, baseline: '', dirty: false, created: true };
        state.drafts.default.baseline = serialize(state.drafts.default);
        state.current = 'default';
      }
      renderAll();
      setStatus('配置页只读写本地配置文件，保存后 MCP 热加载即刻生效');
    } catch (err) {
      setStatus(`加载失败：${err.message}`, true);
    }
    setInterval(poll, 3000);
  }

  boot();
})();
