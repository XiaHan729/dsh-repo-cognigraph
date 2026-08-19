/**
 * @dsh-external/dsh-repo-cognigraph — client 图谱面板（conversation.view slot）。
 * 展示仓库认知图谱：SVG 力导向图（文件/符号节点 + 依赖边），
 * 颜色按类型区分，节点大小按行为热力缩放；下方列表展示雷区与热点统计。
 * 数据来自 host API：/api/stats（统计）与 /api/graph（图谱快照）。
 * 构建：npm run build:client（tsdown，产物 lib/client.js，ModuleLoader.load 注册）。
 */
import type { SlotsService } from '@deepseek-ai/dsh-client-ui-slots'

type ClientContext = {
  slots: SlotsService
}

export const inject = ['slots']

const API_BASE = '/@dsh-external/dsh-repo-cognigraph/api'

interface GraphNodeDto {
  id: number
  name: string
  type: string
  readCount: number
  editCount: number
  errorCount: number
}

interface GraphEdgeDto {
  source: number
  target: number
  type: string
}

interface StatsDto {
  nodeCount: number
  edgeCount: number
  hot: { name: string; readCount: number; editCount: number; errorCount: number }[]
  traps: { name: string; errorCount: number; lastError: string | null }[]
}

/** 节点类型 → 显示色。 */
const TYPE_COLORS: Record<string, string> = {
  CodeFile: '#4f8ef7',
  Function: '#34c759',
  Class: '#ff9f0a',
  Module: '#bf5af2',
  Trap: '#ff3b30',
  Variable: '#8e8e93',
  Type: '#5ac8fa',
  Interface: '#64d2ff',
  Generic: '#a0a0a8',
}

/** 轻量力导向布局：若干轮斥力+弹簧松弛。 */
function layout(nodes: GraphNodeDto[], edges: GraphEdgeDto[], width: number, height: number): Map<number, { x: number; y: number }> {
  const pos = new Map<number, { x: number; y: number }>()
  const vel = new Map<number, { x: number; y: number }>()
  const rng = (seed: number) => () => {
    // 确定性伪随机（避免每次刷新跳变）
    seed = (seed * 9301 + 49297) % 233280
    return seed / 233280
  }
  const r = rng(42)
  for (const n of nodes) {
    pos.set(n.id, { x: r() * width, y: r() * height })
    vel.set(n.id, { x: 0, y: 0 })
  }
  const linkMap = new Map<string, number>()
  for (const e of edges) {
    const key = e.source < e.target ? `${e.source}|${e.target}` : `${e.target}|${e.source}`
    linkMap.set(key, (linkMap.get(key) ?? 0) + 1)
  }
  for (let i = 0; i < 120; i++) {
    // 斥力
    const arr = [...pos.entries()]
    for (let a = 0; a < arr.length; a++) {
      for (let b = a + 1; b < arr.length; b++) {
        const [ia, pa] = arr[a]
        const [ib, pb] = arr[b]
        const dx = pa.x - pb.x
        const dy = pa.y - pb.y
        const d2 = dx * dx + dy * dy || 1
        const f = 4000 / d2
        const d = Math.sqrt(d2)
        const fx = (dx / d) * f
        const fy = (dy / d) * f
        vel.get(ia)!.x += fx
        vel.get(ia)!.y += fy
        vel.get(ib)!.x -= fx
        vel.get(ib)!.y -= fy
      }
    }
    // 弹簧引力（沿边）
    for (const e of edges) {
      const pa = pos.get(e.source)
      const pb = pos.get(e.target)
      if (!pa || !pb) continue
      const dx = pb.x - pa.x
      const dy = pb.y - pa.y
      const d = Math.sqrt(dx * dx + dy * dy) || 1
      const f = (d - 60) * 0.02
      const fx = (dx / d) * f
      const fy = (dy / d) * f
      vel.get(e.source)!.x += fx
      vel.get(e.source)!.y += fy
      vel.get(e.target)!.x -= fx
      vel.get(e.target)!.y -= fy
    }
    // 积分 + 阻尼 + 边界
    for (const n of nodes) {
      const p = pos.get(n.id)!
      const v = vel.get(n.id)!
      v.x *= 0.85
      v.y *= 0.85
      p.x += v.x
      p.y += v.y
      p.x = Math.max(10, Math.min(width - 10, p.x))
      p.y = Math.max(10, Math.min(height - 10, p.y))
    }
  }
  return pos
}

/** 简单字符串转义（防注入 SVG）。 */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function renderPanel(root: HTMLElement): void {
  root.innerHTML = ''
  root.style.padding = '12px'
  root.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, monospace'
  root.style.fontSize = '12px'
  root.style.color = '#e0e0e0'
  root.style.background = '#1a1a1f'
  root.style.borderRadius = '8px'

  const header = document.createElement('div')
  header.style.display = 'flex'
  header.style.alignItems = 'center'
  header.style.gap = '12px'
  header.style.marginBottom = '8px'
  const title = document.createElement('span')
  title.textContent = '🧠 仓库认知图谱'
  title.style.fontWeight = 'bold'
  const status = document.createElement('span')
  status.textContent = '加载中…'
  status.style.opacity = '0.6'
  const refresh = document.createElement('button')
  refresh.textContent = '刷新'
  refresh.style.marginLeft = 'auto'
  refresh.style.cursor = 'pointer'
  header.append(title, status, refresh)
  root.append(header)

  const body = document.createElement('div')
  body.style.display = 'grid'
  body.style.gridTemplateColumns = '1fr 300px'
  body.style.gap = '12px'
  root.append(body)

  const graphBox = document.createElement('div')
  graphBox.style.border = '1px solid #333'
  graphBox.style.borderRadius = '6px'
  graphBox.style.overflow = 'hidden'
  body.append(graphBox)

  const side = document.createElement('div')
  side.style.display = 'flex'
  side.style.flexDirection = 'column'
  side.style.gap = '8px'
  body.append(side)

  const load = (): void => {
    status.textContent = '加载中…'
    void Promise.all([
      fetch(`${API_BASE}/stats`).then((r) => r.json() as Promise<StatsDto>),
      fetch(`${API_BASE}/graph`).then((r) => r.json() as Promise<{ nodes: GraphNodeDto[]; edges: GraphEdgeDto[] }>),
    ]).then(([stats, graphData]) => {
      status.textContent = `${stats.nodeCount} 节点 / ${stats.edgeCount} 边`
      renderGraph(graphBox, graphData.nodes, graphData.edges)
      renderSide(side, stats)
    }).catch((e) => {
      status.textContent = `加载失败: ${String(e)}`
    })
  }

  refresh.addEventListener('click', load)
  load()
}

function renderGraph(box: HTMLElement, nodes: GraphNodeDto[], edges: GraphEdgeDto[]): void {
  box.innerHTML = ''
  if (nodes.length === 0) {
    box.textContent = '图谱为空：等待会话痕迹积累或配置 CodeGraph 导入。'
    box.style.padding = '12px'
    return
  }
  const width = 640
  const height = 420
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('width', String(width))
  svg.setAttribute('height', String(height))
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`)

  const pos = layout(nodes, edges, width, height)

  for (const e of edges) {
    const pa = pos.get(e.source)
    const pb = pos.get(e.target)
    if (!pa || !pb) continue
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
    line.setAttribute('x1', String(pa.x))
    line.setAttribute('y1', String(pa.y))
    line.setAttribute('x2', String(pb.x))
    line.setAttribute('y2', String(pb.y))
    line.setAttribute('stroke', '#3a3a44')
    line.setAttribute('stroke-width', '0.8')
    svg.append(line)
  }

  // 节点渲染（先画大的）
  const sorted = [...nodes].sort((a, b) => (b.readCount + b.editCount * 3 + b.errorCount * 5) - (a.readCount + a.editCount * 3 + a.errorCount * 5))
  for (const n of sorted) {
    const p = pos.get(n.id)
    if (!p) continue
    const heat = n.readCount + n.editCount * 3 + n.errorCount * 5
    const r = Math.max(3, Math.min(12, 3 + Math.sqrt(heat) * 1.5))
    const color = n.errorCount > 0 ? TYPE_COLORS['Trap'] : (TYPE_COLORS[n.type] ?? TYPE_COLORS['Generic'])
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
    circle.setAttribute('cx', String(p.x))
    circle.setAttribute('cy', String(p.y))
    circle.setAttribute('r', String(r))
    circle.setAttribute('fill', color)
    circle.setAttribute('opacity', n.errorCount > 0 ? '1' : '0.75')
    const name = n.name.length > 42 ? n.name.slice(0, 41) + '…' : n.name
    circle.setAttribute('data-tip', esc(`${n.name} (读${n.readCount}/改${n.editCount}/错${n.errorCount})`))
    svg.append(circle)
    if (r >= 6 && n.type !== 'CodeFile') {
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text')
      label.setAttribute('x', String(p.x + r + 2))
      label.setAttribute('y', String(p.y + 3))
      label.setAttribute('fill', '#aaa')
      label.setAttribute('font-size', '9px')
      label.textContent = name.split(':').pop() ?? name
      svg.append(label)
    }
  }

  // 简易 tooltip
  const tip = document.createElement('div')
  tip.style.position = 'absolute'
  tip.style.display = 'none'
  tip.style.background = '#000c'
  tip.style.padding = '4px 8px'
  tip.style.borderRadius = '4px'
  tip.style.pointerEvents = 'none'
  tip.style.zIndex = '10'
  box.style.position = 'relative'
  box.append(svg, tip)
  for (const circle of svg.querySelectorAll('circle')) {
    circle.addEventListener('mouseenter', (ev) => {
      const t = (ev.target as Element).getAttribute('data-tip')
      if (t) {
        tip.textContent = t
        tip.style.display = 'block'
      }
    })
    circle.addEventListener('mousemove', (ev) => {
      const rect = box.getBoundingClientRect()
      tip.style.left = `${ev.clientX - rect.left + 8}px`
      tip.style.top = `${ev.clientY - rect.top + 8}px`
    })
    circle.addEventListener('mouseleave', () => {
      tip.style.display = 'none'
    })
  }
}

function renderSide(side: HTMLElement, stats: StatsDto): void {
  side.innerHTML = ''
  const section = (title: string, items: { name: string; detail: string }[], color: string): void => {
    const box = document.createElement('div')
    box.style.border = '1px solid #333'
    box.style.borderRadius = '6px'
    box.style.padding = '8px'
    const h = document.createElement('div')
    h.textContent = title
    h.style.fontWeight = 'bold'
    h.style.color = color
    h.style.marginBottom = '6px'
    box.append(h)
    if (items.length === 0) {
      const empty = document.createElement('div')
      empty.textContent = '（暂无）'
      empty.style.opacity = '0.5'
      box.append(empty)
    } else {
      for (const item of items.slice(0, 12)) {
        const row = document.createElement('div')
        row.style.display = 'flex'
        row.style.justifyContent = 'space-between'
        row.style.gap = '8px'
        row.style.marginBottom = '2px'
        const name = document.createElement('span')
        name.textContent = item.name.length > 34 ? item.name.slice(0, 33) + '…' : item.name
        name.style.overflow = 'hidden'
        name.style.textOverflow = 'ellipsis'
        name.style.whiteSpace = 'nowrap'
        const detail = document.createElement('span')
        detail.textContent = item.detail
        detail.style.opacity = '0.6'
        detail.style.flexShrink = '0'
        row.append(name, detail)
        box.append(row)
      }
    }
    side.append(box)
  }
  section('⚠️ 雷区', stats.traps.map((t) => ({ name: t.name, detail: `错${t.errorCount}` })), '#ff6b62')
  section('🔥 热点', stats.hot.map((h) => ({ name: h.name, detail: `读${h.readCount}/改${h.editCount}` })), '#ffb340')
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.slots.inject('conversation.view', () =>
    ctx.slots.register({
      name: 'conversation.view',
      id: '@dsh-external/dsh-repo-cognigraph-panel',
      label: () => '认知图谱',
      component: () => ({
        render(el: HTMLElement) {
          renderPanel(el)
          return el
        },
      }),
    }),
  ), '@dsh-external/dsh-repo-cognigraph: panel')
}
