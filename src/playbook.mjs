/**
 * 排查手册（playbook）：把"怎么排查日志"沉淀成数据，
 * 既给 log_playbook 工具使用，也作为 log-troubleshooting 技能的共同来源。
 */

export const PLAYBOOK = {
  name: 'log-troubleshooting',
  version: 1,
  steps: [
    {
      id: 'locate',
      title: '1. 定位日志在哪',
      tools: ['log_sources'],
      detail:
        '给定服务器与用户时先 log_sources(host,user,probe:true)：返回 OS、docker 容器、运行中 systemd 服务、近 3 天活跃日志文件。'
        + '已有服务映射时 log_sources(service:"<名>") 可直接看路径。定位不到就按"进程名/端口 → /proc/<pid>/cwd → 日志目录"继续找。',
    },
    {
      id: 'first-pass',
      title: '2. 首轮检索（关键词 + 时间范围）',
      tools: ['log_investigate', 'log_search'],
      detail:
        '一次传全部服务的同一个时间窗和同一组关键词，先拿到"哪里最脏"：谁在报错、谁在超时、谁没日志。'
        + '关键词先宽后窄：先用异常类/HTTP 状态/业务动作词，再用具体 message 片段。',
    },
    {
      id: 'adapt',
      title: '3. 让格式自适应（不要手写正则）',
      tools: ['log_investigate', 'log_search', 'log_sources'],
      detail:
        'MCP 会对每个服务抽样打分并缓存：识别时间戳样式（- 或 /、是否带 T/Z、毫秒~微秒）、级别写法（[ERROR] / |ERROR| / ERROR:）、'
        + 'traceId 位置（traceId= / X-Request-Id= / 裸 UUID），自动生成 trace 提取规则。识别结果在返回的"格式"行里，异常时可显式传 format。',
    },
    {
      id: 'cluster',
      title: '4. 聚类，不要罗列',
      tools: ['log_summarize'],
      detail:
        '按 template / exception / logger 分组，看"哪类错误最多、什么时候开始、是否随时间增长"。表格本身就是证据，别把原始日志大段贴给用户。',
    },
    {
      id: 'evidence',
      title: '5. 取关键证据（少量、可引用）',
      tools: ['log_context'],
      detail:
        '每个结论至少一条证据：命中 id + 时间 + 服务 + 原始行（含堆栈前后文）。最多 3~5 条，优先 ERROR/FATAL、首次出现、变更点附近。'
        + '证据必须来自工具返回，不得复述或改写日志内容。',
    },
    {
      id: 'correlate',
      title: '6. 串联请求（有 traceId 时）',
      tools: ['log_trace'],
      detail:
        '用 traceId 前缀串起跨服务时间线，看耗时断层（>1s 会标注）和首个失败点。没有 traceId 就用同一时间窗的关键词对比。',
    },
    {
      id: 'conclude',
      title: '7. 输出结论',
      tools: [],
      detail:
        '固定结构：现象（谁、何时、多严重）→ 证据（id + 原文关键行）→ 根因假设（一条主假设 + 一条备选）→ 未确认点 → 下一步验证/修复建议。'
        + '没有证据的推测必须标注"假设"。若首轮无命中，先报告"时间窗/关键字/路径"哪个假设被否定，再给下一步。',
    },
  ],
  keywords: {
    异常与错误: ['Exception', 'Error', 'Caused by', 'panic', 'fatal', 'stack trace'],
    网络与依赖: ['timeout', 'timed out', 'Connection refused', 'Connection reset', 'unreachable', 'SSLHandshake', 'EOF', '503', '502'],
    数据库与缓存: ['deadlock', 'DuplicatedKey', 'Lock wait timeout', 'Too many connections', 'RedisConnectionFailure', 'connection pool'],
    性能与资源: ['OutOfMemory', 'GC overhead', 'Full GC', 'slow', 'too slow', 'cost=', 'elapsed', 'Queue full', 'RejectedExecution'],
    业务与权限: ['401', '403', 'permission denied', 'token expired', 'invalid signature', 'callback failed'],
    生命周期: ['Started', 'Shutting down', 'Application run failed', 'circuit open', 'retry', 'reconnect'],
  },
  timeWindow: [
    '先 15m：抓当前现象；无命中扩到 2h；确认"什么时候开始"用 24h 基线对比。',
    '日志时间与客户端时钟可能有偏差：跨天/跨时区时用 from/to 显式指定，或先看一条日志的真实时间。',
    '窗口越窄越准，但要用 log_summarize 的时间分桶确认没有漏掉峰值。',
  ],
  evidenceRules: [
    '每条结论 1~3 条证据，证据 = 命中 id + 时间 + 服务 + 关键行（可要求完整堆栈）。',
    '同类错误只留首条 + 最近一条，并给出出现次数。',
    '噪音（心跳、WebSocket 统计、健康检查）不进入证据。',
  ],
};

export function renderPlaybook() {
  const lines = [`排查手册 ${PLAYBOOK.name} v${PLAYBOOK.version}（MCP 内置，供技能与模型共用）`, ''];
  for (const step of PLAYBOOK.steps) {
    lines.push(`${step.title}${step.tools.length ? `　工具: ${step.tools.join(' / ')}` : ''}`);
    lines.push(`  ${step.detail}`);
    lines.push('');
  }
  lines.push('关键词库（先宽后窄，可组合）:');
  for (const [group, words] of Object.entries(PLAYBOOK.keywords)) {
    lines.push(`  ${group}: ${words.join(', ')}`);
  }
  lines.push('', '时间窗策略:');
  for (const t of PLAYBOOK.timeWindow) lines.push(`  - ${t}`);
  lines.push('', '证据规则:');
  for (const r of PLAYBOOK.evidenceRules) lines.push(`  - ${r}`);
  return lines.join('\n');
}
