# @dsh-external/dsh-repo-cognigraph — 仓库认知图谱增强层

CodeGraph 的 dsh 原生前端 + 会话痕迹增强层。把"agent 探索代码库"变成"查询认知图谱"：
静态代码图（复用 CodeGraph 产物或内置解析）+ 会话痕迹热图（读/改/错行为统计）+ 雷区注入（带证据链警告）。

**设计立场**：不重复造轮子。解析引擎优先消费 [CodeGraph](https://github.com/codegraph-ai/CodeGraph)
的 D3 JSON export（38 语言 tree-sitter），内置 TS/JS 解析器仅作无 CodeGraph 时的兜底；
真正的差异化是 CodeGraph 没有的会话动态层——它看不到 dsh 的 session log，而本插件把它投影为行为热图。

## 架构

```
模型面工具：cg_query（子图查询） cg_impact（影响分析） cg_trace（行为热图+雷区）
                    │
            CogniGraph 服务（内存图 + JSONL 写前日志持久化）
          ┌─────────┴──────────┐
   静态层（代码图）        动态层（会话痕迹）
   CodeGraph JSON 导入      session/event 订阅
   或内置 TS/JS 解析        read/edit/error 计数
                            错误超阈值 → Trap 节点
                    │
          agent 接近 Trap 文件 → agent.inject() 雷区警告（带 sourceEventSeqs 证据）
                    │
          webServer API（/api/stats、/api/graph）→ client 图谱可视化面板
```

## 性能实验（确定性、可复现）

对比"无图探索"（真实模拟 agent 的 grep + 读文件）与"有图查询"完成同一任务的成本。
无 LLM 参与，结果可复现：`node experiments/benchmark.mjs`（默认读 ~/.dsh/cognigraph/graph.jsonl）。

| 实验 | 场景 | 无图工具调用 | 有图工具调用 | 无图 token | 有图 token |
|---|---|---|---|---|---|
| A. 影响分析 | 改 types.ts 会波及谁 | 162 次 | **1 次** (-99%) | 513,610 | **137** (-100%) |
| B. 依赖查询 | dsh-session 模块子图 | 582 次 | **1 次** (-100%) | 2,203,921 | **28,867** (-99%) |
| C. 符号定位 | collectSessionCallbacks 定义与引用 | 2 次 | **1 次** (-50%) | 12,977 | **52** (-100%) |
| **汇总均值** | | | **-83%** | | **≈-100%** |

实测数据（dsh 仓库，15486 节点 / 25032 边）：
- `cg_impact types.ts` 一次返回 8 个受影响文件（含测试），无图需 grep + 读 161 个文件确认
- `cg_query` 一次返回结构化子图，无图需读 581 个文件
- 与 CodeGraph 社区报告（[工具调用减少 58%](https://dev.to/jovan_chan_9500711396d4e6/codegraph-setup-guide-2026-cut-claude-code-tool-calls-by-58-41ln)、[token 减少 64%](https://dev.to/hiroki-ii-ai/codegraph-the-tool-that-cut-my-claude-code-token-usage-by-64-1k32)）口径一致，本实验为确定性复现，非经验报告

**诚实边界**：实验 C 揭示内置解析器不产生 Calls 边（只解析 import/顶层声明），
"谁调用谁"的精确调用图需 CodeGraph 导入（38 语言 tree-sitter）补齐——这正是不重复造轮子的依据。

## 快速开始

```bash
# 构建（无 bash 环境时手动：junction 链接依赖 + checkout tsc + tsdown）
DSH_CHECKOUT=<checkout> bash scripts/build.sh

# 注入（dsh-super-injector 环境内）
dev_inject_plugin D:/agent/dshWorkSpace/dsh-repo-cognigraph
```

注入即完整生效：三个模型面工具 + 会话痕迹追踪 + 雷区注入 + 图谱面板。

## 配置（cordis.yml 全部可覆盖）

| 字段 | 默认 | 含义 |
|---|---|---|
| `dataDir` | `~/.dsh/cognigraph` | 图数据目录（graph.jsonl 写前日志） |
| `workspace` | `process.cwd()` | 工作区根（静态层扫描与路径归一化基准） |
| `excludeDirs` | node_modules/.git/dist/lib/build/.pnpm/coverage/.dsh | 扫描排除目录 |
| `maxScanFiles` | 3000 | 单次扫描最大文件数 |
| `codegraphExportPath` | `''` | CodeGraph D3 JSON 路径；空则内置解析 |
| `traceEnabled` | `true` | 会话痕迹层开关 |
| `trapErrorThreshold` | 3 | errorCount ≥ 该值升级 Trap；0 关闭 |
| `trapInjectionEnabled` | `true` | 雷区注入开关 |
| `maxInjectionChars` | 400 | 单次注入警告长度上限 |
| `injectionCooldownMs` | 120000 | 同文件注入冷却（防刷屏） |
| `scanOnStart` | `true` | 启动时自动扫描建静态图 |

示例：

```yaml
- id: dsh-repo-cognigraph
  name: '@dsh-external/dsh-repo-cognigraph'
  config:
    workspace: 'D:/agent/DSH/deepseek-harness'
    codegraphExportPath: 'D:/codegraph/export.json'
    trapErrorThreshold: 2
```

## 模型面工具

### cg_query — 子图查询

回答"谁依赖 X / X 依赖谁 / 改 X 涉及哪些文件"。参数：`target`（文件路径或符号名）、
`depth`（默认 2）、`edgeTypes`（默认 Imports+Calls+Contains）、`direction`（默认 both）。
返回带行为统计（readCount/editCount/errorCount）的邻居清单。

### cg_impact — 影响分析

改代码前调用：沿 Imports/Calls/Extends/Contains 反向遍历依赖闭包，返回受影响文件清单。
参数：`target`、`depth`（默认 3）。

### cg_trace — 行为热图与雷区

新任务开始时查认知热点（高频读/改/错文件），遇到报错时查雷区清单。参数：`limit`、
`minReads`、`showTrapsOnly`。

## 雷区注入

当 agent 即将读取/编辑一个历史错误 ≥ `trapErrorThreshold` 的文件时，插件经 `agent.inject()`
向下一请求注入 ≤ `maxInjectionChars` 字符的警告，包含错误次数、最后错误文本、
`sourceEventSeqs` 证据链（指向 session log 原文）。冷却期内不重复注入。

## 数据与隐私

- 只读投影：仅订阅 `session/event` 读取，绝不写 session log
- 持久化：`~/.dsh/cognigraph/graph.jsonl`（节点/边/计数写前日志，退出时全量落盘）
- 路径归一化：绝对路径按工作区剥离为相对路径，与静态层节点统一

## Model Experience

### 模型面工具（三个工具 schema 进入系统提示装配）

#### What the model sees

`cg_query`、`cg_impact`、`cg_trace` 三个工具的 name/description/parameters 经
`ctx.tools.register(defineTool(...))` 注册后，由系统提示装配自动并入模型可见的工具
schema。描述文本即本插件 `src/index.ts` 中 `defineTool` 的 `description` 字段原文。

#### Token effect

零直接 token 消耗：本插件不向系统提示注入任何固定文案。模型调用工具时，输入为
`target`/`depth`/`edgeTypes` 等参数（数十字节），输出为结构化 JSON（节点名 + 行为统计），
每次调用通常 200~800 token，取决于子图大小。

#### KV Cache effect

前缀稳定：工具 schema 在注册后保持不变（`defineTool` 定义即冻结），不会随会话增长
变化，因此不使已有请求前缀失效。雷区注入（`agent.inject()`）产生的警告作为 user 消息
追加在请求尾部，属 append-only 增长，不影响前缀复用。

### 雷区注入（条件性模型可见输入）

#### What the model sees

当模型即将读取/编辑一个历史错误 ≥ `trapErrorThreshold` 的文件时，下一次模型请求携带
注入的警告文本（`[cognigraph] ⚠️ <path> 是已知雷区…` + 错误次数 + 证据 seq）。

#### Token effect

条件性：仅命中 Trap 文件时注入，单次上限 `maxInjectionChars`（默认 400 字符）。

#### KV Cache effect

append-only：注入文本追加在历史尾部，不替换既有请求前缀；冷却期内不重复注入。

## Known Limitations and Deferred Work

- **内置解析器仅覆盖 TS/JS** — import/export/顶层声明；精确调用图（Calls 边）需
  CodeGraph 导入（38 语言 tree-sitter）补齐
- **错误回填为文件名匹配启发式** — `tool/result` 失败事件与 `tool/call` 参数的精确
  配对依赖 dsh 事件流顺序，当前用失败文本中的路径做低噪声匹配
- **静态层不增量更新** — 工作区文件变更后需重载插件（或手动触发扫描）重建；文件系统
  watch 属后续工作
- **决策层（LLM 蒸馏）未实现** — 设计上由生态记忆插件（如 dsh-memory 系）补齐，本插件
  专注结构图 + 行为痕迹
