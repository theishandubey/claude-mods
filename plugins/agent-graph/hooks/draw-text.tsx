import type { Color, Elements } from 'claude-code'

import { type GraphNode, type NodeParts, type Tone, truncate } from './layout'

type Els = Elements['terminal']
type Run = { text: string; color?: Color; dim?: boolean; bold?: boolean }
type Line = { key: string; gutter: string; runs: Run[]; right?: Run }
type Tier = { descOnHead: boolean; splitMetrics: boolean; gauge: number }

const WIDE: Tier = { descOnHead: true, splitMetrics: false, gauge: 12 }
const MEDIUM: Tier = { descOnHead: true, splitMetrics: true, gauge: 8 }
const NARROW: Tier = { descOnHead: false, splitMetrics: true, gauge: 0 }
const TITLE_MAX = 32
const MODEL_MAX = 18
const TEXT_MAX = 200
const GLYPH: Record<GraphNode['status'], string> = { running: '●', done: '✓', failed: '✗', idle: '○' }

export const tierOf = (columns: number): Tier => (columns >= 80 ? WIDE : columns >= 56 ? MEDIUM : NARROW)

const plain = (text: string): Run => ({ text })
const dim = (text: string): Run => ({ text, dim: true })
const toned = (text: string, tone: Tone): Run =>
  tone === 'hot' ? { text, color: 'error', bold: true } : tone === 'warn' ? { text, color: 'warning', bold: true } : { text }

const glyphOf = (status: GraphNode['status']): Run =>
  status === 'failed'
    ? { text: GLYPH.failed, color: 'error', bold: true }
    : status === 'running'
      ? { text: GLYPH.running, bold: true }
      : dim(GLYPH[status])

const filledCells = (pct: number, cells: number) => {
  const ratio = Math.min(Math.max(pct, 0), 100) / 100
  return ratio === 0 ? 0 : Math.max(1, Math.round(ratio * cells))
}

const gaugeRuns = (pct: number, tone: Tone, cells: number, alerts: boolean): Run[] => {
  const filled = filledCells(pct, cells)
  const runs: Run[] = []
  if (filled > 0) runs.push(alerts ? toned('━'.repeat(filled), tone) : dim('━'.repeat(filled)))
  if (cells - filled > 0) runs.push(dim('─'.repeat(cells - filled)))
  return runs
}

const join = (segments: Run[][]): Run[] =>
  segments.filter(s => s.length > 0).flatMap((s, i) => (i === 0 ? s : [plain('  '), ...s]))

const countSegments = (p: NodeParts): Run[][] => [
  p.elapsed ? [plain(p.elapsed)] : [],
  p.steps ? [plain(String(p.steps)), dim(p.steps === 1 ? ' step' : ' steps')] : [],
  p.tokens ? [plain(p.tokens), dim(' tok')] : [],
]

const ctxSegments = (n: GraphNode, tier: Tier, alerts: boolean): Run[][] => {
  const p = n.parts
  if (p.ctxTokens === undefined) return [[dim('waiting for first reply')]]
  const tone: Tone = alerts ? n.ctxTone : 'ok'
  const ctx: Run[] = [dim('ctx '), plain(p.ctxTokens)]
  if (n.ctxPct !== undefined) {
    ctx.push(plain(' '), toned(`${Math.round(n.ctxPct)}%`, tone))
    if (tier.gauge > 0) ctx.push(plain(' '), ...gaugeRuns(n.ctxPct, tone, tier.gauge, alerts))
  }
  return [ctx, p.cacheHit ? [dim('cache '), plain(p.cacheHit)] : [], p.cost ? [plain(p.cost)] : []]
}

const rail = (isOpen: boolean) => (isOpen ? '│ ' : '  ')

const nodeLines = (n: GraphNode, tier: Tier, rails: string, isLast: boolean): Line[] => {
  const isRoot = n.depth === 0
  const hasKids = n.children.length > 0
  const head = isRoot ? '' : `${rails}${isLast ? '└─' : '├─'}`
  const body = isRoot ? rail(hasKids) : `${rails}${rail(!isLast)}${rail(hasKids)}`
  const alerts = isRoot || n.status === 'running'
  const mute = (runs: Run[]) => (n.status === 'done' ? runs.map(r => dim(r.text)) : runs)
  const desc = truncate(n.description, TEXT_MAX)
  const own: Line[] = [
    {
      key: `${n.id}:head`,
      gutter: head,
      runs: mute([
        glyphOf(n.status),
        plain(' '),
        { text: truncate(n.title, TITLE_MAX), bold: true },
        ...(tier.descOnHead && desc ? [plain('  '), plain(desc)] : []),
      ]),
      right: n.model === undefined ? undefined : dim(truncate(n.model, MODEL_MAX)),
    },
  ]
  if (!tier.descOnHead && desc) own.push({ key: `${n.id}:desc`, gutter: body, runs: mute([plain(desc)]) })
  const counts = join(countSegments(n.parts))
  const ctx = join(ctxSegments(n, tier, alerts))
  if (tier.splitMetrics) {
    if (counts.length > 0) own.push({ key: `${n.id}:count`, gutter: body, runs: mute(counts) })
    own.push({ key: `${n.id}:ctx`, gutter: body, runs: mute(ctx) })
  } else {
    own.push({ key: `${n.id}:metrics`, gutter: body, runs: mute(join([counts, ctx])) })
  }
  if (n.activity && (n.status === 'running' || isRoot)) own.push({ key: `${n.id}:act`, gutter: body, runs: [dim(truncate(n.activity, TEXT_MAX))] })
  const childRails = isRoot ? '' : `${rails}${rail(!isLast)}`
  return [...own, ...n.children.flatMap((c, i) => nodeLines(c, tier, childRails, i === n.children.length - 1))]
}

const runText = (Text: Els['Text'], key: string, r: Run) => (
  <Text key={key} color={r.color} dimColor={r.dim} bold={r.bold}>
    {r.text}
  </Text>
)

const maxDepthOf = (n: GraphNode): number => Math.max(n.depth, ...n.children.map(maxDepthOf))

export const drawText = (els: Els, root: GraphNode, columns: number) => {
  const { Box, Text } = els
  return nodeLines(root, tierOf(columns - 2 * (maxDepthOf(root) + 1)), '', true).map(line => (
    <Box key={line.key}>
      {line.gutter ? (
        <Box key="g" flexShrink={0}>
          <Text dimColor>{line.gutter}</Text>
        </Box>
      ) : null}
      <Box key="c" flexGrow={1} flexShrink={1}>
        <Text wrap="truncate">{line.runs.map((r, i) => runText(Text, `r${i}`, r))}</Text>
      </Box>
      {line.right ? (
        <Box key="m" flexShrink={0} marginLeft={2}>
          {runText(Text, 'm', line.right)}
        </Box>
      ) : null}
    </Box>
  ))
}
