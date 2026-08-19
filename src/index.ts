/**
 * @dsh-external/dsh-repo-cognigraph — 仓库认知图谱增强层（hybrid 形态）。
 *
 * 三层架构：
 *  1. 静态层：CodeGraph D3 JSON 导入（codegraph-import.ts）或内置 TS/JS 解析扫描（scanner.ts）；
 *  2. 动态层：订阅 session/event，把工具调用投影为 read/edit/error 行为热图，错误升级 Trap；
 *  3. 查询面：cg_query（子图查询）/ cg_impact（影响分析）/ cg_trace（行为热图+雷区）三个模型面工具。
 *
 * 设计原则：
 *  - 不重复造轮子：解析引擎优先复用 CodeGraph 产物，内置解析器仅作兜底；
 *  - 只读投影：只订阅 session/event 读取，绝不写 session log；
 *  - 雷区注入：agent 即将触碰 Trap 文件时，经 agent.inject() 注入带证据的警告。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { CogniGraph } from './graph.ts'
import { importCodeGraphJson } from './codegraph-import.ts'
import { scanWorkspace } from './scanner.ts'
import { projectToolCall, normalizePath } from './trace.ts'
import { distill, applyDistilledFact, type DistillConfig, type DistilledFact } from './distill.ts'

/** 会话事件的最小形态（只读投影所需字段；完整类型属于 dsh-session，不在此依赖）。 */
interface TraceEvent {
  type: string
  seq: number
  data?: unknown
}

/** Agent 的最小形态（雷区注入所需字段；完整类型属于 dsh-agent，不在此依赖）。 */
interface TraceAgent {
  inject(message: unknown): void
}

/** LLM 服务最小形态（蒸馏用；完整类型属于 dsh-llm，不在此依赖）。 */
interface DistillLlm {
  stream(options: {
    provider: string
    model: string
    system?: string
    messages: unknown[]
    temperature?: number
    maxTokens?: number
  }): AsyncIterable<{ type: string; text?: string }>
}

type AppContext = Context & {
  tools: {
    register(tool: unknown): unknown
  }
}

/** 插件配置：全部可由 cordis.yml 覆盖，无硬编码 tunable。 */
export interface Config {
  /** 数据目录（缺省 ~/.dsh/cognigraph）。 */
  dataDir: string
  /** 工作区根（缺省 process.cwd()）。 */
  workspace: string
  /** 扫描排除目录。 */
  excludeDirs: string[]
  /** 单次扫描最大文件数。 */
  maxScanFiles: number
  /** CodeGraph D3 JSON 导出路径；空则用内置解析器扫描。 */
  codegraphExportPath: string
  /** 会话痕迹层开关。 */
  traceEnabled: boolean
  /** 错误阈值：≥ 该值升级 Trap。0 关闭升级。 */
  trapErrorThreshold: number
  /** 雷区注入开关（agent 接近 Trap 文件时注入警告）。 */
  trapInjectionEnabled: boolean
  /** 单次注入最大 token 预算（近似字符数）。 */
  maxInjectionChars: number
  /** 同一文件注入冷却（毫秒），防刷屏。 */
  injectionCooldownMs: number
  /** 启动时是否自动扫描工作区建静态图。 */
  scanOnStart: boolean
  /** 决策蒸馏层：是否启用自动蒸馏（LLM）。 */
  distillEnabled: boolean
  /** 自上次蒸馏以来新增 user 消息数 ≥ 该值才触发。 */
  distillMinNewUserMessages: number
  /** 单次蒸馏输入最大字符数。 */
  distillMaxInputChars: number
  /** 蒸馏用 provider；空则复用主模型路由。 */
  distillProvider: string
  /** 蒸馏用 model；空则复用主模型路由。 */
  distillModel: string
  /** 同一会话蒸馏最小间隔（毫秒）。 */
  distillCooldownMs: number
}

/** Schemastery 配置 schema（与 Config 一一对应，带默认值）。 */
export const Config: z<Config> = z.object({
  dataDir: z.string().default(''),
  workspace: z.string().default(''),
  excludeDirs: z.array(z.string()).default(['node_modules', '.git', 'dist', 'lib', 'build', '.pnpm', 'coverage', '.dsh']),
  maxScanFiles: z.number().min(100).max(20000).default(3000),
  codegraphExportPath: z.string().default(''),
  traceEnabled: z.boolean().default(true),
  trapErrorThreshold: z.number().min(0).max(100).default(3),
  trapInjectionEnabled: z.boolean().default(true),
  maxInjectionChars: z.number().min(50).max(4000).default(400),
  injectionCooldownMs: z.number().min(1000).max(3600000).default(120000),
  scanOnStart: z.boolean().default(true),
  distillEnabled: z.boolean().default(false),
  distillMinNewUserMessages: z.number().min(1).max(100).default(6),
  distillMaxInputChars: z.number().min(200).max(20000).default(6000),
  distillProvider: z.string().default(''),
  distillModel: z.string().default(''),
  distillCooldownMs: z.number().min(5000).max(3600000).default(120000),
})

/**
 * 插件名：注入器/装配层按此标识本插件。
 */
export const name = '@dsh-external/dsh-repo-cognigraph'
/**
 * 声明注入的服务：`tools` 是工具注册必需；`agents`/`webServer` 为可选，
 * 经 `ctx.get()` 惰性读取（官方 Optional-services 约定）。
 */
export const inject = ['tools']

/**
 * 插件入口：装配认知图谱（静态层 + 动态层）、注册三个模型面工具与 UI 数据路由。
 * @param ctx - 注册上下文（含 tools 服务；agents/webServer 可选）。
 * @param config - 插件配置（cordis.yml 可全部覆盖）。
 */
export function apply(ctx: AppContext, config: Config): void {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const dataDir = config.dataDir || join(dshHome, 'cognigraph')
  const workspace = config.workspace || process.cwd()
  mkdirSync(dataDir, { recursive: true })

  // ─── 图实例（懒加载：replay/扫描异步执行，apply 立即返回，
  //     避免同步解析 7MB+ 日志/全量扫描仓库阻塞事件循环——热重载时卡死整个 web 进程）───
  const journalPath = join(dataDir, 'graph.jsonl')
  const graph = new CogniGraph(journalPath)
  const graphReady: Promise<void> = (async () => {
    if (existsSync(journalPath)) {
      try {
        const content = readFileSync(journalPath, 'utf8')
        graph.replayIncremental(content)
        ctx.logger?.info?.(`[cognigraph] 重放日志完成：${graph.nodeCount} 节点 / ${graph.edgeCount} 边`)
      } catch (e) {
        ctx.logger?.warn?.(`[cognigraph] 日志重放失败（重建空图）：${String(e)}`)
      }
    }
  })()

  // ─── 静态层：CodeGraph 导入优先，内置扫描兜底（异步执行；幂等 upsert）───
  const buildStaticLayer = (): { source: string; detail: string } => {
    if (config.codegraphExportPath && existsSync(config.codegraphExportPath)) {
      try {
        const data = JSON.parse(readFileSync(config.codegraphExportPath, 'utf8')) as {
          nodes: unknown[]
          links: unknown[]
        }
        const { nodes, edges } = importCodeGraphJson(graph, data as never, 0)
        return { source: 'codegraph', detail: `导入 ${nodes} 节点 / ${edges} 边` }
      } catch (e) {
        ctx.logger?.warn?.(`[cognigraph] CodeGraph 导入失败，回退内置解析：${String(e)}`)
      }
    }
    const result = scanWorkspace(graph, {
      workspace,
      excludeDirs: config.excludeDirs,
      maxFiles: config.maxScanFiles,
    }, 0)
    return { source: 'builtin', detail: `扫描 ${result.files} 文件 / ${result.nodes} 节点 / ${result.edges} 边` }
  }

  if (config.scanOnStart) {
    void graphReady.then(() => {
      // 幂等：静态层节点已存在时跳过全量重扫（热重载/重启不会重复扫描，省同步时间）
      const hasStatic = graph.allNodes().some((n) => n.type === 'CodeFile' || n.type === 'Function')
      if (hasStatic && !config.codegraphExportPath) {
        ctx.logger?.info?.(`[cognigraph] 静态层已存在（${graph.nodeCount} 节点），跳过重扫`)
        return
      }
      const { source, detail } = buildStaticLayer()
      ctx.logger?.info?.(`[cognigraph] 静态层就绪（${source}）：${detail}`)
    }).catch((e) => ctx.logger?.warn?.(`[cognigraph] 静态层构建失败：${String(e)}`))
  }

  // ─── 动态层：session/event 痕迹投影 ───
  const lastInjectedAt = new Map<string, number>()
  // 事件可能早于 replay 完成到达（重载瞬间）；等待就绪后按序处理，
  // 避免"先写新统计、再被旧日志重放覆盖"的双计数。
  let replayWaiter: Promise<void> | null = null
  ctx.on('session/event', (session: { id: string }, event: TraceEvent) => {
    if (!config.traceEnabled) return
    if (event.type !== 'tool/call' && event.type !== 'tool/result') return
    // 首次事件：等待 replay 完成后再开始投影（后续事件不等待，保持同步路径）
    if (replayWaiter === null) {
      replayWaiter = graphReady.catch(() => {})
    }
    void (replayWaiter ?? Promise.resolve()).then(() => {
      try {
        if (event.type === 'tool/call') {
          const { name: tool, arguments: rawArgs } = (event.data ?? {}) as { name: string; arguments: string }
          let args: unknown
          try {
            args = JSON.parse(rawArgs)
          } catch {
            return
          }
          // 绝对路径 → 工作区相对路径（与静态层统一；工作区外路径保留原样）
          if (typeof args === 'object' && args !== null) {
            const a = args as Record<string, unknown>
            for (const key of ['file_path', 'path']) {
              const v = a[key]
              if (typeof v === 'string' && v.length > 0) {
                a[key] = toWorkspaceRelative(v, workspace)
              }
            }
          }
        // 读/写计数：projectToolCall 内部按工具名分类
        const touched = projectToolCall(graph, tool, args, false, null, event.seq, {
          trapErrorThreshold: config.trapErrorThreshold,
          recordTraces: false,
        })
        // 雷区注入：agent 即将读/改 Trap 文件 → inject 警告
        if (config.trapInjectionEnabled && touched !== undefined) {
          const node = graph.getNode(touched)
          if (node && node.stats.errorCount > 0) {
            const now = Date.now()
            const last = lastInjectedAt.get(node.name) ?? 0
            if (now - last >= config.injectionCooldownMs) {
              lastInjectedAt.set(node.name, now)
              const agents = ctx.get('agents') as { get(id: string): TraceAgent | undefined } | undefined
              const agent = agents?.get(session.id)
              if (agent) {
                const warning = [
                  `[cognigraph] ⚠️ ${node.name} 是已知雷区（历史错误 ${node.stats.errorCount} 次，最后：${node.stats.lastErrorText ?? '无记录'}）。`,
                  `证据：会话事件 seq ${node.sourceEventSeqs.join(', ')}。`,
                  '建议：先查看失败上下文或改用已验证的路径，避免重复踩坑。',
                ].join('\n')
                agent.inject(createUserMessage({
                  source: { kind: 'plugin', plugin: name },
                  content: [{ type: 'text', text: warning.slice(0, config.maxInjectionChars) }],
                }))
              }
            }
          }
        }
      } else if (event.type === 'tool/result') {
        const { error } = (event.data ?? {}) as { error?: { name: string; code: string } }
        if (error) {
          // 失败结果：需要回填到对应 tool/call 的参数 —— 从事件流无法直接配对，
          // 此处用失败文本做文件名匹配（低噪声启发式），找不到文件则忽略。
          const text = `${error.name}:${error.code}`
          const match = text.match(/[A-Za-z0-9_./\\-]+\.(ts|tsx|js|jsx|py|rs|go|json|md)/)
          if (match) {
            const path = normalizePath(match[0])
            let id = graph.findByName(path)
            if (id === undefined) id = graph.upsertNode('CodeFile', path, path, event.seq)
            graph.incStat(id, 'errorCount', 1, event.seq, text)
            const node = graph.getNode(id)
            if (node && node.type !== 'Trap' && config.trapErrorThreshold > 0 && node.stats.errorCount >= config.trapErrorThreshold) {
              node.type = 'Trap'
            }
          }
        }
      }
    } catch (e) {
      ctx.logger?.warn?.(`[cognigraph] 痕迹投影失败：${String(e)}`)
    }
    })
  })

  // ─── 决策层：LLM 蒸馏（默认关闭，distillEnabled 开启）───
  // 主模型路由捕获（waterfall 必须 next() 委托）：蒸馏无配置路由时复用主模型。
  let lastRoute: { provider: string; model: string } | null = null
  ctx.on('llm/stream', ((options: { provider: string; model: string }, next: () => unknown) => {
    lastRoute = { provider: options.provider, model: options.model }
    return next()
  }) as never)
  const distillConfig: DistillConfig = {
    enabled: config.distillEnabled,
    minNewUserMessages: config.distillMinNewUserMessages,
    maxInputChars: config.distillMaxInputChars,
    provider: config.distillProvider,
    model: config.distillModel,
    cooldownMs: config.distillCooldownMs,
  }
  // 每会话的消息投影缓冲（只留文本，供蒸馏输入；上限防内存膨胀）
  const distillBuffers = new Map<string, { messages: { role: string; content: unknown }[]; lastDistillAt: number }>()
  const MAX_BUFFER_MESSAGES = 400
  ctx.on('session/event', (session: { id: string }, event: TraceEvent) => {
    if (!config.distillEnabled) return
    if (event.type !== 'user/message' && event.type !== 'assistant/message') return
    try {
      const buf = distillBuffers.get(session.id) ?? { messages: [], lastDistillAt: 0 }
      const data = (event.data ?? {}) as { message?: { content: unknown } }
      if (data.message) {
        buf.messages.push({ role: event.type === 'user/message' ? 'user' : 'assistant', content: data.message.content })
        if (buf.messages.length > MAX_BUFFER_MESSAGES) buf.messages.splice(0, buf.messages.length - MAX_BUFFER_MESSAGES)
      }
      distillBuffers.set(session.id, buf)
    } catch {
      // 投影失败不影响会话
    }
  })
  // turn/end 时检查是否该蒸馏（dsh 扩展事件，经宽松 ctx 注册）
  ;(ctx as unknown as { on(event: string, listener: (...args: any[]) => void): unknown }).on('turn/end', (session: { id: string }) => {
    if (!config.distillEnabled) return
    const buf = distillBuffers.get(session.id)
    if (!buf) return
    const now = Date.now()
    if (now - buf.lastDistillAt < distillConfig.cooldownMs) return
    const userCount = buf.messages.filter((m) => m.role === 'user').length
    if (userCount < distillConfig.minNewUserMessages) return
    buf.lastDistillAt = now
    void (async () => {
      const llm = ctx.get('llm') as DistillLlm | undefined
      if (!llm) {
        ctx.logger?.warn?.('[cognigraph] 蒸馏跳过：llm 服务不可用')
        return
      }
      const result = await distill(graph, llm, buf.messages, distillConfig, lastRoute, 0)
      if (result.error) {
        ctx.logger?.info?.(`[cognigraph] 蒸馏：${result.error}`)
      } else if (result.extracted > 0) {
        ctx.logger?.info?.(`[cognigraph] 蒸馏完成：提取 ${result.extracted} 条决策`)
        // 蒸馏产物落盘（journal 已含节点/边；此处强制 flush 防退出丢数据）
        void graph.appendJournal(graph.exportJournal()).catch(() => {})
      }
    })().catch((e) => ctx.logger?.warn?.(`[cognigraph] 蒸馏失败：${String(e)}`))
  })

  // ─── 模型面工具 ───
  ctx.tools.register(defineTool({
    name: 'cg_query',
    description: [
      '查询仓库认知图谱的子图：从指定文件/符号出发，沿依赖边遍历，返回带行为统计的邻居清单。',
      '用途：回答"谁依赖 X / X 依赖谁 / 改 X 涉及哪些文件"这类结构问题，避免逐个读文件猜关系。',
      '行为统计：readCount=agent 历史读取次数，editCount=历史编辑次数，errorCount=历史错误次数。',
    ].join(' '),
    parameters: {
      target: {
        type: 'string',
        required: true,
        description: '起点：文件路径（如 packages/core/session/src/index.ts）或符号名（如 Session.append）。',
      },
      depth: { type: 'integer', description: '遍历深度，默认 2。' },
      edgeTypes: {
        type: 'array',
        items: { type: 'string', enum: ['Imports', 'Calls', 'Contains', 'Extends', 'References'] },
        description: '沿哪些边遍历；缺省为 Imports+Calls+Contains。',
      },
      direction: { type: 'string', enum: ['out', 'in', 'both'], description: '遍历方向，默认 both。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean', required: true },
          nodes: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                type: { type: 'string', required: true },
                readCount: { type: 'integer', required: true },
                editCount: { type: 'integer', required: true },
                errorCount: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.found
          ? `子图查询：${value.nodes.length} 个节点\n${value.nodes.map((n) => `- ${n.name} (${n.type}, 读${n.readCount}/改${n.editCount}/错${n.errorCount})`).join('\n')}`
          : '未找到该目标，图谱中尚无此文件/符号（可尝试内置扫描或 CodeGraph 导入）。',
      }],
    },
    execute(args, exec) {
      const target = String(args.target).trim()
      let id = graph.findByName(target)
      if (id === undefined) {
        // 宽松匹配：文件路径末尾片段
        const norm = normalizePath(target)
        id = graph.allNodes().find((n) => n.name === norm || n.name.endsWith('/' + norm))?.id
      }
      if (id === undefined) {
        return Promise.resolve({ found: false, nodes: [] })
      }
      const edgeTypes = (args.edgeTypes as string[] | undefined) ?? ['Imports', 'Calls', 'Contains']
      const depth = typeof args.depth === 'number' ? Math.max(0, Math.min(6, args.depth)) : 2
      const direction = (args.direction as 'out' | 'in' | 'both' | undefined) ?? 'both'
      const nodes = graph.neighbors(id, edgeTypes as never, depth, direction)
      return Promise.resolve({
        found: true,
        nodes: nodes.slice(0, 60).map((n) => ({
          name: n.name,
          type: n.type,
          readCount: n.stats.readCount,
          editCount: n.stats.editCount,
          errorCount: n.stats.errorCount,
        })),
      })
    },
    presentCall: (args) => ({ card: 'generic', title: '查询认知图谱', kind: 'other', rawInput: args.target }),
  }))

  ctx.tools.register(defineTool({
    name: 'cg_impact',
    description: [
      '影响分析：计算"修改/删除目标后，谁会被波及"。',
      '沿 Imports/Calls/Extends 边反向遍历依赖闭包，返回按依赖距离排序的受影响文件清单。',
      '改代码前调用一次，比逐个搜索引用更省 token 且不漏。',
    ].join(' '),
    parameters: {
      target: {
        type: 'string',
        required: true,
        description: '要修改的文件路径或符号名。',
      },
      depth: { type: 'integer', description: '影响传播深度，默认 3。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean', required: true },
          affected: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                type: { type: 'string', required: true },
                errorCount: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.found
          ? `影响分析：${value.affected.length} 个依赖者\n${value.affected.map((n) => `- ${n.name} (${n.type}${n.errorCount > 0 ? ', 雷区!' : ''})`).join('\n')}`
          : '未找到该目标。',
      }],
    },
    execute(args) {
      const target = String(args.target).trim()
      let id = graph.findByName(target)
      if (id === undefined) {
        const norm = normalizePath(target)
        id = graph.allNodes().find((n) => n.name === norm || n.name.endsWith('/' + norm))?.id
      }
      if (id === undefined) return Promise.resolve({ found: false, affected: [] })
      const depth = typeof args.depth === 'number' ? Math.max(1, Math.min(8, args.depth)) : 3
      const affected = graph.dependents(id, ['Imports', 'Calls', 'Extends', 'Contains'], depth)
      return Promise.resolve({
        found: true,
        affected: affected.slice(0, 60).map((n) => ({
          name: n.name,
          type: n.type,
          errorCount: n.stats.errorCount,
        })),
      })
    },
    presentCall: (args) => ({ card: 'generic', title: '影响分析', kind: 'other', rawInput: args.target }),
  }))

  ctx.tools.register(defineTool({
    name: 'cg_trace',
    description: [
      '行为热图与雷区：查询仓库中被 agent 高频读取/编辑/出错的"认知热点"，以及历史错误超阈值的雷区文件。',
      '用途：① 新任务开始时快速了解哪些文件是热点（可能值得预读）；② 遇到报错时查看雷区清单，避免重复踩坑。',
    ].join(' '),
    parameters: {
      limit: { type: 'integer', description: '返回条数上限，默认 20。' },
      minReads: { type: 'integer', description: '只返回读取次数 ≥ 该值的文件，默认 0。' },
      showTrapsOnly: { type: 'boolean', description: '只返回雷区（错误>0 的文件），默认 false。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hot: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                readCount: { type: 'integer', required: true },
                editCount: { type: 'integer', required: true },
                errorCount: { type: 'integer', required: true },
              },
            },
          },
          traps: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                errorCount: { type: 'integer', required: true },
                lastError: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `热点文件（读/改/错）：${value.hot.length} 个`,
          ...value.hot.map((n) => `- ${n.name} (读${n.readCount}/改${n.editCount}/错${n.errorCount})`),
          `雷区（历史错误）：${value.traps.length} 个`,
          ...value.traps.map((n) => `- ${n.name} (错${n.errorCount}: ${n.lastError})`),
        ].join('\n'),
      }],
    },
    execute(args) {
      const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(100, args.limit)) : 20
      const minReads = typeof args.minReads === 'number' ? Math.max(0, args.minReads) : 0
      const showTrapsOnly = args.showTrapsOnly === true
      const hot = showTrapsOnly ? [] : graph.hotNodes(limit, minReads)
      const traps = graph.traps().slice(0, limit).map((n) => ({
        name: n.name,
        errorCount: n.stats.errorCount,
        lastError: n.stats.lastErrorText ?? '无记录',
      }))
      return Promise.resolve({
        hot: hot.map((n) => ({
          name: n.name,
          readCount: n.stats.readCount,
          editCount: n.stats.editCount,
          errorCount: n.stats.errorCount,
        })),
        traps,
      })
    },
    presentCall: (args) => ({ card: 'generic', title: '行为热图与雷区', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'cg_learn',
    description: [
      '把一条值得长期记住的工程知识存档进认知图谱：架构决策（为什么这样设计）、',
      '踩坑教训（什么导致了失败）、仓库约定（本仓库的特殊规矩）。',
      '用法：任务中产生了这类知识时主动调用——自动蒸馏不可靠的场景，手动存档是零成本兜底。',
      '存档后，改到相关文件时图谱会召回这条知识。',
    ].join(' '),
    parameters: {
      kind: {
        type: 'string',
        required: true,
        enum: ['decision', 'trap', 'habit'],
        description: '知识类型：decision=架构决策，trap=踩坑教训，habit=仓库约定。',
      },
      topic: {
        type: 'string',
        required: true,
        description: '一句话主题（≤40 字），如"session 获取必须用 withInitiator"。',
      },
      conclusion: {
        type: 'string',
        required: true,
        description: '结论正文（≤200 字），说明为什么/怎么做。',
      },
      files: {
        type: 'array',
        items: { type: 'string' },
        description: '相关文件路径列表（相对工作区）；不确定可省略。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          stored: { type: 'boolean', required: true },
          linkedFiles: {
            type: 'array',
            required: true,
            items: { type: 'string' },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.stored
          ? `已存档决策，关联 ${value.linkedFiles.length} 个文件：${value.linkedFiles.join(', ') || '（未命中，仅主题可检索）'}`
          : '存档失败。',
      }],
    },
    execute(args, exec) {
      const fact: DistilledFact = {
        kind: args.kind as DistilledFact['kind'],
        topic: String(args.topic).slice(0, 120),
        conclusion: String(args.conclusion).slice(0, 500),
        files: Array.isArray(args.files) ? args.files.map((f) => String(f)) : [],
      }
      const seq = exec.agent?.session.seq ?? 0
      const hitIds = applyDistilledFact(graph, fact, seq)
      const hitNames = hitIds
        .map((id) => graph.getNode(id)?.name)
        .filter((n): n is string => n !== undefined)
      return Promise.resolve({ stored: true, linkedFiles: hitNames })
    },
    presentCall: (args) => ({ card: 'generic', title: '存档决策', kind: 'other', rawInput: args.topic }),
  }))

  // ─── 生命周期：退出时落盘全量日志（等 replay 完成后写，防重载瞬间写出空图）───
  ctx.effect(() => () => {
    void graphReady.then(() => {
      try {
        writeFileSync(journalPath, graph.exportJournal().join('\n') + '\n', 'utf8')
      } catch {
        // 落盘失败不影响退出
      }
    })
  })

  // ─── UI 数据路由（webServer 为可选服务：headless 无 UI，跳过注册）───
  const webServer = ctx.get('webServer') as WebServerLike | undefined
  if (webServer) {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/@dsh-external/dsh-repo-cognigraph/api/stats',
      handler: (_req: NodeRequest, res: NodeResponse) => {
        res.setHeader('content-type', 'application/json')
        const traps = graph.traps().slice(0, 50).map((n) => ({
          name: n.name,
          errorCount: n.stats.errorCount,
          lastError: n.stats.lastErrorText ?? null,
        }))
        const hot = graph.hotNodes(50).map((n) => ({
          name: n.name,
          readCount: n.stats.readCount,
          editCount: n.stats.editCount,
          errorCount: n.stats.errorCount,
        }))
        res.end(JSON.stringify({ nodeCount: graph.nodeCount, edgeCount: graph.edgeCount, hot, traps }))
      },
    }))
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/@dsh-external/dsh-repo-cognigraph/api/graph',
      handler: (_req: NodeRequest, res: NodeResponse) => {
        res.setHeader('content-type', 'application/json')
        const snap = graph.snapshot()
        // 裁剪：只发有边/有统计的节点，控制载荷
        const ids = new Set<number>()
        for (const e of snap.edges) {
          ids.add(e.source)
          ids.add(e.target)
        }
        const nodes = snap.nodes.filter((n) => ids.has(n.id) || n.stats.errorCount > 0 || n.stats.readCount > 0)
          .slice(0, 500)
          .map((n) => ({ id: n.id, name: n.name, type: n.type, readCount: n.stats.readCount, editCount: n.stats.editCount, errorCount: n.stats.errorCount }))
        const idSet = new Set(nodes.map((n) => n.id))
        const edges = snap.edges.filter((e) => idSet.has(e.source) && idSet.has(e.target))
          .slice(0, 2000)
          .map((e) => ({ source: e.source, target: e.target, type: e.type }))
        res.end(JSON.stringify({ nodes, edges }))
      },
    }))
  }

  ctx.logger?.info?.(`[cognigraph] 就绪：${graph.nodeCount} 节点 / ${graph.edgeCount} 边；数据目录 ${dataDir}`)
}

/** webServer 服务的最小形态（完整类型属于 dsh-host-webserver，不在此依赖）。 */
interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: NodeRequest, res: NodeResponse) => void | Promise<void>
  }): () => void
}

/** node:http 请求最小形态。 */
type NodeRequest = import('node:http').IncomingMessage
/** node:http 响应最小形态。 */
type NodeResponse = import('node:http').ServerResponse

/** 绝对路径 → 工作区相对路径（用于痕迹层与静态层的节点名统一）。 */
function toWorkspaceRelative(p: string, workspace: string): string {
  const norm = p.replace(/\\/g, '/')
  const ws = workspace.replace(/\\/g, '/')
  if (norm === ws) return '.'
  if (norm.startsWith(ws + '/')) return norm.slice(ws.length + 1)
  return norm
}
