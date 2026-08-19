/**
 * 静态层扫描器（内置解析器兜底）：扫描工作区 TS/JS 源文件，
 * 解析 import/export/声明，构建 CodeFile/Function/Class/Module 节点
 * 与 Imports/Contains 边。无 CodeGraph 时提供开箱即用的静态图。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { CogniGraph } from './graph.ts'
import { isSupportedSource, parseSourceFile } from './ts-parser.ts'

/** 扫描配置。 */
export interface ScanConfig {
  /** 工作区根（绝对路径）。 */
  workspace: string
  /** 排除目录名（相对工作区或任意层）。 */
  excludeDirs: string[]
  /** 单次扫描最大文件数（防失控）。 */
  maxFiles: number
}

/** 递归收集工作区内的源文件（跳过排除目录、跳过超大文件）。 */
export function collectSourceFiles(workspace: string, excludeDirs: string[], maxFiles: number, maxBytes = 512 * 1024): string[] {
  const result: string[] = []
  const exclude = new Set(excludeDirs.map((d) => d.replace(/[\\/]+$/, '')))

  const walk = (dir: string): void => {
    if (result.length >= maxFiles) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return // 无权限目录跳过
    }
    for (const entry of entries) {
      if (result.length >= maxFiles) return
      if (entry.name.startsWith('.') && entry.name !== '.') continue
      if (exclude.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile() && isSupportedSource(entry.name)) {
        try {
          if (statSync(full).size <= maxBytes) result.push(full)
        } catch {
          // 文件不可读跳过
        }
      }
    }
  }

  walk(workspace)
  return result
}

/**
 * 扫描工作区并构建静态层。
 * 幂等：重复扫描只 upsert，不产生重复节点/边。
 * @param graph - 目标图。
 * @param config - 扫描配置。
 * @param seq - 证据 seq（非会话上下文用 0）。
 * @returns 统计：扫描文件数、节点数、边数。
 */
export function scanWorkspace(graph: CogniGraph, config: ScanConfig, seq = 0): { files: number; nodes: number; edges: number } {
  const files = collectSourceFiles(config.workspace, config.excludeDirs, config.maxFiles)
  let nodes = 0
  let edges = 0

  // 两阶段索引：先建全部文件/符号节点，再建边——
  // 单遍扫描时目标文件节点尚未建立，相对导入边会全部落空。
  const parsedFiles: { rel: string; parsed: ReturnType<typeof parseSourceFile>; fileId: number }[] = []

  for (const fullPath of files) {
    const rel = relative(config.workspace, fullPath).split(sep).join('/')
    let content: string
    try {
      content = readFileSync(fullPath, 'utf8')
    } catch {
      continue // 不可读文件跳过
    }
    const parsed = parseSourceFile(rel, content)

    const fileId = graph.upsertNode('CodeFile', rel, rel, seq, { language: 'typescript' })
    nodes++

    // 符号节点 + Contains 边
    for (const sym of parsed.symbols) {
      const symName = `${rel}:${sym.name}`
      const symId = graph.upsertNode(sym.kind, symName, rel, seq)
      graph.upsertEdge(fileId, symId, 'Contains')
      nodes++
      edges++
    }

    parsedFiles.push({ rel, parsed, fileId })
  }

  // 第二遍：导入边（此时全部文件节点已就绪，相对导入可命中）。
  for (const { rel, parsed, fileId } of parsedFiles) {
    for (const imp of parsed.imports) {
      const target = resolveImport(config.workspace, rel, imp)
      if (target === null) continue
      if (target.startsWith('external:')) {
        const modId = graph.upsertNode('Module', target, target, seq, { external: true })
        graph.upsertEdge(fileId, modId, 'Imports')
        nodes++
        edges++
      } else {
        const existing = graph.findByName(target)
        if (existing !== undefined) {
          graph.upsertEdge(fileId, existing, 'Imports')
          edges++
        }
        // 未命中（未扫描到）时不上边，避免噪声
      }
    }
  }

  return { files: files.length, nodes, edges }
}

/**
 * 解析一条 import 目标：相对导入 → 工作区内路径（若存在对应文件）；
 * 包导入 → "external:<pkg>"。解析失败/不可解析返回 null。
 * @param workspace - 工作区根。
 * @param fromFile - 源文件相对路径。
 * @param spec - import 目标字符串。
 */
export function resolveImport(workspace: string, fromFile: string, spec: string): string | null {
  if (!spec) return null
  if (spec.startsWith('.') || spec.startsWith('/')) {
    // 相对/绝对导入：纯正斜杠拼接（Windows 下 path 函数混合分隔符会错位），
    // 先尝试原样（显式扩展名），再按扩展名与 index 约定补全。
    const ws = workspace.replace(/\\/g, '/').replace(/\/+$/, '')
    const dir = fromFile.split('/').slice(0, -1).join('/')
    const base = (spec.startsWith('/')
      ? spec
      : (dir ? `${dir}/${spec}` : spec)).replace(/^\.\//, '')
    const candidates = [
      base,
      ...['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.json', '.md'].map((ext) => base + ext),
      ...['/index.ts', '/index.tsx', '/index.js', '/index.jsx'].map((suffix) => base + suffix),
    ]
    const seen = new Set<string>()
    for (const c of candidates) {
      const rel = c.replace(/\/+/g, '/')
      if (!rel || rel.startsWith('..') || rel.startsWith('/')) continue
      if (seen.has(rel)) continue
      seen.add(rel)
      // 返回第一个"确有此文件"的候选；无文件时回退到原样路径（调用方查图兜底）
      const full = `${ws}/${rel}`
      if (existsSync(full) && statSync(full).isFile()) return rel
    }
    return base
  }
  // 包导入：取包名（@scope/name 或 name）
  const parts = spec.split('/')
  const pkg = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  return pkg ? `external:${pkg}` : null
}
