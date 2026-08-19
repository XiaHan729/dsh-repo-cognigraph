/**
 * 内置轻量 TS/JS 解析器（静态层兜底，无 CodeGraph 时使用）。
 * 不依赖 tree-sitter：用正则/扫描提取模块级结构——import/export 依赖、
 * 顶层 function/class 声明、require 调用。精确调用图请用 CodeGraph 导入。
 */

export interface ParsedFile {
  /** 相对路径（原样传入）。 */
  path: string
  /** 模块依赖（import/require 的目标，按出现序去重）。 */
  imports: string[]
  /** 顶层函数/类/常量声明。 */
  symbols: { name: string; kind: 'Function' | 'Class' | 'Module' | 'Variable' }[]
  /** 显式导出名。 */
  exports: string[]
}

const IMPORT_RE = /import\s+(?:type\s+)?(?:[\w$*{},\s]+?\s+from\s+)?['"]([^'"]+)['"]/g
const EXPORT_FROM_RE = /export\s+(?:type\s+)?(?:[\w$*{},\s]+?\s+from\s+)?['"]([^'"]+)['"]/g
const REQUIRE_RE = /require\(\s*['"]([^'"]+)['"]\s*\)/g
const FUNCTION_RE = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm
const CLASS_RE = /^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/gm
const CONST_RE = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm
const EXPORT_NAMED_RE = /^export\s+(?:const|let|var|function|class|async\s+function)\s+([A-Za-z_$][\w$]*)/gm

/**
 * 解析单个 TS/JS 源文件，提取模块级结构。
 * 失败（非 JS/TS 内容或语法极端）时返回空结构，不抛出。
 * @param path - 文件相对路径。
 * @param content - 文件内容。
 * @returns 解析结果。
 */
export function parseSourceFile(path: string, content: string): ParsedFile {
  const imports = new Set<string>()
  const symbols = new Map<string, 'Function' | 'Class' | 'Module' | 'Variable'>()
  const exports = new Set<string>()

  const collect = (re: RegExp, sink: (m: RegExpExecArray) => void): void => {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(content)) !== null) {
      sink(m)
      if (m[0].length === 0) re.lastIndex++ // 防零宽死循环
    }
  }

  collect(IMPORT_RE, (m) => imports.add(m[1]))
  collect(EXPORT_FROM_RE, (m) => imports.add(m[1]))
  collect(REQUIRE_RE, (m) => imports.add(m[1]))
  collect(FUNCTION_RE, (m) => symbols.set(m[1], 'Function'))
  collect(CLASS_RE, (m) => symbols.set(m[1], 'Class'))
  collect(CONST_RE, (m) => symbols.set(m[1], 'Variable'))
  collect(EXPORT_NAMED_RE, (m) => exports.add(m[1]))

  // 默认导出匿名函数/类：给一个合成名，便于图上引用
  if (/\bexport\s+default\b/.test(content) && !exports.has('default')) {
    exports.add('default')
  }

  return {
    path,
    imports: [...imports],
    symbols: [...symbols.entries()].map(([name, kind]) => ({ name, kind })),
    exports: [...exports],
  }
}

/** 常见语言扩展名 → 是否可被本解析器处理。 */
export function isSupportedSource(path: string): boolean {
  return /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/.test(path)
}
