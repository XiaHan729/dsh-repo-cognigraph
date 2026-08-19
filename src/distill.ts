/**
 * 决策层：LLM 蒸馏——把会话中沉淀的架构决策/踩坑教训/仓库约定，
 * 提取为结构化 Decision 节点挂到相关文件上，带 sourceEventSeqs 证据链。
 *
 * 设计：
 *  - 触发：turn/end 时若自上次蒸馏以来新增消息 ≥ 阈值，异步蒸馏（省 LLM 调用）
 *  - 输入：最近一段 user/assistant 消息文本（上限字符，防止长会话烧 token）
 *  - 输出：LLM 返回 JSON 数组 [{kind, topic, conclusion, files[]}]，严格解析+容错
 *  - 落图：Decision 节点 + Records 边（→ 命中文件节点）+ sourceEventSeqs 证据
 *  - 手动兜底：cg_learn 工具（agent 主动存，零 LLM 成本）在本模块复用落图逻辑
 */

import type { CogniGraph } from './graph.ts'

/** 蒸馏配置。 */
export interface DistillConfig {
  /** 是否启用自动蒸馏。 */
  enabled: boolean
  /** 自上次蒸馏以来新增 user 消息数 ≥ 该值才触发。 */
  minNewUserMessages: number
  /** 单次蒸馏输入的最大字符数（超长截断，控制 token）。 */
  maxInputChars: number
  /** 蒸馏用的 provider；空则复用主模型路由。 */
  provider: string
  /** 蒸馏用的 model；空则复用主模型路由。 */
  model: string
  /** 同一会话两次蒸馏的最小间隔（毫秒），防并发/刷屏。 */
  cooldownMs: number
}

/** 一条蒸馏出的决策。 */
export interface DistilledFact {
  kind: 'decision' | 'trap' | 'habit'
  /** 一句话主题（节点名）。 */
  topic: string
  /** 结论/教训正文。 */
  conclusion: string
  /** 相关文件路径（相对工作区，宽松匹配）。 */
  files: string[]
}

/** 蒸馏所需的 LLM 最小接口（真实类型属于 dsh-llm，不在此依赖）。 */
export interface DistillLlm {
  stream(options: {
    provider: string
    model: string
    system?: string
    messages: unknown[]
    temperature?: number
    maxTokens?: number
  }): AsyncIterable<{ type: string; text?: string }>
}

/** 蒸馏所需的会话消息最小形态。 */
export interface DistillMessage {
  role: string
  content: unknown
}

/** 提取消息文本（兼容 string 与 content-block 数组两种形态）。 */
function messageText(message: DistillMessage): string {
  if (typeof message.content === 'string') return message.content
  if (Array.isArray(message.content)) {
    return message.content
      .map((block: { type?: string; text?: string }) => (block.type === 'text' ? block.text ?? '' : ''))
      .join('\n')
  }
  return ''
}

/** 从消息列表截取"最近"片段（保留末尾，超长裁头）。 */
export function tailMessages(messages: DistillMessage[], maxChars: number): { text: string; count: number } {
  let text = ''
  let count = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = messageText(messages[i])
    if (text.length + t.length > maxChars) break
    text = (t ? t + '\n' : '') + text
    count++
  }
  return { text, count }
}

/** 解析 LLM 输出的 JSON（容忍 ```json 围栏与前后噪声）。 */
export function parseDistillJson(raw: string): DistilledFact[] | null {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    // 尝试提取第一个 [ ... ] 片段（LLM 常夹带解释文字）
    const start = cleaned.indexOf('[')
    const end = cleaned.lastIndexOf(']')
    if (start === -1 || end <= start) return null
    try {
      parsed = JSON.parse(cleaned.slice(start, end + 1))
    } catch {
      return null
    }
  }
  if (!Array.isArray(parsed)) return null
  const facts: DistilledFact[] = []
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue
    const rec = item as Record<string, unknown>
    const kind = rec['kind']
    const topic = rec['topic']
    const conclusion = rec['conclusion']
    if (typeof topic !== 'string' || topic.length === 0) continue
    if (typeof conclusion !== 'string' || conclusion.length === 0) continue
    const files = Array.isArray(rec['files'])
      ? rec['files'].filter((f): f is string => typeof f === 'string' && f.length > 0)
      : []
    facts.push({
      kind: kind === 'trap' || kind === 'habit' ? kind : 'decision',
      topic: topic.slice(0, 120),
      conclusion: conclusion.slice(0, 500),
      files,
    })
  }
  return facts.length > 0 ? facts : null
}

/**
 * 把蒸馏事实写入图：Decision 节点 + Records 边（命中文件节点）。
 * 未命中任何文件时仍建孤立 Decision 节点（后续 cg_query 可按主题召回）。
 * @param graph - 目标图。
 * @param fact - 蒸馏事实。
 * @param seq - 证据 seq。
 * @returns 命中的文件节点 id 列表。
 */
export function applyDistilledFact(graph: CogniGraph, fact: DistilledFact, seq: number): number[] {
  const name = `decision:${fact.topic}`
  const decisionId = graph.upsertNode('Decision', name, '', seq, {
    kind: fact.kind,
    conclusion: fact.conclusion,
  })
  const hitIds: number[] = []
  for (const file of fact.files) {
    // 宽松匹配：精确名 → 末尾片段
    let id = graph.findByName(file)
    if (id === undefined) {
      const norm = file.replace(/\\/g, '/')
      const candidate = graph.allNodes().find((n) => n.name === norm || n.name.endsWith('/' + norm))
      if (candidate) id = candidate.id
    }
    if (id !== undefined) {
      graph.upsertEdge(decisionId, id, 'Records')
      hitIds.push(id)
    }
  }
  return hitIds
}

/**
 * 执行一次蒸馏：组装 prompt → 调 LLM → 解析 → 落图。
 * @param graph - 目标图。
 * @param llm - LLM 服务最小接口。
 * @param messages - 会话消息列表（已投影）。
 * @param config - 蒸馏配置。
 * @param route - 主模型路由 { provider, model }（config 未指定时复用）。
 * @param seq - 证据 seq（当前会话最后事件序号）。
 * @returns 蒸馏结果统计。
 */
export async function distill(
  graph: CogniGraph,
  llm: DistillLlm,
  messages: DistillMessage[],
  config: DistillConfig,
  route: { provider: string; model: string } | null,
  seq: number,
): Promise<{ extracted: number; applied: number; skipped: boolean; error: string | null }> {
  const provider = config.provider || route?.provider
  const model = config.model || route?.model
  if (!provider || !model) {
    return { extracted: 0, applied: 0, skipped: true, error: '无可用 LLM 路由（未捕获主模型调用且未配置 provider/model）' }
  }

  const { text } = tailMessages(messages, config.maxInputChars)
  if (text.trim().length < 50) {
    return { extracted: 0, applied: 0, skipped: true, error: '最近消息太少，不足以蒸馏' }
  }

  const system = [
    '你是仓库知识蒸馏器。从对话中提取值得长期记住的工程事实：',
    '架构决策（为什么这样设计）、踩坑教训（什么导致了失败）、仓库约定（本仓库的特殊规矩）。',
    '只输出 JSON 数组，每个元素：',
    '{"kind":"decision|trap|habit","topic":"一句话主题≤20字","conclusion":"结论≤100字","files":["相关文件相对路径数组，不确定则空数组"]}',
    '没有值得提取的内容时输出 []。不要输出任何解释文字。',
  ].join('\n')

  let raw = ''
  try {
    const stream = llm.stream({
      provider,
      model,
      system,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: text.slice(0, config.maxInputChars) }],
      }],
      temperature: 0,
      maxTokens: 800,
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') raw += chunk.text
    }
  } catch (e) {
    return { extracted: 0, applied: 0, skipped: false, error: `LLM 调用失败: ${String(e).slice(0, 200)}` }
  }

  const facts = parseDistillJson(raw)
  if (facts === null) {
    return { extracted: 0, applied: 0, skipped: false, error: `LLM 输出无法解析为 JSON（前 100 字符: ${raw.slice(0, 100)}）` }
  }

  let applied = 0
  for (const fact of facts) {
    applyDistilledFact(graph, fact, seq)
    applied++
  }
  return { extracted: facts.length, applied, skipped: false, error: null }
}
