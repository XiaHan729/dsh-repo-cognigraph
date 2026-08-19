/**
 * 会话痕迹层：订阅 session/event，把 agent 的工具调用（读/写/编辑/搜索）
 * 与错误投影到代码图上，维护 readCount/editCount/errorCount 行为统计。
 * 增量写入，不触碰 session log（只读投影）。错误超阈值自动升级为 Trap 节点。
 */

import type { CogniGraph } from './graph.ts'

/** 一条痕迹记录（供 UI/审计展示）。 */
export interface TraceRecord {
  at: number
  seq: number
  kind: 'read' | 'edit' | 'error'
  path: string
  tool: string
  detail: string | null
}

/** 痕迹层配置。 */
export interface TraceConfig {
  /** errorCount ≥ 该值 → 节点升级为 Trap。 */
  trapErrorThreshold: number
  /** 是否记录详细痕迹（供 UI 面板）。 */
  recordTraces: boolean
}

/** 从工具参数 JSON 中提取 file_path 相关字段。 */
export function extractPathFromArgs(args: unknown): string | null {
  if (typeof args !== 'object' || args === null) return null
  const a = args as Record<string, unknown>
  for (const key of ['file_path', 'path']) {
    const v = a[key]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return null
}

/** 读取类工具（读文件/搜索/图像）。 */
const READ_TOOLS = new Set(['read', 'read_image', 'tool:read', 'fs_read', 'grep', 'fs_grep', 'tool:fs-search'])

/** 编辑类工具（写/编辑）。 */
const EDIT_TOOLS = new Set(['write', 'edit', 'tool:write', 'tool:edit', 'fs_write', 'fs_edit'])

/**
 * 把一次工具调用投影到图上：
 * - 读工具 → 文件节点 readCount++，建 CodeFile 节点 + Traces 边
 * - 写/编辑工具 → editCount++
 * - 失败结果 → errorCount++，超阈值升级 Trap
 * @param graph - 目标图。
 * @param tool - 工具名。
 * @param args - 工具参数（已解析）。
 * @param failed - 该调用是否失败。
 * @param errorText - 失败详情（可选）。
 * @param seq - 会话事件序号（证据链）。
 * @param config - 痕迹层配置。
 * @returns 被触碰的节点 id；无法定位文件时返回 undefined。
 */
export function projectToolCall(
  graph: CogniGraph,
  tool: string,
  args: unknown,
  failed: boolean,
  errorText: string | null,
  seq: number,
  config: TraceConfig,
): number | undefined {
  const path = extractPathFromArgs(args)
  if (!path) return undefined

  const kind = EDIT_TOOLS.has(tool) ? 'edit' : READ_TOOLS.has(tool) ? 'read' : null
  if (kind === null && !failed) return undefined

  // 文件节点（path 规范化：反斜杠统一为斜杠，去前导 ./）
  const norm = normalizePath(path)
  let id = graph.findByName(norm)
  if (id === undefined) {
    id = graph.upsertNode('CodeFile', norm, norm, seq, { language: languageOf(norm) })
  }

  if (failed) {
    graph.incStat(id, 'errorCount', 1, seq, errorText ?? undefined)
    // 升级为 Trap（仅当阈值配置开启且达到阈值）
    const node = graph.getNode(id)
    if (node && node.type !== 'Trap' && config.trapErrorThreshold > 0 && node.stats.errorCount >= config.trapErrorThreshold) {
      node.type = 'Trap'
    }
  } else if (kind === 'read') {
    graph.incStat(id, 'readCount', 1, seq)
  } else if (kind === 'edit') {
    graph.incStat(id, 'editCount', 1, seq)
  }

  return id
}

/** 归一化路径：Windows 反斜杠 → 斜杠，去 ./ 前缀。 */
export function normalizePath(path: string): string {
  let p = path.replace(/\\/g, '/')
  while (p.startsWith('./')) p = p.slice(2)
  return p
}

/** 按扩展名推断语言（展示用）。 */
export function languageOf(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', rs: 'rust', go: 'go', java: 'java', c: 'c', h: 'c',
    cpp: 'cpp', hpp: 'cpp', cs: 'csharp', rb: 'ruby', php: 'php',
    md: 'markdown', json: 'json', yml: 'yaml', yaml: 'yaml', sh: 'shell',
  }
  return map[ext] ?? (ext || 'unknown')
}
