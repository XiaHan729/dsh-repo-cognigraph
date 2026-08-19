# @dsh-external/dsh-repo-cognigraph

给 dsh agent 一张"带脚印的代码地图"：静态代码图（CodeGraph 数据导入或内置 TS/JS 解析）+ 会话痕迹热图（读/改/错行为统计）+ 雷区注入（带证据链警告）+ 决策蒸馏（LLM）。

## 功能

### 模型面工具（4 个）

| 工具 | 功能 |
|---|---|
| `cg_query` | 子图查询：从文件/符号出发沿依赖边遍历，返回带行为统计的邻居清单 |
| `cg_impact` | 影响分析：改 X 会波及谁（反向依赖闭包，含测试文件） |
| `cg_trace` | 行为热图 + 雷区：高频读/改/错文件与历史出错文件 |
| `cg_learn` | 手动存档决策：架构决策 / 踩坑教训 / 仓库约定（零 LLM 成本） |

### 数据层

- **静态代码图**：CodeGraph D3 JSON 导入（38 语言 tree-sitter），或内置 TS/JS 解析器扫描兜底
- **会话痕迹**：订阅 `session/event`，把 agent 的读/改/错投影为节点行为统计，错误超阈值自动升级 Trap 雷区
- **决策节点**：Decision 节点 + Records 边关联相关文件，带 `sourceEventSeqs` 证据链
- **持久化**：`~/.dsh/cognigraph/graph.jsonl`（写前日志，退出全量落盘）

### 雷区注入

agent 即将读取/编辑历史错误 ≥ `trapErrorThreshold` 的文件时，经 `agent.inject()` 注入警告（错误次数 + 最后错误文本 + 证据 seq）。冷却期内不重复注入。

### 决策蒸馏（LLM，默认关闭）

`distillEnabled: true` 开启后，turn/end 时若新增 user 消息 ≥ `distillMinNewUserMessages` 且距上次蒸馏 ≥ `distillCooldownMs`，把最近会话文本送 LLM，提取 `{kind: decision|trap|habit, topic, conclusion, files[]}` JSON，落图为 Decision 节点 + Records 边。输出不可解析时静默跳过。路由缺省复用主模型，可用 `distillProvider`/`distillModel` 指定。

### 图谱面板

`conversation.view` slot：力导向图谱可视化 + 雷区/热点侧栏（数据来自 `/api/stats`、`/api/graph`）。

## 性能实验（确定性、可复现）

对比"无图探索"（真实模拟 agent 的 grep + 读文件）与"有图查询"完成同一任务的成本。
无 LLM 参与，结果可复现：`node experiments/benchmark.mjs`。

| 实验 | 场景 | 无图工具调用 | 有图工具调用 | 无图 token | 有图 token |
|---|---|---|---|---|---|
| A. 影响分析 | 改 types.ts 会波及谁 | 162 次 | **1 次** (-99%) | 513,610 | **137** (-100%) |
| B. 依赖查询 | dsh-session 模块子图 | 582 次 | **1 次** (-100%) | 2,203,921 | **28,867** (-99%) |
| C. 符号定位 | collectSessionCallbacks 定义与引用 | 2 次 | **1 次** (-50%) | 12,977 | **52** (-100%) |
| **汇总均值** | | | **-83%** | | **≈-100%** |

实测数据（dsh 仓库，15486 节点 / 25032 边）：
- `cg_impact types.ts` 一次返回 8 个受影响文件（含测试），无图需 grep + 读 161 个文件确认
- `cg_query` 一次返回结构化子图，无图需读 581 个文件

**诚实边界**：实验 C 揭示内置解析器不产生 Calls 边（只解析 import/顶层声明），"谁调用谁"的精确调用图需 CodeGraph 导入补齐。

## 安装

### 方式 A：从 GitHub 安装（推荐）

```bash
dsh plugin add github:XiaHan729/dsh-repo-cognigraph
```

### 方式 B：网页端安装

1. 启动 dsh Web：`dsh web`
2. 访问 `http://127.0.0.1:3080`
3. 设置 → 插件 → 添加
4. 填入 `github:XiaHan729/dsh-repo-cognigraph`

### 方式 C：本地开发模式

```bash
git clone https://github.com/XiaHan729/dsh-repo-cognigraph.git
cd dsh-repo-cognigraph
pnpm install
DSH_CHECKOUT=<你的 dsh 源码目录> bash scripts/build.sh

# 注入器环境（dsh-super-injector）内运行时注入
dev_inject_plugin <本插件目录>
```

### 验证安装

```bash
dsh plugin list   # 确认 dsh-repo-cognigraph 处于 active
dsh doctor        # 诊断插件加载错误
```

注入即完整生效：四个模型面工具 + 会话痕迹追踪 + 雷区注入 + 决策蒸馏 + 图谱面板。

## 配置（cordis.yml 全部可覆盖）

| 字段 | 默认 | 含义 |
|---|---|---|
| `dataDir` | `~/.dsh/cognigraph` | 图数据目录 |
| `workspace` | `process.cwd()` | 工作区根 |
| `excludeDirs` | node_modules/.git/dist/lib/build/.pnpm/coverage/.dsh | 扫描排除目录 |
| `maxScanFiles` | 3000 | 单次扫描最大文件数 |
| `codegraphExportPath` | `''` | CodeGraph D3 JSON 路径；空则内置解析 |
| `traceEnabled` | `true` | 会话痕迹层开关 |
| `trapErrorThreshold` | 3 | errorCount ≥ 该值升级 Trap；0 关闭 |
| `trapInjectionEnabled` | `true` | 雷区注入开关 |
| `maxInjectionChars` | 400 | 单次注入警告长度上限 |
| `injectionCooldownMs` | 120000 | 同文件注入冷却 |
| `scanOnStart` | `true` | 启动时自动扫描建静态图 |
| `distillEnabled` | `false` | 决策蒸馏层开关（LLM，默认关） |
| `distillMinNewUserMessages` | 6 | 蒸馏触发的最小新增 user 消息数 |
| `distillMaxInputChars` | 6000 | 单次蒸馏输入上限 |
| `distillProvider` / `distillModel` | `''` | 蒸馏路由；空则复用主模型 |
| `distillCooldownMs` | 120000 | 同会话蒸馏最小间隔 |

示例：

```yaml
- id: dsh-repo-cognigraph
  name: '@dsh-external/dsh-repo-cognigraph'
  config:
    workspace: 'D:/agent/DSH/deepseek-harness'
    codegraphExportPath: 'D:/codegraph/export.json'
    trapErrorThreshold: 2
```

## 测试

26 个 vitest 用例：图算法（幂等/去重/BFS/影响闭包/Trap 升级/热图/持久化重放）、CodeGraph 导入（映射/回退/悬挂引用）、内置解析、扫描器、痕迹层、决策蒸馏（JSON 解析容错/尾消息截取/落图挂边）。

## Model Experience

### 模型面工具（四个工具 schema 进入系统提示装配）

#### What the model sees

`cg_query`、`cg_impact`、`cg_trace`、`cg_learn` 四个工具的 name/description/parameters 经
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
- **自动蒸馏依赖 LLM 路由** — 无主模型路由且未配置 `distillProvider`/`distillModel` 时
  蒸馏静默跳过；`cg_learn` 手动存档不受影响（零 LLM）
