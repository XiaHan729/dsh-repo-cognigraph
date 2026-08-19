#!/usr/bin/env node
/**
 * dsh-repo-cognigraph 性能实验（确定性、可复现）
 *
 * 对比"无图探索"与"有图查询"完成同一任务的成本：
 *  - 工具调用次数（LLM 推理步数的主要成本）
 *  - 文件读取量（token 消耗的主要成本）
 *  - 覆盖完整性（是否有图能一次拿全）
 *
 * 无图路径 = 真实模拟 agent 的探索行为（扫描 import 引用 + 读文件确认）；
 * 有图路径 = 直接调用本插件的图查询（graph.jsonl 真实数据）。
 * 无 LLM 参与，结果确定性可复现——比 CodeGraph 社区的经验报告严谨。
 *
 * 用法：node experiments/benchmark.mjs [--graph <path>] [--workspace <dir>]
 * 默认：~/.dsh/cognigraph/graph.jsonl + D:/agent/DSH/deepseek-harness
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { homedir } from 'node:os'

const GRAPH_PATH = process.argv.includes('--graph')
  ? process.argv[process.argv.indexOf('--graph') + 1]
  : join(homedir(), '.dsh', 'cognigraph', 'graph.jsonl')
const WORKSPACE = process.argv.includes('--workspace')
  ? process.argv[process.argv.indexOf('--workspace') + 1]
  : 'D:/agent/DSH/deepseek-harness'

// token 估算：代码约 3.5~4 字节/token，保守取 4
const BYTES_PER_TOKEN = 4

// ─── 图加载 ───
function loadGraph(path) {
  const nodes = new Map() // id -> node
  const edges = []
  const byName = new Map() // name -> id
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const row = JSON.parse(line)
    if (row.op === 'node') {
      nodes.set(row.node.id, row.node)
      byName.set(row.node.name, row.node.id)
    } else if (row.op === 'edge') {
      edges.push(row.edge)
    }
  }
  // 邻接表（双向）
  const adj = new Map()
  for (const [id] of nodes) adj.set(id, { out: new Map(), in: new Map() })
  for (const e of edges) {
    const from = adj.get(e.source)
    const to = adj.get(e.target)
    if (from) {
      const l = from.out.get(e.type) ?? []
      l.push(e.target)
      from.out.set(e.type, l)
    }
    if (to) {
      const l = to.in.get(e.type) ?? []
      l.push(e.source)
      to.in.set(e.type, l)
    }
  }
  return { nodes, edges, byName, adj }
}

// ─── 无图探索：真实扫描工作区，找引用（模拟 agent 的 grep + 读文件）───
function collectFiles(dir, exclude, max = 5000, out = []) {
  if (out.length >= max) return out
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (out.length >= max) return out
    if (entry.name.startsWith('.')) continue
    if (exclude.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collectFiles(full, exclude, max, out)
    else if (entry.isFile() && /\.(ts|tsx|js|jsx|mts|cts)$/.test(entry.name)) out.push(full)
  }
  return out
}

/**
 * 无图模拟：找"谁引用了 target"。
 * 真实 agent 行为：grep 一次（匹配文件内容任意位置的模式）→ 读每个命中文件确认。
 * 返回 { grepCalls, filesToRead: [{path, bytes}], toolCalls }
 */
function exploreByGrep(workspace, targetFile, importSpec) {
  const exclude = new Set(['node_modules', '.git', 'dist', 'lib', 'build', '.pnpm', 'coverage', 'vendor'])
  const files = collectFiles(workspace, exclude)
  const hits = []
  for (const full of files) {
    let content
    try {
      content = readFileSync(full, 'utf8')
    } catch {
      continue
    }
    // 模拟 grep：模式出现在文件内容任意位置即命中（agent 实际行为）
    if (new RegExp(importSpec).test(content)) {
      const rel = relative(workspace, full).split(sep).join('/')
      const bytes = statSync(full).size
      hits.push({ path: rel, bytes })
    }
  }
  // agent 行为：grep 1 次 + 读全部命中文件确认（每文件 1 次 read 工具调用）
  return {
    grepCalls: 1,
    readCalls: hits.length,
    toolCalls: 1 + hits.length,
    bytesRead: hits.reduce((s, h) => s + h.bytes, 0),
    filesToRead: hits,
  }
}

// ─── 有图查询：本插件的图算法 ───
function queryByGraph(graph, targetName, edgeTypes, maxDepth, direction = 'in') {
  const { byName, adj, nodes } = graph
  let id = byName.get(targetName)
  if (id === undefined) {
    // 宽松匹配
    for (const [name, nid] of byName) {
      if (name.endsWith('/' + targetName) || name === targetName) { id = nid; break }
    }
  }
  if (id === undefined) return { found: false, nodes: [], toolCalls: 1, bytesOut: 0 }

  const seen = new Set()
  const result = []
  let frontier = [id]
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next = []
    for (const cur of frontier) {
      const a = adj.get(cur)
      if (!a) continue
      for (const type of edgeTypes) {
        const list = direction === 'in' ? a.in.get(type) : direction === 'out' ? a.out.get(type) : [...(a.in.get(type) ?? []), ...(a.out.get(type) ?? [])]
        for (const t of list ?? []) {
          if (t === id || seen.has(t)) continue
          seen.add(t)
          const node = nodes.get(t)
          if (node) result.push(node)
          next.push(t)
        }
      }
    }
    frontier = next
  }
  const bytesOut = JSON.stringify(result.map((n) => ({ name: n.name, type: n.type }))).length
  return { found: true, nodes: result, toolCalls: 1, bytesOut }
}

// ─── 实验执行与报告 ───
const graph = loadGraph(GRAPH_PATH)
const totalBytes = graph.nodes.size

function fmtBytes(b) {
  return b > 1024 ? `${(b / 1024).toFixed(1)} KB` : `${b} B`
}

function runExperiment(name, { targetName, targetFile, importSpec, edgeTypes, maxDepth, direction }) {
  const noGraph = exploreByGrep(WORKSPACE, targetFile, importSpec)
  const withGraph = queryByGraph(graph, targetName, edgeTypes, maxDepth, direction)

  const ngTokens = Math.ceil(noGraph.bytesRead / BYTES_PER_TOKEN)
  const wgTokens = withGraph.found ? Math.ceil(withGraph.bytesOut / BYTES_PER_TOKEN) : 0
  const reduction = noGraph.toolCalls > 0 ? Math.round((1 - withGraph.toolCalls / noGraph.toolCalls) * 100) : 0

  console.log(`\n=== ${name} ===`)
  console.log(`目标：${targetName}（${targetFile}）`)
  console.log(`┌──────────────────────┬───────────────────┬───────────────────┐`)
  console.log(`│ 指标                 │ 无图（grep+读）     │ 有图（图查询）     │`)
  console.log(`├──────────────────────┼───────────────────┼───────────────────┤`)
  console.log(`│ 工具调用次数         │ ${String(noGraph.toolCalls).padEnd(17)} │ ${String(withGraph.toolCalls).padEnd(17)} │`)
  console.log(`│ 读取/返回数据量      │ ${fmtBytes(noGraph.bytesRead).padEnd(17)} │ ${fmtBytes(withGraph.bytesOut).padEnd(17)} │`)
  console.log(`│ 估算 token（/4B）    │ ${String(ngTokens).padEnd(17)} │ ${String(wgTokens).padEnd(17)} │`)
  console.log(`│ 命中文件数           │ ${String(noGraph.filesToRead.length).padEnd(17)} │ ${String(withGraph.nodes.length).padEnd(17)} │`)
  console.log(`└──────────────────────┴───────────────────┴───────────────────┘`)
  console.log(`工具调用减少：${reduction}% | token 减少：${Math.round((1 - wgTokens / (ngTokens || 1)) * 100)}%`)
  if (withGraph.found) {
    console.log(`有图命中样例：${withGraph.nodes.slice(0, 5).map((n) => n.name).join(', ')}${withGraph.nodes.length > 5 ? ' …' : ''}`)
  } else {
    console.log(`⚠️ 有图未命中（图谱中无此节点——可能未扫描或名字不同）`)
  }
  return { name, noGraph, withGraph, reduction, ngTokens, wgTokens }
}

console.log(`图谱数据：${GRAPH_PATH}（${totalBytes} 节点 / ${graph.edges.length} 边）`)
console.log(`工作区：${WORKSPACE}`)

// 实验 A：影响分析（改 types.ts 波及谁）——对齐 CodeGraph analyze_impact / get_edit_context
// 无图基线：真实 agent grep "types.ts"（文件内容任意出现）
const expA = runExperiment('A. 影响分析：改 types.ts 会波及谁（反向 Imports 闭包）', {
  targetName: 'packages/core/session/src/types.ts',
  targetFile: 'packages/core/session/src/types.ts',
  importSpec: `types\\.ts`,
  edgeTypes: ['Imports', 'Calls', 'Contains'],
  maxDepth: 3,
  direction: 'in',
})

// 实验 B：依赖查询（session 模块的依赖子图）——对齐 CodeGraph get_dependency_graph
// 无图基线：真实 agent grep "@deepseek-ai/dsh-session" 找所有消费方（含测试/示例）
const expB = runExperiment('B. 依赖查询：dsh-session 模块的依赖子图（双向 Imports）', {
  targetName: 'packages/core/session/src/index.ts',
  targetFile: 'packages/core/session/src/index.ts',
  importSpec: `@deepseek-ai/dsh-session`,
  edgeTypes: ['Imports'],
  maxDepth: 2,
  direction: 'both',
})

// 实验 C：符号定位（在哪个文件定义了某函数，谁引用它）——对齐 CodeGraph symbol_search
// 图内真实存在的符号：dsh-session 的 collectSessionCallbacks（被同模块多处 import）
const funcTarget = [...graph.byName.keys()].find((n) => n.includes(':collectSessionCallbacks'))
const expC = funcTarget
  ? runExperiment('C. 符号定位：collectSessionCallbacks 的定义与引用（Contains 反查）', {
    targetName: funcTarget,
    targetFile: 'packages/core/session/src/index.ts',
    importSpec: 'collectSessionCallbacks',
    edgeTypes: ['Contains', 'Imports'],
    maxDepth: 2,
    direction: 'in',
  })
  : { name: 'C', reduction: 0, ngTokens: 0, wgTokens: 0, noGraph: { toolCalls: 0, bytesRead: 0, filesToRead: [] }, withGraph: { toolCalls: 0, bytesOut: 0, nodes: [] } }

// 汇总（对 0 基线安全）
const expATokenReduction = expA.ngTokens > 0 ? Math.round((1 - expA.wgTokens / expA.ngTokens) * 100) : 0
const expBTokenReduction = expB.ngTokens > 0 ? Math.round((1 - expB.wgTokens / expB.ngTokens) * 100) : 0
const expCTokenReduction = expC.ngTokens > 0 ? Math.round((1 - expC.wgTokens / expC.ngTokens) * 100) : 0
const avgToolReduction = Math.round((expA.reduction + expB.reduction + (expC.reduction ?? 0)) / 3)
const avgTokenReduction = Math.round((expATokenReduction + expBTokenReduction + expCTokenReduction) / 3)
console.log(`\n════════════════════════════════════════════════`)
console.log(`汇总（3 组实验均值）：`)
console.log(`工具调用减少 ≈ ${avgToolReduction}%`)
console.log(`token 消耗减少 ≈ ${avgTokenReduction}%`)
console.log(`════════════════════════════════════════════════`)
