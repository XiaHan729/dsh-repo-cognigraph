/**
 * CogniGraph 数据层：统一图模型（静态代码图 + 会话痕迹 + 雷区）与 JSONL 持久化。
 * 节点/边类型对齐 CodeGraph 的 D3 JSON export（NodeType/EdgeType 语义一致），
 * 静态层可由 CodeGraph 导入，动态层（痕迹统计）由本插件自研增量写入。
 */

/** 节点类型：静态（对齐 CodeGraph NodeType）+ 动态（本插件扩展）。 */
export type NodeType =
  | 'CodeFile'
  | 'Function'
  | 'Class'
  | 'Module'
  | 'Variable'
  | 'Type'
  | 'Interface'
  | 'Generic'
  | 'Trap' // 雷区：errorCount 超阈值的文件/符号
  | 'Decision' // 决策（预留：手动存档工具使用）

/** 边类型：静态（对齐 CodeGraph EdgeType）+ 动态（本插件扩展）。 */
export type EdgeType =
  | 'Imports'
  | 'ImportsFrom'
  | 'Contains'
  | 'Calls'
  | 'Invokes'
  | 'Instantiates'
  | 'Extends'
  | 'Implements'
  | 'Uses'
  | 'Defines'
  | 'References'
  | 'RuntimeCalls'
  | 'Traces' // 会话痕迹：agent 曾读取/编辑过该节点
  | 'FallInto' // 落入雷区：agent 操作该节点时曾出错

/** 一个代码/知识节点。 */
export interface GraphNode {
  id: number
  type: NodeType
  /** 文件路径（相对工作区）或符号全名（如 packages/core/session/src/index.ts:Session.append）。 */
  name: string
  /** 所属文件路径（符号节点的归属；文件节点为自身）。 */
  file: string
  /** 行为统计（动态层增量维护）。 */
  stats: {
    readCount: number
    editCount: number
    errorCount: number
    lastTouchedAt: number | null
    lastErrorAt: number | null
    lastErrorText: string | null
  }
  /** 证据链：产生/更新该节点的 session event seq 列表。 */
  sourceEventSeqs: number[]
  /** 可选附加属性（如签名、语言）。 */
  properties: Record<string, string | number | boolean>
}

/** 一条图边。 */
export interface GraphEdge {
  id: number
  source: number
  target: number
  type: EdgeType
  properties: Record<string, string | number | boolean>
}

/** 图快照（用于 UI/导入导出）。 */
export interface GraphSnapshot {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

/** 持久化行（JSONL 一行一条写操作，启动时重放）。 */
type JournalRow =
  | { op: 'node'; node: GraphNode }
  | { op: 'edge'; edge: GraphEdge }
  | { op: 'inc'; id: number; field: 'readCount' | 'editCount' | 'errorCount'; by: number; seq: number; errorText?: string }
  | { op: 'touch'; id: number; at: number; seq: number }

/**
 * 内存图 + JSONL 写前日志。所有变更先落内存再追加日志行；
 * 启动时重放日志重建内存态。重放失败仅清空该行（容错），不阻断启动。
 */
export class CogniGraph {
  private nodes = new Map<number, GraphNode>()
  private edges = new Map<number, GraphEdge>()
  /** name → id 索引（文件与符号按 name 归一化）。 */
  private byName = new Map<string, number>()
  private adjacency = new Map<number, { out: Map<EdgeType, number[]>; in: Map<EdgeType, number[]> }>()
  private nextId = 1
  private journalPath: string
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(journalPath: string) {
    this.journalPath = journalPath
  }

  /** 节点总数。 */
  get nodeCount(): number {
    return this.nodes.size
  }

  /** 边总数。 */
  get edgeCount(): number {
    return this.edges.size
  }

  /** 按 name 查找节点 id（不存在返回 undefined）。 */
  findByName(name: string): number | undefined {
    return this.byName.get(name)
  }

  /** 取节点。 */
  getNode(id: number): GraphNode | undefined {
    return this.nodes.get(id)
  }

  /** 取边。 */
  getEdge(id: number): GraphEdge | undefined {
    return this.edges.get(id)
  }

  /** 节点是否存在。 */
  hasNode(id: number): boolean {
    return this.nodes.has(id)
  }

  /** 全部节点。 */
  allNodes(): GraphNode[] {
    return [...this.nodes.values()]
  }

  /** 全部边。 */
  allEdges(): GraphEdge[] {
    return [...this.edges.values()]
  }

  /**
   * 新增节点（同名已存在则更新类型/属性并返回既有 id）。
   * @returns 节点 id。
   */
  upsertNode(type: NodeType, name: string, file: string, seq: number, properties?: GraphNode['properties']): number {
    const existing = this.byName.get(name)
    if (existing !== undefined) {
      const node = this.nodes.get(existing)!
      if (properties) Object.assign(node.properties, properties)
      if (!node.sourceEventSeqs.includes(seq)) node.sourceEventSeqs.push(seq)
      return existing
    }
    const node: GraphNode = {
      id: this.nextId++,
      type,
      name,
      file,
      stats: { readCount: 0, editCount: 0, errorCount: 0, lastTouchedAt: null, lastErrorAt: null, lastErrorText: null },
      sourceEventSeqs: [seq],
      properties: properties ?? {},
    }
    this.nodes.set(node.id, node)
    this.byName.set(name, node.id)
    this.adjacency.set(node.id, { out: new Map(), in: new Map() })
    this.journal({ op: 'node', node })
    return node.id
  }

  /**
   * 新增边（同 source+target+type 已存在则复用）。
   * @returns 边 id。
   */
  upsertEdge(source: number, target: number, type: EdgeType, properties?: GraphEdge['properties']): number {
    const adj = this.adjacency.get(source)
    if (adj && adj.out.get(type)?.includes(target)) {
      const existing = this.edges.get(this.edgeIdOf(source, target, type))
      if (existing && properties) Object.assign(existing.properties, properties)
      return existing?.id ?? -1
    }
    const edge: GraphEdge = {
      id: this.nextEdgeId(),
      source,
      target,
      type,
      properties: properties ?? {},
    }
    this.edges.set(edge.id, edge)
    const from = this.adjacency.get(source)
    const to = this.adjacency.get(target)
    if (from) {
      const list = from.out.get(type) ?? []
      list.push(target)
      from.out.set(type, list)
    }
    if (to) {
      const list = to.in.get(type) ?? []
      list.push(source)
      to.in.set(type, list)
    }
    this.journal({ op: 'edge', edge })
    return edge.id
  }

  /** 行为计数递增（只对既有节点；不存在则忽略）。 */
  incStat(id: number, field: 'readCount' | 'editCount' | 'errorCount', by: number, seq: number, errorText?: string): void {
    const node = this.nodes.get(id)
    if (!node) return
    node.stats[field] += by
    node.stats.lastTouchedAt = Date.now()
    if (field === 'errorCount' && errorText) {
      node.stats.lastErrorAt = Date.now()
      node.stats.lastErrorText = errorText.slice(0, 200)
    }
    if (!node.sourceEventSeqs.includes(seq)) node.sourceEventSeqs.push(seq)
    this.journal({ op: 'inc', id, field, by, seq, errorText })
  }

  /** 标记最近触碰时间。 */
  touch(id: number, at: number, seq: number): void {
    const node = this.nodes.get(id)
    if (!node) return
    node.stats.lastTouchedAt = at
    this.journal({ op: 'touch', id, at, seq })
  }

  /**
   * BFS 邻居查询：从 start 出发沿指定边类型双向/单向遍历。
   * @returns 访问过的节点列表（含起点），按遍历序。
   */
  neighbors(start: number, edgeTypes: EdgeType[], maxDepth: number, direction: 'out' | 'in' | 'both'): GraphNode[] {
    const seen = new Set<number>([start])
    const result: GraphNode[] = []
    let frontier = [start]
    for (let depth = 0; depth <= maxDepth && frontier.length > 0; depth++) {
      const next: number[] = []
      for (const id of frontier) {
        const node = this.nodes.get(id)
        if (!node) continue
        result.push(node)
        const adj = this.adjacency.get(id)
        if (!adj) continue
        for (const type of edgeTypes) {
          if (direction === 'out' || direction === 'both') {
            for (const t of adj.out.get(type) ?? []) {
              if (!seen.has(t)) { seen.add(t); next.push(t) }
            }
          }
          if (direction === 'in' || direction === 'both') {
            for (const s of adj.in.get(type) ?? []) {
              if (!seen.has(s)) { seen.add(s); next.push(s) }
            }
          }
        }
      }
      frontier = next
    }
    return result
  }

  /**
   * 影响闭包：反向遍历 Calls/Imports 等边，找出所有直接或传递依赖 start 的节点。
   * @returns 依赖者列表（不含 start），按依赖距离升序。
   */
  dependents(start: number, edgeTypes: EdgeType[], maxDepth: number): GraphNode[] {
    const seen = new Set<number>()
    const result: GraphNode[] = []
    let frontier = [start]
    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
      const next: number[] = []
      for (const id of frontier) {
        const adj = this.adjacency.get(id)
        if (!adj) continue
        for (const type of edgeTypes) {
          for (const s of adj.in.get(type) ?? []) {
            if (s === start || seen.has(s)) continue
            seen.add(s)
            result.push(this.nodes.get(s)!)
            next.push(s)
          }
        }
      }
      frontier = next
    }
    return result
  }

  /** 按行为热力排序的节点（read/edit/error 合计权重）。 */
  hotNodes(limit: number, minReads = 0): GraphNode[] {
    const scored = this.allNodes()
      .filter((n) => n.stats.readCount + n.stats.editCount + n.stats.errorCount > 0 && n.stats.readCount >= minReads)
      .map((n) => ({ node: n, score: n.stats.readCount + n.stats.editCount * 3 + n.stats.errorCount * 5 }))
      .sort((a, b) => b.score - a.score)
    return scored.slice(0, limit).map((s) => s.node)
  }

  /** 雷区：errorCount 大于 0 的节点（Trap 类型或错误多次的普通节点）。 */
  traps(): GraphNode[] {
    return this.allNodes().filter((n) => n.stats.errorCount > 0 || n.type === 'Trap')
      .sort((a, b) => b.stats.errorCount - a.stats.errorCount)
  }

  /** 快照（UI/导出用）。 */
  snapshot(): GraphSnapshot {
    return { nodes: this.allNodes(), edges: this.allEdges() }
  }

  /** 重放日志，重建内存态。 */
  replay(lines: string[]): void {
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const row = JSON.parse(line) as JournalRow
        switch (row.op) {
          case 'node':
            this.nodes.set(row.node.id, row.node)
            this.byName.set(row.node.name, row.node.id)
            this.adjacency.set(row.node.id, { out: new Map(), in: new Map() })
            if (row.node.id >= this.nextId) this.nextId = row.node.id + 1
            break
          case 'edge':
            this.edges.set(row.edge.id, row.edge)
            this.link(row.edge.source, row.edge.target, row.edge.type)
            break
          case 'inc': {
            const n = this.nodes.get(row.id)
            if (n) {
              n.stats[row.field] += row.by
              if (row.errorText && row.field === 'errorCount') {
                n.stats.lastErrorAt = n.stats.lastErrorAt ?? Date.now()
                n.stats.lastErrorText = row.errorText
              }
            }
            break
          }
          case 'touch': {
            const n = this.nodes.get(row.id)
            if (n) n.stats.lastTouchedAt = row.at
            break
          }
        }
      } catch {
        // 单行损坏：跳过该行，不影响其余重放
      }
    }
  }

  /** 导出全部日志行（落盘用）。 */
  exportJournal(): string[] {
    // 简化：从内存全量重建（节点+边），幂等可重放
    const rows: JournalRow[] = []
    for (const node of this.allNodes()) rows.push({ op: 'node', node })
    for (const edge of this.allEdges()) rows.push({ op: 'edge', edge })
    return rows.map((r) => JSON.stringify(r))
  }

  /** 写入日志（追加）。串行化避免并发交错。 */
  appendJournal(lines: string[]): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      const { appendFile } = await import('node:fs/promises')
      await appendFile(this.journalPath, lines.map((l) => l + '\n').join(''), 'utf8')
    })
    return this.writeQueue
  }

  private journal(row: JournalRow): void {
    void this.appendJournal([JSON.stringify(row)]).catch(() => { /* 日志失败不阻断内存态 */ })
  }

  private link(source: number, target: number, type: EdgeType): void {
    const from = this.adjacency.get(source)
    const to = this.adjacency.get(target)
    if (from) {
      const list = from.out.get(type) ?? []
      list.push(target)
      from.out.set(type, list)
    }
    if (to) {
      const list = to.in.get(type) ?? []
      list.push(source)
      to.in.set(type, list)
    }
  }

  private nextEdgeId(): number {
    // 边 id 与节点 id 共享单调空间，避免冲突
    let max = 0
    for (const e of this.edges.keys()) if (e > max) max = e
    for (const n of this.nodes.keys()) if (n > max) max = n
    return max + 1
  }

  private edgeIdOf(source: number, target: number, type: EdgeType): number {
    for (const [id, e] of this.edges) {
      if (e.source === source && e.target === target && e.type === type) return id
    }
    return -1
  }
}
