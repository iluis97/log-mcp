# log-mcp · 排查日志 MCP（只读）

面向 **Spring Boot 文本日志** 的排查用 MCP Server：日志在服务器文件里、客户端跑在 Windows、**全程只读**。
核心原则：**在日志旁边算完再返回结论**——过滤下推到远端 `grep/awk`，返回前做条目化、堆栈折叠、模板聚类和 token 预算裁剪。

- 运行时：Node ≥ 20.11，零依赖（手写 stdio JSON-RPC）
- 传输：MCP stdio
- 源类型：`file`（本地目录，含 `.gz` 轮转）/ `ssh`（远端日志文件）/ `docker`（远端容器 stdout，走 `docker logs`）
- 环境标签：一个配置文件可以有多组「标签」（如 `dev-123` / `prod`），**每个标签 = 一个日志源 + 多个服务**。**所有标签同时有效**，不是"切一个生效"；查日志前必须由人确认用哪个数据源，工具参数 `env` 指定（不指定且存在多个标签时，工具会拒绝执行并回候选列表）
- 配置页：`npm start` 打开的本地 HTML 页面，按标签维护「源 + 服务」；页面和手改 JSON 写的是同一个文件
- 写操作：MCP 工具全程只读；只有配置页会写本地配置文件（原子写入 + `.bak` 备份）

## 1. 工具（8 个）

| 工具 | 作用 |
| --- | --- |
| `log_confirm_env` | **先做这一步**：确认本次要查哪个环境标签（多标签时是硬门槛，见下节「会话级数据源锁」） |
| `log_investigate` | **推荐入口**：多服务 + 同一时间窗 + 同一组关键词 → 逐服务定位、自适应格式、检索聚类，返回概况 + 关键证据 + 下一步 |
| `log_playbook` | 内置排查手册（步骤 / 关键词库 / 时间窗策略 / 证据规则），与技能 log-troubleshooting 同源 |
| `log_sources` | 定位：`env` 选标签；多标签不传 `env` 时返回全部标签的全景（源 + 服务），用来和用户确认看哪个；`host,user,probe:true` 可直连任意机器 |
| `log_search` | 时间窗 / 级别 / 关键字 / 正则 / traceId 检索，返回带短 id 的命中行 |
| `log_summarize` | 按 level / logger / template / exception / traceId / service 聚合计数 + 时间分桶 |
| `log_context` | 用命中短 id 回取该条前后完整条目（多行堆栈，超长折叠；docker 源按时间窗重取） |
| `log_trace` | 按 traceId 串联跨服务/跨文件时间线，带 +ms 与 >1s 时间空洞标记；支持 traceId **前缀**匹配 |

返回结果里的 `[h3f]` 是命中短 id，只在本进程内有效（LRU 5000 条），用于 `log_context`。

## 1.1 典型链路（关键词 + 时间 + 服务 + 服务器）

```
env 从哪来：用户说了环境（"看 dev-123"/"测试机"）就直接用；没说就先问一句。
log_sources()                                        # 多标签 → 全部标签全景，先确认数据源
log_sources(env="dev-123", probe=true)               # 确认后：探测该标签那台主机
log_investigate(env="dev-123", services=["b-detect", "c-iot"],
                keywords=["ERROR", "Exception"], last="2h", maxEvidence=3)
log_context(hit="h1")                                # 跟着 hit 走，不用再传 env
log_summarize(env="dev-123", service="b-detect", groupBy=["template","level"], bucket="5m")
log_trace(env="dev-123", traceId="af48810f", service="c-iot")
```

`env` 取值规则：只有一套标签时自动用它（无需确认）；有多套时必须先 `log_confirm_env`，见下节。

每条结论都带 hit id + 时间 + 原文行；噪音（heartbeat / WebSocket 统计）默认不进证据。

## 1.1.1 会话级数据源锁（防止模型「每个标签都试一遍」）

只靠提示词约束不住模型，所以把这条规则做成了**服务端硬约束**（`src/session.mjs`）：

```
① log_search(last="5m")                 → 拒绝：必须先确定用哪个（dev-123 | dev-106）
② log_search(env="dev-123")             → 拒绝：先说 / 先确认，不许换标签重试
③ log_summarize(env="dev-106")          → 拒绝（第 3 次被拒绝：停止尝试，去问用户）
④ log_confirm_env(env="dev-106",
                  evidence="用户说：看 106 那台")   → 通过，本会话锁定 dev-106
⑤ log_search(env="dev-106")             → 正常执行
⑥ log_search(env="dev-123")             → 拒绝：已确认为 dev-106，要换先问用户
```

- **状态只在 MCP 进程内**（一个会话一份），不落盘；重启即清空。
- `pending` 期间所有日志工具（`log_investigate` / `log_search` / `log_summarize` / `log_trace`）一律拒绝，连"换个标签再试"也不行；被拒次数会累加，提示语气随之升级。
- `log_sources`（拿全景）、`log_playbook`（手册）、`log_context`（跟着 hit id）不受限制——它们不下结论。
- `log_confirm_env` 必须带 `evidence`（用户原话/依据），会写一条审计日志到 stderr：`[logmcp][audit] 确认数据源 env=dev-106 evidence="…"`。
- 换环境＝再问一次用户 + 再确认一次；模型无法自己解锁。

此外 `initialize` 返回 `instructions`（MCP 标准字段，pi 会放进系统提示），把同一套规则再讲一遍——相当于**随 MCP 一起下发的技能**，不依赖客户端是否装了某个 skill 文件。

## 1.2 格式自适应（不同服务格式不一致时）

每个目标先抽样 256KB → 对内置格式档案逐个打分（命中率）→ 选最高分且非兜底的档案 → 从样本里学习 traceId 的键名与形态 → 写缓存（`.logmcp-cache.json`，删掉即重新识别）。

| 内置档案 | 形态 |
| --- | --- |
| `spring` | `时间 级别 [pid] --- [线程] logger : 消息` |
| `star-mvc` | `时间 [线程] X-Request-Id=… 级别 logger:行 - 消息` |
| `star-id-first` | `时间 <uuid> [线程] 级别 logger:行 - 消息` |
| `json` | JSON lines（字段名可配置，支持 ISO / 毫秒时间戳） |
| `loose` / `generic` | 兜底：只有时间戳、级别可有可无、`-` 或 `/` 分隔、可带 `T/Z` 微秒 |

新增格式只改配置（`formats`），不改代码。

## 2. 快速开始

```bash
# 一键：MCP 服务（stdio）+ 配置页（HTML）
npm start                 # → 配置页 http://127.0.0.1:4780/，同时 stdio MCP 就绪
npm start -- --open       # 顺便打开浏览器
npm start -- --port 4781 --config ./logmcp.config.json --env dev-123

# Windows 双击：start-logmcp.cmd（等同 npm start -- --open）

# 只起其中之一
npm run start:web          # 只要配置页（Ctrl+C 退出）
npm start -- --no-web      # 只要 MCP，等同 npm run start:mcp
```

- `npm start` 的 stdout 只给 JSON-RPC（MCP 协议），启动信息全部走 stderr，所以直接给 MCP 客户端拉起也不会被污染；stdin 关闭（客户端退出）时连配置页一起收掉。
- 端口被占用会自动顺延（最多 10 个），`--port 0` 表示随机端口。
- 只想手工改配置：`cp logmcp.config.example.json logmcp.config.json` 后编辑，或直接用配置页。

注册到 pi（`~/.pi/agent/mcp.json`）——用 `logmcp.mjs`（纯 MCP）或 `logmcp-start.mjs`（连配置页一起起，推荐）：

```json
{
  "mcpServers": {
    "dbx": { "command": "C:\\Users\\luis97\\.dbx\\bin\\dbx-mcp.exe", "args": [] },
    "logs": {
      "command": "node",
      "args": [
        "F:\\code-work\\github\\skills\\mcps\\log-mcp\\bin\\logmcp-start.mjs",
        "--config", "F:\\code-work\\github\\skills\\mcps\\log-mcp\\logmcp.config.json"
      ]
    }
  }
}
```

配置查找顺序：`--config <file>` → 环境变量 `LOGMCP_CONFIG` → 当前目录 `logmcp.config.json` → 包目录 `logmcp.config.json`。

## 3. 配置字段

```jsonc
{
  "timezone": "Asia/Shanghai",        // 日志时间戳的时区（也用于解释 from/to 与"最近 N 分钟"）
  "defaults": {
    "maxLines": 200,                  // 单次返回条数
    "maxLinesCap": 2000,
    "tokenBudget": 4000,              // 输出 token 预算（按 2.5 字符/token 估算并裁剪）
    "tailBytes": 67108864,            // 每个文件只扫末尾 64MB
    "files": 8,                       // 最多扫描文件数（按 mtime 新→旧）
    "stackLines": 12,                 // 上下文里堆栈保留行数
    "last": "15m",                    // 默认时间窗
    "timeoutMs": 25000                // 单文件读取超时
  },
  "services": {                       // 兼容旧格式：没有 envs 时，顶层这一组算一个标签
    "order": { "source": "prod-app", "glob": "/opt/apps/order/logs/app*.log*" },
    "b-detect": { "source": "b-detect-host", "container": "b-detect" }
  },
  "sources": [ ... ],                // 同上：旧格式兼容，第一次用配置页保存会自动迁到 envs
  "envs": {                          // 多标签：一个标签 = 一个 source + 多个 services；全部同时有效
    "dev-123": {
      "source": {                     // 只能一个；也兼容旧的 sources 数组（长度须为 1）
        "name": "dev-123-host", "type": "docker",
        "host": "10.0.0.22", "user": "root", "port": 22,
        "keyFile": "~/.ssh/id_ed25519",
        "dockerPath": "docker",            // 可省略
        "containers": ["b-detect", "c-iot"]  // 可省略：省略则用 docker ps 的运行中容器
      },
      "services": {                   // 服务不再写 source（本标签只有那一个源）
        "b-detect": { "container": "b-detect" },
        "c-iot": { "container": "c-iot" }
      }
    },
    "prod": {
      "source": {
        "name": "prod-app", "type": "ssh",
        "host": "10.0.0.21", "user": "appuser", "port": 22,
        "keyFile": "~/.ssh/id_ed25519",
        "sshPath": "C:\\Windows\\System32\\OpenSSH\\ssh.exe",   // 可省略
        "allowPaths": ["/opt/apps/**"],                        // 远端路径白名单
        "glob": "/opt/apps/**/logs/app*.log*",
        "tailBytes": 33554432
      },
      "services": {
        "order": { "glob": "/opt/apps/order/logs/app*.log*" },
        "pay": { "glob": "/opt/apps/pay/logs/app*.log*" }
      }
    },
    "local": {
      "source": { "name": "local-dev", "type": "file", "roots": ["F:/logs"], "glob": "**/*.log*", "allowPaths": ["**"] },
      "services": { "demo": { "glob": "demo/**/*.log*" } }
    }
  },
  "traceIdPatterns": ["(?:traceId|trace_id)[\"']?\\s*[=:]\\s*[\"']?([0-9a-zA-Z_-]{8,64})"],
  "noisePatterns": ["(?i)heartbeat"],  // 噪音行：log_summarize 默认不计入（search 仍返回）
  "redact": { "enabled": true, "patterns": ["(?i)sessionid=\\S+"] }
}
```

说明：

- 正则允许写 Java/POSIX 风格的内联 `(?i)`，启动时会校验，写错直接报错而不是排查时才发现。
- `allowPaths` 之外的文件不会被读取；`..` 穿越、符号链接目录不跟随。
- 时区决定 `from/to`、"最近 15 分钟" 与日志时间戳的解释，**保证三者同一时区**。
- 没有「全局生效标签」：`--env` / `LOGMCP_ENV` 只作为调用时的默认值。标签不存在会报错并列出可用标签；配置里残留的旧 `activeEnv` 会被忽略，并在下次保存时清理掉。
- **一个标签只有一个源**：标签写成 `source` 对象；旧格式 `sources` 数组仍可读（长度必须为 1，超过会报错要求拆成多个标签）。
- 服务不再需要 `source` 字段（本标签唯一的源自动套用）；旧配置里若留着会告警并忽略，不影响读取。
- 旧格式（顶层 `services` / `sources`）继续可用，等同于一个标签（名字取 `activeEnv`/`defaultEnv`，否则 `default`）；配置页第一次保存时自动迁移进 `envs`，不会留两份副本。
- 同一份文件、同一份事实源：MCP 每次工具调用前比对内容指纹，手改 JSON 或配置页保存后**自动重载**，无需重启；改坏了会沿用上一份可用配置并打到 stderr。

## 3.1 配置页（`npm start` / `npm run start:web`）

```bash
npm start                                   # MCP + 配置页 → http://127.0.0.1:4780/
npm start -- --web --port 4781 --open       # 只起配置页并打开浏览器
```

- **标签即环境 = 一个源 + 多个服务**：顶部标签栏 = 配置文件里的 `envs`，`+ 新标签` 新建（如 `dev-123`）；同一标签下可以挂任意多个服务（各指向一个容器或一类日志文件）。标签之间互不影响，**没有"设为生效"这一步**——全部同时可用，查日志时才选。
- **不写死**：页面里没有任何环境/源/服务清单，字段、类型、格式选项都来自服务端 `meta`（`src/web.mjs` 的字段元数据），渲染完全由配置驱动。
- **双向同步**：页面每 3 秒比对配置文件指纹。手改 JSON 后页面自动刷新草稿；页面保存后 MCP 侧下一次工具调用即用新配置。多个标签互不覆盖——保存只写当前标签，其它标签与顶层字段（时区、defaults、脱敏规则等）原样保留。
- **草稿与冲突**：每个标签的未保存修改各自保留（标签上带 `•`）；如果这期间文件被外部改过，会提示「配置文件已被外部修改」，由你决定重新加载还是覆盖保存。
- **校验前置**：边改边调 `/api/validate`，逐条列错误（缺 host/user、未配置源、一个标签写了多个源、非法格式名…）和告警（docker 源没配 container、没配 glob、服务里残留 source、非 docker 源配了 container）；不通过不允许保存。
- **探测导入**：源卡片上的「探测」直接连该源，列出运行中容器 / 近 3 天活跃日志文件，点一下就按 `container` 或 `glob` 生成服务。
- **写盘**：原子写入（临时文件 + rename），并保留 `logmcp.config.json.bak`。
- **页脚 build 号**：显示当前进程的代码指纹与启动时间。若显示「⚠ 代码已更新（运行中 xxx → 磁盘 yyy），请重启 npm start」，说明你改了 `src/` 或 `public/` 但后台还是旧进程——配置页里看到的行为也是旧代码的。
- 只监听 `127.0.0.1`，并校验 `Host` 头，防 DNS rebinding；接口只有配置的读写与探测，没有任何命令执行入口。

## 4. docker 源

```
docker logs --since <RFC3339> --until <RFC3339> '<container>' 2>&1
  | LC_ALL=C grep -a -b -i -F -e '<关键字>'     # 可选，命中行 + 偏移
  | LC_ALL=C awk '<条目级时间窗 + 保留堆栈续行 + 行内偏移>'
  | tail -n <scanCap> | head -c <60MB>
```

- 时间窗用配置时区的 RFC3339（`2026-10-28T09:41:00+08:00`）传给 docker，**粗过滤在 daemon 侧**，本地再做条目级精过滤。
- 容器名经过 `^[A-Za-z0-9][A-Za-z0-9_.-]*$` 校验，可再用 `containers` 白名单收敛。
- 容器日志没有字节偏移，`log_context` 改用「命中时间 ± N 秒」重取（`beforeSeconds` / `afterSeconds`，默认 300/600）。
- 支持自定义 logback 格式：`时间 [线程] X-Request-Id=... 级别 logger:行 - 消息`，ANSI 颜色自动剥离，`X-Request-Id` 在没有 `traceId=` 时直接当链路 id 用（`log_trace` 可直接传前缀）。

## 5. SSH 侧做了什么

只有一行管道，全部是固定模板 + 校验参数，**经过 `spawn` 直接执行，不经过本地 shell**：

```
tail -c +<offset> -- <file>
  | LC_ALL=C grep -a -b -i -F -e '<关键字>'      # 命中行 + 字节偏移（无关键字时省略）
  | LC_ALL=C awk '<条目级时间窗 + 保留堆栈续行 + 行内偏移>'
  | tail -n <scanCap>                            # 行数上限（desc 取最近 N 行）
  | head -c <60MB>
```

要点：

- **过滤下推**：只有命中的行跨网络返回，而不是整段日志。
- **条目级时间窗**：awk 只在“时间戳行”上判断是否在窗口内，并保留其后的堆栈续行（否则堆栈会被切断）。
- **偏移保真**：`grep -b`/awk 输出的字节偏移 + 文件 base 偏移 = 绝对偏移，`log_context` 用 `tail -c +N | head -c M` 精确回取。
- 网络/超时/权限错误通过 stderr 回传成明确的工具错误，不返回空结果冒充“没日志”。

## 6. 安全边界

- 只读：MCP 工具没有任何写入、重启、改配置、删除的动作；唯一的写入口是配置页（只写本地配置文件，原子写入 + `.bak` 备份）。
- 无本地 shell 拼接；远端命令字符串只由固定模板 + `shq()` 转义后的参数拼成。
- `glob` 目录部分禁止通配符，字符集白名单（防止把用户输入变成远端代码）。
- 单次扫描：`tailBytes`、`scanCap`、`files`、超时、60MB 输出上限，任一命中即截断并在结果里标注。
- 输出脱敏：内置口令/令牌/手机号/身份证规则，返回前统一替换为 `***`。
- 审计：运行日志只写 stderr，不混进 MCP 结果。

## 7. 已知限制

| 限制 | 说明 / 规避 |
| --- | --- |
| 日志格式 | 支持 Spring Boot 默认 `时间 级别 [pid] --- [线程] logger : 消息`、容器自定义 `时间 [线程] X-Request-Id=... 级别 logger:行 - 消息`、以及宽松兜底；其它 pattern 需调整 `src/parse.mjs` |
| `.gz` 归档不支持 `log_context` | 压缩流没有稳定字节偏移；`log_search` 仍可查 |
| docker 源只能看运行中容器 | `docker ps` 过滤；已停止容器的历史可用 `containers` 白名单直接点名，但 daemon 已回收的日志拿不到 |
| `q` / `regex` 下推只回传命中行 | 堆栈续行不会随行返回，需要时用 `log_context` |
| 时钟 | 时间窗用本机时钟计算，服务器与本机偏差大时用 `from/to` 显式指定 |
| 未做增量索引 | 每次都在 `tailBytes` 窗口内流式扫描；超窗口的历史请调大 `tailBytes` 或缩小时间窗 |
| 无 `log_errors`（新错误/基线对比） | 当前用 `log_summarize(groupBy=["template","level"])` 近似；P1 计划补 |
| 改了代码要重启 | 配置数据（JSON）热加载；但 `src/`、`public/` 的代码改动只在进程启动时生效。配置页页脚会提示 build 不一致，启动脚本在端口被占时也会告诉你占用者的 build |

## 8. 验证

```bash
node test/gen.mjs          # 生成 Spring Boot 样例日志（含堆栈、traceId、gz 轮转）
node test/run.mjs          # 走完整 MCP stdio 协议，逐个调用 5 个工具
node test/remote-check.mjs # 用本地 sh 执行"远端脚本"，校验下推管道/偏移/时间窗/堆栈保留
node test/gen-docker.mjs && node test/docker-check.mjs
                           # 容器自定义格式（ANSI + X-Request-Id）解析 + docker 下推校验
node test/web-check.mjs    # 配置页 API：标签读写/校验/迁移/外部修改感知/MCP 热加载
node test/ui-check.mjs     # 前端渲染（无浏览器）：单源卡片、多服务表、新增/改名/保存落盘
node test/guard-check.mjs  # 会话级数据源锁：未确认拒绝 / 不许换标签试 / 确认后锁定 / 换环境要重新确认
node test/start-check.mjs   # 启动脚本：--web / 双服务共存 / 端口顺延 / stdin 关闭即退出
```

连真实服务器：把 `logmcp.config.json` 里的 host/user 换掉，然后

```bash
node bin/logmcp.mjs --config logmcp.config.json   # 由 MCP 客户端拉起
```

## 9. 配套技能

`operations/log-troubleshooting/SKILL.md`（及 `SKILL.zh-CN.md`）：把「定位 → 首轮检索 → 自适应 → 聚类 → 证据 → 结论」的流程固化给模型；MCP 的 `log_investigate` / `log_playbook` 工具描述与技能互相引用，手册内容同源（`src/playbook.mjs`）。

## 10. 后续

1. `log_errors`：错误模板相对基线的“新增 / 暴涨”判定（排查里最省时间的一步）。
2. `log_compare`：同条件对比两个时间窗 / 两台主机 / 两个版本。
3. 适配器：k8s（`kubectl logs --since`）、Loki、ES。（`docker` 已完成）
4. 配套技能 `operations/log-troubleshooting`：把“症状 → 搜索 → 聚类 → trace → 假设 → 验证”的排查流程固化给模型，MCP 只提供原语。
#   l o g - m c p  
 #   l o g - m c p  
 