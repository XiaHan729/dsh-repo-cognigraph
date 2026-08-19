/**
 * CodeGraph D3 JSON 导入器（静态层首选）：读取 CodeGraph 的 export JSON
 * （{nodes:[{id,type,properties}], links:[{source,target,type,properties}]}），
 * 映射为统一图。格式已对照 CodeGraph 源码 crates/codegraph/src/export/json.rs 核实。
 * 兼容性：NodeType/EdgeType 以字符串形式出现（serde Debug 格式），
 * 未知类型映射为 Generic/References，不丢弃数据。
 */

import type { CogniGraph, EdgeType, NodeType } from './graph.ts'

/** CodeGraph export JSON 的一行节点。 */
export interface CodeGraphJsonNode {
  id: number
  type: string
  properties?: Record<string, string | number | boolean | string[] | null>
}

/** CodeGraph export JSON 的一行链接。 */
export interface CodeGraphJsonLink {
  id: number
  source: number
  target: number
  type: string
  properties?: Record<string, string | number | boolean | string[] | null>
}

/** CodeGraph export JSON 根对象。 */
export interface CodeGraphJson {
  nodes: CodeGraphJsonNode[]
  links: CodeGraphJsonLink[]
}

/** CodeGraph NodeType 字符串 → 统一 NodeType。 */
export function mapNodeType(type: string): NodeType {
  switch (type) {
    case 'CodeFile': return 'CodeFile'
    case 'Function': return 'Function'
    case 'Class': return 'Class'
    case 'Module': return 'Module'
    case 'Variable': return 'Variable'
    case 'Type': return 'Type'
    case 'Interface': return 'Interface'
    default: return 'Generic'
  }
}

/** CodeGraph EdgeType 字符串 → 统一 EdgeType。 */
export function mapEdgeType(type: string): EdgeType {
  switch (type) {
    case 'Imports': return 'Imports'
    case 'ImportsFrom': return 'ImportsFrom'
    case 'Contains': return 'Contains'
    case 'Calls': return 'Calls'
    case 'Invokes': return 'Invokes'
    case 'Instantiates': return 'Instantiates'
    case 'Extends': return 'Extends'
    case 'Implements': return 'Implements'
    case 'Uses': return 'Uses'
    case 'Defines': return 'Defines'
    case 'RuntimeCalls': return 'RuntimeCalls'
    default: return 'References'
  }
}

/**
 * 从 CodeGraph export JSON 节点属性中提取可读名称。
 * CodeGraph 属性常见键：name / path / file / signature / kind。
 * @param node - CodeGraph 节点。
 * @returns 名称；无法提取时回退为 "node:<id>"。
 */
export function nodeName(node: CodeGraphJsonNode): string {
  const props = node.properties ?? {}
  const name = props['name'] ?? props['path'] ?? props['file']
  if (typeof name === 'string' && name.length > 0) return name
  return `node:${node.id}`
}

/** 从 CodeGraph 节点属性提取所属文件路径。 */
export function nodeFile(node: CodeGraphJsonNode): string {
  const props = node.properties ?? {}
  const file = props['file'] ?? props['path']
  return typeof file === 'string' ? file : nodeName(node)
}

/** 把 CodeGraph 属性（含 null/数组）过滤为统一图的标量属性。 */
export function sanitizeProperties(props: Record<string, unknown> | undefined): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  if (!props) return out
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value
    } else if (Array.isArray(value)) {
      out[key] = value.filter((v): v is string => typeof v === 'string').join(',')
    }
    // null 与对象值丢弃
  }
  return out
}

/**
 * 将 CodeGraph D3 JSON 导入统一图。
 * 幂等：同名节点/同构边由 CogniGraph 去重。
 * @param graph - 目标统一图。
 * @param data - CodeGraph export JSON。
 * @param seq - 证据 seq（导入动作的会话事件序号；无会话时用 0）。
 * @returns 导入的节点数/边数。
 */
export function importCodeGraphJson(graph: CogniGraph, data: CodeGraphJson, seq: number): { nodes: number; edges: number } {
  // 第一遍：节点。CodeGraph 的 id 是 u64 单调计数，可能与本地 id 冲突，
  // 因此建立 cgId → 本地 id 的映射表。
  const idMap = new Map<number, number>()
  for (const cgNode of data.nodes) {
    const name = nodeName(cgNode)
    const localId = graph.upsertNode(mapNodeType(cgNode.type), name, nodeFile(cgNode), seq, sanitizeProperties(cgNode.properties))
    idMap.set(cgNode.id, localId)
  }

  // 第二遍：边。引用未导入节点的边跳过（CodeGraph 过滤导出可能产生悬挂引用）。
  let edges = 0
  for (const link of data.links) {
    const source = idMap.get(link.source)
    const target = idMap.get(link.target)
    if (source === undefined || target === undefined) continue
    graph.upsertEdge(source, target, mapEdgeType(link.type))
    edges++
  }

  return { nodes: data.nodes.length, edges }
}
