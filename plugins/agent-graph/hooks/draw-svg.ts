import { type GraphNode, truncate, walk } from './layout'

const W = 264
const H = 106
const GAP_X = 56
const GAP_Y = 14
const PAD = 8
const INSET = 12
const BAR_W = W - 2 * INSET
const BAR_H = 4
const EXTRA_DX = 8
const CHAR_W = 6.6

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export const fitMetrics = (ctx: string, extras: string[]) => {
  const parts = [ctx]
  let left = BAR_W - ctx.length * CHAR_W
  for (const e of extras) {
    const avail = Math.floor((left - EXTRA_DX) / CHAR_W) - 1
    if (e.length <= avail) {
      parts.push(e)
      left -= EXTRA_DX + (e.length + 1) * CHAR_W
      continue
    }
    if (avail >= 2) parts.push(truncate(e, avail))
    else if (avail === 1) parts.push('…')
    else parts[parts.length - 1] = `${[...parts.at(-1)!].slice(0, -1).join('')}…`
    break
  }

  return { ctx: parts[0]!, extras: parts.slice(1) }
}

const LIGHT = `
.card{fill:#faf9f7;stroke:#d6d4ce;stroke-width:1}
.card.running{stroke:#409524;stroke-width:1.5}
.card.failed{stroke:#d0544a;stroke-width:1.5}
.card.done{fill:none;stroke-dasharray:4 3}
.title{font:600 12.5px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;fill:#1f1e1d}
.meta,.act{font:11px ui-monospace,SFMono-Regular,Menlo,monospace;fill:#8a877f}
.ctx.warn,.bar.warn{fill:#c98a1b}.ctx.hot,.bar.hot{fill:#d0544a}.bar.ok{fill:#409524}
.track{fill:rgba(128,128,128,0.28)}
.done .bar,.idle .bar,.failed .bar{fill-opacity:.5}
.desc{font:12px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;fill:#3d3c39}
.done .title,.done .desc{fill:#8a877f}
.edge{fill:none;stroke:#c4c1b9;stroke-width:1.25}
.edge.running{stroke:#409524;stroke-opacity:.7}
.dot.running{fill:#409524}.dot.failed{fill:#d0544a}.dot.done{fill:#8a877f}.dot.idle{fill:none;stroke:#8a877f}`

const DARK = `
.card{fill:#242423;stroke:#3d3d3b}
.card.done{fill:none}
.title{fill:#edede9}.desc{fill:#c9c7c0}.meta,.act{fill:#8f8d87}
.done .title,.done .desc{fill:#8f8d87}
.edge{stroke:#4d4c49}
.ctx.warn,.bar.warn{fill:#c98a1b}.ctx.hot,.bar.hot{fill:#d0544a}.bar.ok{fill:#409524}`

const STYLE = `${LIGHT}\n@media (prefers-color-scheme: dark){${DARK}}`

export const drawSvg = (root: GraphNode, slots: number, depth: number) => {
  const width = PAD * 2 + (depth + 1) * W + depth * GAP_X
  const height = PAD * 2 + slots * H + (slots - 1) * GAP_Y
  const pos = (n: GraphNode) => ({ x: PAD + n.depth * (W + GAP_X), y: PAD + n.slot * (H + GAP_Y) })
  const edges: string[] = []
  const nodes: string[] = []

  walk(root, (n, parent) => {
    const { x, y } = pos(n)
    if (parent) {
      const p = pos(parent)
      const x1 = p.x + W
      const y1 = p.y + H / 2
      const y2 = y + H / 2
      const mid = (x1 + x) / 2
      edges.push(
        `<path class="edge ${n.status}" d="M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x} ${y2}"/>`,
      )
    }
    const pulse =
      n.status === 'running'
        ? `<circle class="dot running" cx="${x + 16}" cy="${y + 19}" r="4"></circle>`
        : `<circle class="dot ${n.status}" cx="${x + 16}" cy="${y + 19}" r="3.5"/>`
    const meta = n.meta || (n.status === 'running' ? 'working' : 'idle')
    const fit = fitMetrics(n.ctx, n.extras)
    const metrics =
      `<text class="meta" x="${x + INSET}" y="${y + 56}">` +
      `<tspan class="ctx ${n.ctxTone}">${esc(fit.ctx)}</tspan>` +
      fit.extras.map(e => `<tspan dx="${EXTRA_DX}"> ${esc(e)}</tspan>`).join('') +
      `</text>`
    const gauge =
      n.ctxPct === undefined
        ? ''
        : `<rect class="track" x="${x + INSET}" y="${y + 62}" width="${BAR_W}" height="${BAR_H}" rx="2"/>` +
          `<rect class="bar ${n.ctxTone}" x="${x + INSET}" y="${y + 62}" width="${+((BAR_W * n.ctxPct) / 100).toFixed(2)}" height="${BAR_H}" rx="2"/>`
    const desc = n.description || (n.depth === 0 ? 'this session' : '')
    nodes.push(
      `<g class="${n.status}">` +
        `<rect class="card ${n.status}" x="${x + 0.5}" y="${y + 0.5}" width="${W - 1}" height="${H - 1}" rx="9"/>` +
        pulse +
        `<text class="title" x="${x + 27}" y="${y + 23}">${esc(truncate(n.title, 26))}</text>` +
        `<text class="meta" x="${x + 12}" y="${y + 40}">${esc(truncate(meta, 30))}</text>` +
        metrics +
        gauge +
        `<text class="desc" x="${x + 12}" y="${y + 82}">${esc(truncate(desc, 31))}</text>` +
        `<text class="act" x="${x + 12}" y="${y + 97}">${esc(truncate(n.activity, 30))}</text>` +
        `</g>`,
    )
  })

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<style>${STYLE}</style>${edges.join('')}${nodes.join('')}</svg>`
  return { svg, width, height }
}
