// 真实任务 T5 的无图成本测量：真实 grep 找 types.ts 引用者（模拟 agent 的探索）
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const WS = 'D:/agent/DSH/deepseek-harness'
const exclude = new Set(['node_modules', '.git', 'dist', 'lib', 'build', '.pnpm', 'coverage', 'vendor'])

function collect(dir, out = []) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    if (exclude.has(e.name)) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) collect(full, out)
    else if (e.isFile() && /\.(ts|tsx|js)$/.test(e.name)) out.push(full)
  }
  return out
}

const t0 = Date.now()
const files = collect(WS)
const tCollect = Date.now() - t0

const t1 = Date.now()
const hits = []
for (const f of files) {
  try {
    const c = readFileSync(f, 'utf8')
    if (/from '\.\.\/types'|from '\.\/types'|from '\.\.\/types\.ts'|from '\.\/types\.ts'/.test(c)) {
      hits.push({ path: relative(WS, f).split(sep).join('/'), bytes: statSync(f).size })
    }
  } catch { /* skip */ }
}
const tGrep = Date.now() - t1
const totalBytes = hits.reduce((s, h) => s + h.bytes, 0)

console.log(`扫描 ${files.length} 个文件`)
console.log(`grep 用时: ${tCollect + tGrep}ms（文件枚举 ${tCollect}ms + 内容匹配 ${tGrep}ms）`)
console.log(`命中文件: ${hits.length} 个（若 agent 逐个读 = ${hits.length} 次 read 工具调用）`)
console.log(`读取总量: ${(totalBytes / 1024).toFixed(1)} KB ≈ ${Math.ceil(totalBytes / 4).toLocaleString()} token`)
console.log('--- 命中文件（前 12）---')
hits.slice(0, 12).forEach((h) => console.log('  ' + h.path))
