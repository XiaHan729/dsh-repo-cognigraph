import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CogniGraph } from '../src/graph.ts'
import { importCodeGraphJson, mapEdgeType, mapNodeType } from '../src/codegraph-import.ts'
import { scanWorkspace, collectSourceFiles, resolveImport } from '../src/scanner.ts'
import { projectToolCall, normalizePath } from '../src/trace.ts'
import { parseSourceFile, isSupportedSource } from '../src/ts-parser.ts'
import { parseDistillJson, tailMessages, applyDistilledFact } from '../src/distill.ts'

/** 每个用例的独立临时目录，用后即删。 */
let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cg-test-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('CogniGraph 基础', () => {
  let graph: CogniGraph

  beforeEach(() => {
    graph = new CogniGraph(join(tmp, 'graph.jsonl'))
  })

  it('upsertNode 幂等：同名返回既有 id', () => {
    const a = graph.upsertNode('CodeFile', 'src/a.ts', 'src/a.ts', 1)
    const b = graph.upsertNode('CodeFile', 'src/a.ts', 'src/a.ts', 2)
    expect(a).toBe(b)
    expect(graph.nodeCount).toBe(1)
  })

  it('upsertEdge 去重：同构边只保留一条', () => {
    const a = graph.upsertNode('CodeFile', 'a.ts', 'a.ts', 1)
    const b = graph.upsertNode('CodeFile', 'b.ts', 'b.ts', 1)
    graph.upsertEdge(a, b, 'Imports')
    graph.upsertEdge(a, b, 'Imports')
    expect(graph.edgeCount).toBe(1)
  })

  it('neighbors BFS：沿 Imports 双向遍历返回邻居', () => {
    const a = graph.upsertNode('CodeFile', 'a.ts', 'a.ts', 1)
    const b = graph.upsertNode('CodeFile', 'b.ts', 'b.ts', 1)
    const c = graph.upsertNode('CodeFile', 'c.ts', 'c.ts', 1)
    graph.upsertEdge(a, b, 'Imports')
    graph.upsertEdge(b, c, 'Imports')
    const nodes = graph.neighbors(a, ['Imports'], 2, 'both')
    expect(nodes.map((n) => n.name).sort()).toEqual(['a.ts', 'b.ts', 'c.ts'])
  })

  it('dependents 影响闭包：反向遍历 Calls', () => {
    const a = graph.upsertNode('Function', 'a', 'a.ts', 1)
    const b = graph.upsertNode('Function', 'b', 'b.ts', 1)
    const c = graph.upsertNode('Function', 'c', 'c.ts', 1)
    graph.upsertEdge(a, b, 'Calls')
    graph.upsertEdge(b, c, 'Calls')
    // 谁调用了 c → b、a
    const affected = graph.dependents(c, ['Calls'], 3)
    expect(affected.map((n) => n.name).sort()).toEqual(['a', 'b'])
  })

  it('incStat 与 Trap 阈值升级', () => {
    const id = graph.upsertNode('CodeFile', 'bad.ts', 'bad.ts', 1)
    graph.incStat(id, 'errorCount', 1, 2, 'E001')
    graph.incStat(id, 'errorCount', 1, 3, 'E002')
    graph.incStat(id, 'errorCount', 1, 4, 'E003')
    expect(graph.getNode(id)!.stats.errorCount).toBe(3)
    expect(graph.traps()[0]?.name).toBe('bad.ts')
  })

  it('hotNodes 按 read/edit/error 权重排序', () => {
    const hot = graph.upsertNode('CodeFile', 'hot.ts', 'hot.ts', 1)
    const cold = graph.upsertNode('CodeFile', 'cold.ts', 'cold.ts', 1)
    graph.incStat(hot, 'readCount', 5, 2)
    graph.incStat(cold, 'readCount', 1, 2)
    const list = graph.hotNodes(10)
    expect(list[0]?.name).toBe('hot.ts')
    expect(list[1]?.name).toBe('cold.ts')
  })

  it('持久化：replay 重建内存态', async () => {
    const a = graph.upsertNode('CodeFile', 'a.ts', 'a.ts', 1)
    graph.incStat(a, 'readCount', 3, 2)
    await graph.appendJournal(graph.exportJournal())
    const g2 = new CogniGraph(join(tmp, 'graph.jsonl'))
    g2.replay(readFileSync(join(tmp, 'graph.jsonl'), 'utf8').split('\n'))
    expect(g2.nodeCount).toBe(1)
    expect(g2.getNode(a)!.stats.readCount).toBe(3)
  })
})

describe('CodeGraph JSON 导入', () => {
  it('importCodeGraphJson 映射节点与边', () => {
    const graph = new CogniGraph(join(tmp, 'g.jsonl'))
    const { nodes, edges } = importCodeGraphJson(graph, {
      nodes: [
        { id: 1, type: 'CodeFile', properties: { name: 'a.ts' } },
        { id: 2, type: 'Function', properties: { name: 'foo', file: 'a.ts' } },
      ],
      links: [
        { id: 1, source: 1, target: 2, type: 'Contains' },
      ],
    }, 0)
    expect(nodes).toBe(2)
    expect(edges).toBe(1)
    expect(graph.findByName('a.ts')).toBeDefined()
    expect(graph.findByName('foo')).toBeDefined()
  })

  it('mapNodeType/mapEdgeType 未知类型回退', () => {
    expect(mapNodeType('CodeFile')).toBe('CodeFile')
    expect(mapNodeType('Weird')).toBe('Generic')
    expect(mapEdgeType('Calls')).toBe('Calls')
    expect(mapEdgeType('Weird')).toBe('References')
  })

  it('悬挂引用（边指向未导入节点）被跳过', () => {
    const graph = new CogniGraph(join(tmp, 'g.jsonl'))
    const { edges } = importCodeGraphJson(graph, {
      nodes: [{ id: 1, type: 'CodeFile', properties: { name: 'a.ts' } }],
      links: [{ id: 1, source: 1, target: 999, type: 'Imports' }],
    }, 0)
    expect(edges).toBe(0)
  })
})

describe('内置解析器', () => {
  it('parseSourceFile 提取 import/符号/导出', () => {
    const parsed = parseSourceFile('m.ts', [
      "import { a } from './a'",
      'import b from "pkg-b"',
      'export function hello() {}',
      'export class World {}',
      'const x = 1',
    ].join('\n'))
    expect(parsed.imports).toEqual(['./a', 'pkg-b'])
    expect(parsed.symbols.map((s) => s.name).sort()).toEqual(['World', 'hello', 'x'])
    expect(parsed.exports).toContain('hello')
  })

  it('isSupportedSource 只认 JS/TS 系', () => {
    expect(isSupportedSource('a.ts')).toBe(true)
    expect(isSupportedSource('a.tsx')).toBe(true)
    expect(isSupportedSource('a.py')).toBe(false)
  })

  it('resolveImport 相对/包导入区分', () => {
    const ws = tmp
    // 无文件时回退原样路径
    const rel = resolveImport(ws, 'src/index.ts', './util')
    expect(rel).toContain('util')
    // 有 util.ts 文件（与 fromFile 同目录）时补全扩展名
    writeFileSync(join(tmp, 'util.ts'), 'export const u = 1')
    expect(resolveImport(ws, 'index.ts', './util')).toBe('util.ts')
    expect(resolveImport(ws, 'src/index.ts', '@scope/pkg')).toBe('external:@scope/pkg')
    expect(resolveImport(ws, 'src/index.ts', 'node:fs')).toBe('external:node:fs')
  })
})

describe('扫描器', () => {
  it('collectSourceFiles 递归收集并排除目录', () => {
    writeFileSync(join(tmp, 'a.ts'), 'export const a = 1')
    writeFileSync(join(tmp, 'b.js'), 'export const b = 1')
    writeFileSync(join(tmp, 'c.py'), 'x = 1')
    writeFileSync(join(tmp, 'skip.ts'), 'export const s = 1')
    const files = collectSourceFiles(tmp, ['skip.ts'], 100)
    expect(files.map((f) => f.replace(/\\/g, '/').split('/').pop()).sort()).toEqual(['a.ts', 'b.js'])
  })

  it('scanWorkspace 建文件/符号节点与 Imports 边', () => {
    writeFileSync(join(tmp, 'main.ts'), "import { util } from './util'\nexport function main() { util() }")
    writeFileSync(join(tmp, 'util.ts'), 'export function util() {}')
    const graph = new CogniGraph(join(tmp, 'g.jsonl'))
    const r = scanWorkspace(graph, { workspace: tmp, excludeDirs: [], maxFiles: 100 }, 0)
    expect(r.files).toBe(2)
    expect(graph.findByName('main.ts')).toBeDefined()
    expect(graph.findByName('util.ts')).toBeDefined()
    // Imports 边：main.ts → util.ts
    const main = graph.findByName('main.ts')!
    const util = graph.findByName('util.ts')!
    const edges = graph.allEdges().filter((e) => e.source === main && e.target === util)
    expect(edges.length).toBeGreaterThan(0)
  })
})

describe('痕迹层', () => {
  it('projectToolCall 读/写/错计数', () => {
    const graph = new CogniGraph(join(tmp, 'g.jsonl'))
    const cfg = { trapErrorThreshold: 3, recordTraces: false }
    const readId = projectToolCall(graph, 'read', { file_path: 'src/a.ts' }, false, null, 1, cfg)
    expect(readId).toBeDefined()
    expect(graph.getNode(readId!)!.stats.readCount).toBe(1)
    const editId = projectToolCall(graph, 'edit', { file_path: 'src/a.ts' }, false, null, 2, cfg)
    expect(graph.getNode(editId!)!.stats.editCount).toBe(1)
    projectToolCall(graph, 'read', { file_path: 'src/a.ts' }, true, 'E_BOOM', 3, cfg)
    projectToolCall(graph, 'read', { file_path: 'src/a.ts' }, true, 'E_BOOM', 4, cfg)
    projectToolCall(graph, 'read', { file_path: 'src/a.ts' }, true, 'E_BOOM', 5, cfg)
    expect(graph.getNode(readId!)!.stats.errorCount).toBe(3)
    expect(graph.getNode(readId!)!.type).toBe('Trap')
  })

  it('normalizePath 统一反斜杠与 ./ 前缀', () => {
    expect(normalizePath('src\\a\\b.ts')).toBe('src/a/b.ts')
    expect(normalizePath('./src/a.ts')).toBe('src/a.ts')
  })

  it('无路径参数的工具调用不建节点', () => {
    const graph = new CogniGraph(join(tmp, 'g.jsonl'))
    const id = projectToolCall(graph, 'web_search', { query: 'x' }, false, null, 1, { trapErrorThreshold: 3, recordTraces: false })
    expect(id).toBeUndefined()
    expect(graph.nodeCount).toBe(0)
  })
})

describe('决策蒸馏层', () => {
  it('parseDistillJson 解析干净 JSON 数组', () => {
    const facts = parseDistillJson(JSON.stringify([
      { kind: 'decision', topic: '用 withInitiator', conclusion: 'session 获取必须走 initiator', files: ['src/a.ts'] },
    ]))
    expect(facts).not.toBeNull()
    expect(facts![0].kind).toBe('decision')
    expect(facts![0].topic).toBe('用 withInitiator')
  })

  it('parseDistillJson 容忍 ```json 围栏与噪声', () => {
    const facts = parseDistillJson('```json\n[{"kind":"trap","topic":"别用 fs.writeFileSync","conclusion":"大文件会阻塞","files":[]}]\n```')
    expect(facts).not.toBeNull()
    expect(facts![0].kind).toBe('trap')
  })

  it('parseDistillJson 拒绝非法输出', () => {
    expect(parseDistillJson('这不是 JSON')).toBeNull()
    expect(parseDistillJson('{"not":"array"}')).toBeNull()
    expect(parseDistillJson('[]')).toBeNull()
  })

  it('parseDistillJson 从夹带解释的文本中提取数组', () => {
    const facts = parseDistillJson('好的，以下是提取结果：\n[{"kind":"habit","topic":"pnpm 命令","conclusion":"先看 AGENTS.md","files":["AGENTS.md"]}]\n以上。')
    expect(facts).not.toBeNull()
    expect(facts![0].kind).toBe('habit')
  })

  it('tailMessages 取最近片段并裁头', () => {
    const messages = [
      { role: 'user' as const, content: 'a'.repeat(100) },
      { role: 'assistant' as const, content: 'b'.repeat(100) },
      { role: 'user' as const, content: 'c'.repeat(100) },
    ]
    const { text, count } = tailMessages(messages, 250)
    expect(count).toBe(2) // 最近两条
    expect(text).toContain('c')
    expect(text).not.toContain('a')
  })

  it('tailMessages 兼容 content-block 数组', () => {
    const messages = [
      { role: 'user' as const, content: [{ type: 'text', text: 'hello' }, { type: 'text', text: ' world' }] },
    ]
    const { text } = tailMessages(messages, 1000)
    expect(text).toContain('hello')
    expect(text).toContain('world')
  })

  it('applyDistilledFact 挂 Decision 节点 + Records 边到命中文件', () => {
    const graph = new CogniGraph(join(tmp, 'g.jsonl'))
    const fileId = graph.upsertNode('CodeFile', 'src/a.ts', 'src/a.ts', 1)
    const hits = applyDistilledFact(graph, {
      kind: 'decision',
      topic: '用 withInitiator',
      conclusion: 'session 获取必须走 initiator',
      files: ['src/a.ts'],
    }, 5)
    expect(hits).toEqual([fileId])
    // Decision 节点存在，Records 边存在
    const decision = graph.allNodes().find((n) => n.type === 'Decision')
    expect(decision).toBeDefined()
    expect(decision!.sourceEventSeqs).toContain(5)
    const records = graph.allEdges().filter((e) => e.type === 'Records')
    expect(records.length).toBe(1)
    expect(records[0]!.source).toBe(decision!.id)
    expect(records[0]!.target).toBe(fileId)
  })

  it('applyDistilledFact 未命中文件时仍建孤立 Decision 节点', () => {
    const graph = new CogniGraph(join(tmp, 'g.jsonl'))
    const hits = applyDistilledFact(graph, {
      kind: 'habit',
      topic: 'pnpm 先看文档',
      conclusion: '跑命令前先读 AGENTS.md',
      files: ['不存在的文件.ts'],
    }, 3)
    expect(hits).toEqual([])
    const decision = graph.allNodes().find((n) => n.type === 'Decision')
    expect(decision).toBeDefined()
    expect(graph.allEdges().filter((e) => e.type === 'Records').length).toBe(0)
  })
})
