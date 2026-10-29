import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { loadConfig, resolveConfigPath } from './config.mjs';
import { versionOf } from './envs.mjs';
import { createSessionGuard } from './session.mjs';
import { toolDefs, callTool } from './tools.mjs';

const PROTOCOL_VERSION = '2024-11-05';

/** 服务端指令（MCP initialize.instructions）：客户端会把它放进上下文，相当于随 MCP 下发的技能。 */
const INSTRUCTIONS = `只读日志排查；配置里有多套环境标签时，必须先问用户看哪个环境，再用 log_confirm_env(env, evidence) 确认——未确认的查询会被服务端直接拒绝，换标签试也不行。

硬性规则：
1. 配置里有多个标签时，任何日志查询（log_investigate / log_search / log_summarize / log_trace）都必须先确定数据源：
   先问用户看哪个环境 / 哪台机器（可先调 log_sources() 拿全部标签的全景再问选哪个），
   拿到答复后立刻调用 log_confirm_env(env="<标签>", evidence="用户怎么说")。
2. 不允许自己挑一个标签，也不允许"每个标签都试一遍"去凑结论：
   未确认时一律被拒绝，确认后本会话锁定在该标签，换标签必须重新确认（同样先问用户）。
3. 只有一个标签时无需确认，直接查。
4. 结论必须带证据（命中 id + 时间 + 服务/容器 + 原文行）；先 log_sources 定位，再 log_investigate 首轮，log_context 取堆栈，log_summarize 聚类。
5. 不确定查什么时先调 log_playbook 读排查手册。

未知/概念不清时用 log_sources() 看配置全景，而不是猜。`;

// 注意：instructions 里的行首空白会被客户端保留，这里保持简洁。

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

/**
 * 配置热加载：每次工具调用前比对文件内容指纹。
 * 手改 JSON 或配置页切换标签都立即生效，不需要重启 MCP；改坏了保留上一份可用配置。
 */
function configWatcher(file, { env } = {}) {
  let cache = null;
  return () => {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (cache) {
        process.stderr.write(`[logmcp] 配置文件读取失败，沿用上一份配置: ${err.message}\n`);
        return cache.cfg;
      }
      throw err;
    }
    const version = versionOf(text);
    if (cache && cache.version === version) return cache.cfg;
    try {
      const cfg = loadConfig(file, { env });
      if (cache) process.stderr.write(`[logmcp] 配置已更新，已重新加载（标签: ${cfg.envs.join(',') || '无'}${cfg.env ? `，默认 env=${cfg.env}` : ''}）\n`);
      cache = { version, cfg };
      return cfg;
    } catch (err) {
      if (cache) {
        process.stderr.write(`[logmcp] 配置非法，沿用上一份配置: ${err.message}\n`);
        return cache.cfg;
      }
      throw err;
    }
  };
}

async function handle(getCfg, guard, msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    reply(id, {
      protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'log-mcp', version: '0.1.0' },
      instructions: INSTRUCTIONS,
    });
    return;
  }
  if (method === 'ping') {
    reply(id, {});
    return;
  }
  if (method === 'tools/list') {
    reply(id, { tools: toolDefs });
    return;
  }
  if (method === 'tools/call') {
    const name = params?.name;
    try {
      const text = await callTool(getCfg(), name, params?.arguments ?? {}, guard);
      reply(id, { content: [{ type: 'text', text }], isError: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[logmcp] tool ${name} failed: ${message}\n`);
      reply(id, { content: [{ type: 'text', text: `执行失败: ${message}` }], isError: true });
    }
    return;
  }
  if (id != null) replyError(id, -32601, `Method not found: ${method}`);
}

/**
 * 启动 stdio MCP 循环。stdin 关闭（客户端退出）时 resolve，由调用方决定怎么退出。
 * 日志全部走 stderr，stdout 只留给 JSON-RPC。
 */
export async function startServer({ configFile, env: envOverride } = {}) {
  const configPath = configFile ? path.resolve(configFile) : resolveConfigPath();
  const argv = process.argv.slice(2);
  const envIndex = argv.indexOf('--env');
  const env = envOverride ?? (envIndex >= 0 ? argv[envIndex + 1] : undefined);
  const getCfg = configWatcher(configPath, { env });
  const guard = createSessionGuard();
  const cfg = getCfg();
  const envSummary = cfg.envs.map((n) => {
    const e = cfg.envMap[n];
    const s = e?.sources?.[0];
    const where = !s ? '源缺失' : s.type === 'docker' || s.type === 'ssh' ? `${s.type} ${s.user}@${s.host}` : `file`;
    return `${n}[${where}, ${Object.keys(e?.services ?? {}).length} 服务]`;
  });
  process.stderr.write(`[logmcp] config=${cfg.file}\n`);
  process.stderr.write(`[logmcp] 标签 ${cfg.envs.length} 个（全部同时有效）: ${envSummary.join(' | ') || '(无)'}\n`);
  process.stderr.write(
    `[logmcp] 查日志时必须确定标签（工具参数 env=…）${cfg.env ? `，未指定时默认用 ${cfg.env}` : '；未指定会返回候选列表让模型先确认'}${cfg.envErrors.length ? `；有 ${cfg.envErrors.length} 条配置错误` : ''}\n`,
  );

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      process.stderr.write('[logmcp] 收到非法 JSON 行，已忽略\n');
      return;
    }
    if (msg.id == null && String(msg.method ?? '').startsWith('notifications/')) return;
    handle(getCfg, guard, msg).catch((err) => {
      process.stderr.write(`[logmcp] 处理失败: ${err?.message ?? err}\n`);
      if (msg.id != null) replyError(msg.id, -32603, String(err?.message ?? err));
    });
  });
  return new Promise((resolve) => {
    rl.on('close', () => {
      process.stderr.write('[logmcp] stdin 已关闭，退出\n');
      resolve();
    });
  });
}
