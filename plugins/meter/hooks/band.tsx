import type { RenderElement } from 'claude-code'

import type { CacheStats, Measure, ResolvedModel } from '../types'
import { type Els, type Run, type Surface, dimRun, drawGauge, runsText, runsWidth, toneRun } from './draw'
import { type Tone, cacheState, fmtDuration, fmtTokens, hitRate, hitTone, limitLabel, loadTone } from './format'

type BandData = { measure: Measure | null; cache: CacheStats | null; model: ResolvedModel | null }
type BandOpts = { surface: Surface; bodyColumns: number; now: number; isWorking: boolean }

type Item =
  | { key: string; runs: Run[] }
  | { key: string; gauge: { pct: number; tone: Tone; cells: number; px: number }; alt: string }
type Segment = { key: string; items: Item[] }

type Detail = {
  tokens: boolean
  limitGauges: boolean
  cacheWords: boolean
  resets: boolean
  gap: number
  ctxCells: number
  ctxLabel: string
}

const CTX_PX = 56
const LIMIT_PX = 36
const LIMIT_CELLS = 6
const DESKTOP_LIMIT_GAUGES = 80

const FULL: Detail = {
  tokens: true,
  limitGauges: true,
  cacheWords: true,
  resets: true,
  gap: 3,
  ctxCells: 10,
  ctxLabel: 'Context',
}

const STEPS: Partial<Detail>[] = [
  {},
  { tokens: false },
  { limitGauges: false },
  { cacheWords: false },
  { resets: false },
  { gap: 2 },
  { ctxCells: 6 },
  { ctxCells: 0 },
  { ctxLabel: 'Ctx' },
]

const BAND_LEVELS: Detail[] = STEPS.reduce<Detail[]>((levels, step) => [...levels, { ...(levels.at(-1) ?? FULL), ...step }], [])

const desktopDetail = (cols: number): Detail => ({
  tokens: false,
  limitGauges: cols >= DESKTOP_LIMIT_GAUGES,
  cacheWords: true,
  resets: true,
  gap: 3,
  ctxCells: 10,
  ctxLabel: 'Context',
})

const text = (key: string, ...runs: Run[]): Item => ({ key, runs })
const label = (name: string) => text('label', dimRun(name))

const buildSegments = (data: BandData, detail: Detail, opts: BandOpts): Segment[] => {
  const { measure, cache } = data
  const segments: Segment[] = []

  const ctx = measure?.context
  if (ctx) {
    const pct = ctx.percent
    const items: Item[] = [text('label', dimRun(detail.ctxLabel))]
    if (pct === undefined) {
      items.push(text('v', dimRun(`${fmtTokens(ctx.window)} window`)))
    } else {
      const tone = loadTone(pct)
      if (detail.ctxCells > 0) {
        items.push({ key: 'bar', gauge: { pct, tone, cells: detail.ctxCells, px: CTX_PX }, alt: `Context ${pct}%` })
      }
      items.push(text('v', toneRun(`${pct}%`, tone)))
      if (detail.tokens && ctx.tokens !== undefined) {
        items.push(text('t', dimRun(`${fmtTokens(ctx.tokens)} / ${fmtTokens(ctx.window)}`)))
      }
    }
    segments.push({ key: 'ctx', items })
  }

  if (cache) {
    const hit = hitRate(cache.lastRead, cache.lastWrite, cache.lastUncached)
    const state = cacheState(cache.lastAt, opts.now, opts.isWorking)
    const value =
      hit === null
        ? text('v', dimRun('-'))
        : text('v', ...(detail.cacheWords ? [toneRun(`${hit}%`, hitTone(hit)), dimRun(' hit')] : [toneRun(`${hit}%`, hitTone(hit))]))
    segments.push({
      key: 'cache',
      items: [label('Cache'), value, text('s', { text: '●', color: state.dot }, dimRun(` ${detail.cacheWords ? state.text : state.short}`))],
    })
  }

  for (const l of measure?.rateLimits ?? []) {
    const name = limitLabel(l.kind)
    const pct = Math.round(l.percentUsed)
    const resetIn = l.resetsAt ? Date.parse(l.resetsAt) - opts.now : NaN
    const tone: Tone = Number.isFinite(resetIn) && resetIn <= 0 ? 'idle' : loadTone(pct)
    const items: Item[] = [label(name)]
    if (detail.limitGauges) {
      items.push({ key: 'bar', gauge: { pct, tone, cells: LIMIT_CELLS, px: LIMIT_PX }, alt: `${name} limit ${pct}%` })
    }
    items.push(text('v', toneRun(`${pct}%`, tone)))
    if (detail.resets && resetIn > 0) items.push(text('r', dimRun(`↻ ${fmtDuration(resetIn)}`)))
    segments.push({ key: `limit-${l.kind}`, items })
  }

  if (measure?.cost) segments.push({ key: 'cost', items: [text('v', { text: `$${measure.cost.usd.toFixed(2)}` })] })

  return segments
}

const itemWidth = (item: Item) => ('gauge' in item ? item.gauge.cells : runsWidth(item.runs))

const rowWidth = (segments: readonly Segment[], gap: number) =>
  segments.reduce((n, s) => n + s.items.reduce((w, item) => w + itemWidth(item), 0) + s.items.length - 1, 0) +
  gap * Math.max(0, segments.length - 1)

const pickTerminal = (data: BandData, opts: BandOpts) => {
  for (const detail of BAND_LEVELS) {
    const segments = buildSegments(data, detail, opts)
    if (rowWidth(segments, detail.gap) <= opts.bodyColumns) return { detail, segments, isFloor: false }
  }
  const detail = BAND_LEVELS.at(-1)!

  return { detail, segments: buildSegments(data, detail, opts), isFloor: true }
}

const bandDetails = (data: BandData, now: number): [string, string][] => {
  const { measure, cache, model } = data
  const details: [string, string][] = []
  const ctx = measure?.context
  if (model) {
    const parts = [model.name]
    if (model.fallbackFrom) parts.push(`fallback from ${model.fallbackFrom}`)
    if (model.effort) parts.push(`${model.effort} effort`)
    if (model.id !== model.name) parts.push(model.id)
    details.push(['Model', parts.join(' · ')])
  }
  if (ctx?.tokens !== undefined) {
    details.push(['Context', `${ctx.tokens.toLocaleString()} of ${ctx.window.toLocaleString()} tokens`])
  }
  if (cache) {
    const { idle, ttlLeft } = cacheState(cache.lastAt, now, false)
    details.push(['Last request', `${fmtTokens(cache.lastRead)} read · ${fmtTokens(cache.lastWrite)} written · ${fmtTokens(cache.lastUncached)} uncached`])
    const sess = hitRate(cache.totalRead, cache.totalWrite, cache.totalUncached)
    details.push(['Session cache', `${sess ?? '-'}% hit · ${fmtTokens(cache.totalRead)} read · ${fmtTokens(cache.totalWrite)} written`])
    details.push(['Cache TTL', ttlLeft > 0 ? `~${fmtDuration(ttlLeft)} left (idle ${fmtDuration(idle)}, assumes 1h)` : `expired ${fmtDuration(-ttlLeft)} ago`])
  }
  for (const l of measure?.rateLimits ?? []) {
    if (l.resetsAt && Date.parse(l.resetsAt) > now) {
      const at = new Date(l.resetsAt)
      details.push([`${limitLabel(l.kind)} limit`, `${Math.round(l.percentUsed)}% used · resets ${at.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`])
    }
  }

  return details
}

export const drawBand = (els: Els, data: BandData, opts: BandOpts): RenderElement | null => {
  const { Box, Text } = els
  const isTerminal = opts.surface === 'terminal'
  if (!data.measure && !data.cache) return null

  const { detail, segments, isFloor } = isTerminal
    ? pickTerminal(data, opts)
    : (() => {
        const detail = desktopDetail(opts.bodyColumns)

        return { detail, segments: buildSegments(data, detail, opts), isFloor: false }
      })()
  if (segments.length === 0) return null

  const details = bandDetails(data, opts.now)
  const labelWidth = Math.max(...details.map(([k]) => k.length))

  const card =
    details.length === 0 ? null : isTerminal ? (
      <Box
        key="card"
        position="absolute"
        top={-(details.length + 2)}
        left={0}
        display="none"
        hover={{ display: 'flex', scope: 'meter' }}
        flexDirection="column"
        borderStyle="round"
        borderDimColor
        paddingX={1}
      >
        {details.map(([k, v]) => (
          <Box key={k}>
            <Text dimColor>{k.padEnd(labelWidth + 2)}</Text>
            <Text wrap="truncate">{v}</Text>
          </Box>
        ))}
      </Box>
    ) : (
      <Box key="card" display="none" hover={{ display: 'flex', scope: 'meter' }} flexDirection="column" marginBottom={1}>
        {details.map(([k, v]) => (
          <Box key={k} columnGap={2}>
            <Box width={labelWidth + 1}>
              <Text dimColor>{k}</Text>
            </Box>
            <Text>{v}</Text>
          </Box>
        ))}
      </Box>
    )

  const draw = (item: Item) =>
    'gauge' in item
      ? drawGauge(els, opts.surface, item.key, item.gauge.pct, item.gauge.tone, item.gauge, item.alt)
      : runsText(Text, item.key, item.runs)

  return (
    <Box key="meter" flexDirection="column" marginTop={isTerminal ? 1 : undefined} hover={{ scope: 'meter' }}>
      {card}
      <Box key="row" flexWrap={isFloor || !isTerminal ? 'wrap' : 'nowrap'} alignItems="center" columnGap={detail.gap}>
        {segments.map(s => (
          <Box key={s.key} alignItems="center" columnGap={1}>
            {s.items.map(draw)}
          </Box>
        ))}
      </Box>
    </Box>
  )
}
