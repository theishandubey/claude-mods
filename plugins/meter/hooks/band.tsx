import type { Elements, RenderElement } from 'claude-code'

import type { CacheStats, Measure, ResolvedModel } from '../types'
import { type Run, dimRun, drawGauge, runsText, toneRun } from './draw'
import { type Tone, cacheState, fmtCost, fmtDuration, fmtSpan, fmtTokens, hitRate, hitTone, limitLabel, limitTone, loadTone, resetIn } from './format'

type BandData = { measure: Measure | null; cache: CacheStats | null; model: ResolvedModel | null }
type BandOpts = { bodyColumns: number; now: number; isWorking: boolean }

type Item =
  | { key: string; runs: Run[] }
  | { key: string; gauge: { pct: number; tone: Tone; px: number }; alt: string }
type Segment = { key: string; items: Item[] }

type Detail = { limitGauges: boolean }

const CTX_PX = 56
const LIMIT_PX = 36
const DESKTOP_LIMIT_GAUGES = 80

const desktopDetail = (cols: number): Detail => ({ limitGauges: cols >= DESKTOP_LIMIT_GAUGES })

const text = (key: string, ...runs: Run[]): Item => ({ key, runs })
const label = (name: string) => text('label', dimRun(name))

const buildSegments = (data: BandData, detail: Detail, opts: BandOpts): Segment[] => {
  const { measure, cache } = data
  const segments: Segment[] = []

  const ctx = measure?.context
  if (ctx) {
    const pct = ctx.percent
    const items: Item[] = [label('Context')]
    if (pct === undefined) {
      items.push(text('v', dimRun(`${fmtTokens(ctx.window)} window`)))
    } else {
      const tone = loadTone(pct)
      items.push({ key: 'bar', gauge: { pct, tone, px: CTX_PX }, alt: `Context ${pct}%` })
      items.push(text('v', toneRun(`${pct}%`, tone)))
    }
    segments.push({ key: 'ctx', items })
  }

  if (cache) {
    const hit = hitRate(cache.lastRead, cache.lastWrite, cache.lastUncached)
    const state = cacheState(cache.lastAt, opts.now, opts.isWorking)
    const value = hit === null ? text('v', dimRun('-')) : text('v', toneRun(`${hit}%`, hitTone(hit)), dimRun(' hit'))
    segments.push({
      key: 'cache',
      items: [label('Cache'), value, text('s', { text: '●', color: state.dot }, dimRun(` ${state.text}`))],
    })
  }

  for (const l of measure?.rateLimits ?? []) {
    const name = limitLabel(l.kind)
    const pct = Math.round(l.percentUsed)
    const left = resetIn(l, opts.now)
    const tone = limitTone(l, opts.now)
    const items: Item[] = [label(name)]
    if (detail.limitGauges) {
      items.push({ key: 'bar', gauge: { pct, tone, px: LIMIT_PX }, alt: `${name} limit ${pct}%` })
    }
    items.push(text('v', toneRun(`${pct}%`, tone)))
    if (left > 0) items.push(text('r', dimRun(`↻ ${fmtSpan(left)}`)))
    segments.push({ key: `limit-${l.kind}`, items })
  }

  if (measure?.cost) segments.push({ key: 'cost', items: [text('v', { text: fmtCost(measure.cost.usd) })] })

  return segments
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

export const drawBand = (els: Elements['desktop'], data: BandData, opts: BandOpts): RenderElement | null => {
  const { Box, Text, Svg } = els
  if (!data.measure && !data.cache) return null

  const segments = buildSegments(data, desktopDetail(opts.bodyColumns), opts)
  if (segments.length === 0) return null

  const details = bandDetails(data, opts.now)
  const labelWidth = Math.max(...details.map(([k]) => k.length))

  const card =
    details.length === 0 ? null : (
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
    'gauge' in item ? drawGauge(Svg, item.key, item.gauge.pct, item.gauge.tone, item.gauge.px, item.alt) : runsText(Text, item.key, item.runs)

  return (
    <Box key="meter" flexDirection="column" hover={{ scope: 'meter' }}>
      {card}
      <Box key="row" flexWrap="wrap" alignItems="center" columnGap={3}>
        {segments.map(s => (
          <Box key={s.key} alignItems="center" columnGap={1}>
            {s.items.map(draw)}
          </Box>
        ))}
      </Box>
    </Box>
  )
}
