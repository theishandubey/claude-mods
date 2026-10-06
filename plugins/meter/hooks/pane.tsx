import type { Elements, RenderChildren } from 'claude-code'

import type {
  AgentStats,
  BreakdownState,
  CacheStats,
  CompactionStats,
  Measure,
  RequestStats,
  ResolvedModel,
  SessionInfo,
  SnapCategory,
  ToolStat,
  Trends,
  TurnStats,
} from '../types'
import {
  cacheState,
  clean,
  fmtAgo,
  fmtClock,
  fmtDate,
  fmtDuration,
  fmtMs,
  fmtTokens,
  fmtTokens1,
  type Tone,
  hitRate,
  hitTone,
  limitLabel,
  loadTone,
  modelId,
  shortId,
  sparkGlyphs,
} from './format'
import { pace } from './metrics'
import { type Els, type Run, dimRun, drawGauge, runText, textWidth, toneRun } from './draw'
import { type SvgDoc, barsSvg, gridSvg, memoized, slotMap, swatchSvg } from './svg'

export type PaneData = {
  measure: Measure | null
  cache: CacheStats | null
  requests: RequestStats
  turns: TurnStats
  tools: Record<string, ToolStat>
  agents: AgentStats
  compactions: CompactionStats
  trends: Trends
  breakdown: BreakdownState
  info: SessionInfo | null
  model: ResolvedModel | null
  expanded: string[]
}

export type PaneActions = {
  refresh: () => Promise<void>
  toggleExpanded: (section: string) => Promise<void>
  close: () => Promise<void>
}

export type PaneOpts = { surface: 'terminal' | 'desktop'; bodyColumns: number; now: number }

const STALE_FRACTION = 0.02
const TOP = { tools: 10, subagents: 10, memory: 5, mcp: 5 }
const LABEL = 14
const PERCENT = 5
const LIMIT_MIN_CELLS = 4
const COMPACTION_AGO_MIN = 40
const GAUGE_PX = { wide: 280, medium: 200, narrow: 140 }
const LIMIT_SIZE = {
  wide: { cells: 24, px: 160 },
  medium: { cells: 16, px: 112 },
  narrow: { cells: 10, px: 72 },
}

const plural = (n: number, one: string) => (n === 1 ? one : `${one}s`)

type Col = { label: string; width?: number; align?: 'right' }

export const drawPane = (els: Els, data: PaneData, actions: PaneActions, opts: PaneOpts) => {
  const { Box, Text, Button } = els
  const isTerminal = opts.surface === 'terminal'
  const Svg = isTerminal ? null : (els as Elements['desktop']).Svg
  const cols = opts.bodyColumns
  const now = opts.now
  const tier = cols >= 80 ? 'wide' : cols >= 56 ? 'medium' : 'narrow'
  const { measure, cache, requests, turns, tools, agents, compactions, trends, breakdown, info, model, expanded } = data
  const { snap, status } = breakdown
  const ctx = measure?.context
  const isLoading = status.state === 'loading'

  const svg = (key: string, doc: SvgDoc) =>
    Svg ? <Svg key={key} source={doc.source} width={doc.width} height={doc.height} alt={doc.alt} /> : null

  const dim = (key: string, text: string) => (
    <Text key={key} dimColor wrap="truncate">
      {text}
    </Text>
  )

  const line = (key: string, text: string) => (
    <Text key={key} wrap="truncate">
      {text}
    </Text>
  )

  const headRow = (title: string, isBold: boolean, summary: RenderChildren | undefined, isDim: boolean) => (
    <Box key={`h-${title}`} columnGap={2} justifyContent="space-between">
      <Box key="title" flexShrink={0}>
        <Text bold={isBold}>{title}</Text>
      </Box>
      {summary ? (
        <Box key="summary" flexShrink={1}>
          <Text dimColor={isDim} wrap="truncate">
            {summary}
          </Text>
        </Box>
      ) : null}
    </Box>
  )

  const heading = (title: string, right?: RenderChildren) => headRow(title, true, right, false)

  const rich = (parts: (Run | string)[]): RenderChildren =>
    parts.map((p, i) => (typeof p === 'string' ? p : runText(Text, `p${i}`, p)))

  const subheading = (title: string, right?: string) => headRow(title, false, right, true)

  const kv = (key: string, label: string, value: RenderChildren, wrap: 'truncate' | 'truncate-start' = 'truncate') => (
    <Box key={key}>
      <Box key="k" width={LABEL} flexShrink={0}>
        <Text dimColor wrap="truncate">
          {label}
        </Text>
      </Box>
      <Box key="v" flexGrow={1}>
        {typeof value === 'string' ? <Text wrap={wrap}>{value}</Text> : value}
      </Box>
    </Box>
  )

  const section = (key: string, children: RenderChildren[]) => (
    <Box key={key} flexDirection="column" marginTop={1}>
      {children.filter(c => c !== null && c !== undefined && c !== false)}
    </Box>
  )

  const cell = (col: Col, text: string, key: string, isHeader: boolean, isLast: boolean) =>
    col.width === undefined ? (
      <Box key={key} flexGrow={1} marginRight={isLast ? 0 : 1}>
        <Text dimColor={isHeader} wrap="truncate-middle">
          {text}
        </Text>
      </Box>
    ) : (
      <Box key={key} width={col.width} justifyContent={col.align === 'right' ? 'flex-end' : 'flex-start'}>
        <Text dimColor={isHeader} wrap="truncate">
          {text}
        </Text>
      </Box>
    )

  const table = (key: string, columns: Col[], rows: string[][], hasHeader = true) => (
    <Box key={key} flexDirection="column">
      {hasHeader ? (
        <Box key="head">{columns.map((c, i) => cell(c, c.label, `c${i}`, true, i === columns.length - 1))}</Box>
      ) : null}
      {rows.map((row, r) => (
        <Box key={`r${r}`}>{columns.map((c, i) => cell(c, row[i] ?? '', `c${i}`, false, i === columns.length - 1))}</Box>
      ))}
    </Box>
  )

  const moreButton = (name: string, total: number, limit: number) =>
    total > limit ? (
      <Button
        key={`more-${name}`}
        dimColor
        label={expanded.includes(name) ? 'Show fewer' : `+${total - limit} more`}
        onPress={() => {
          void actions.toggleExpanded(name)
        }}
      />
    ) : null

  const limited = <T,>(name: string, items: T[], limit: number) => (expanded.includes(name) ? items : items.slice(0, limit))

  const valueCols = Math.max(1, cols - LABEL)
  const sparkWidth = Math.min(valueCols, 40, Math.max(8, cols - LABEL - 20))

  const sparkline = (
    key: string,
    values: number[],
    max: number,
    toneOf: ((v: number) => Tone) | undefined,
    alt: string,
    label?: string,
  ) => {
    if (!isTerminal) {
      const bars = barsSvg(values, max, toneOf ? values.map(toneOf) : undefined, alt)

      return (
        <Box key={key} columnGap={2} alignItems="flex-end">
          {svg('bars', bars)}
          {label ? <Text dimColor>{label}</Text> : null}
        </Box>
      )
    }
    const runs: { tone: Tone; text: string }[] = []
    sparkGlyphs(values, max).forEach((g, i) => {
      const tone = toneOf?.(values[i]!) ?? 'rest'
      const last = runs.at(-1)
      if (last && last.tone === tone) last.text += g
      else runs.push({ tone, text: g })
    })

    return (
      <Box key={key} columnGap={2}>
        <Text key="bars">
          {runs.map((run, i) =>
            runText(Text, `run${i}`, run.tone === 'rest' ? dimRun(run.text) : { text: run.text, color: run.tone }),
          )}
        </Text>
        {label && values.length + 2 + textWidth(label) <= valueCols ? <Text dimColor>{label}</Text> : null}
      </Box>
    )
  }

  const refreshLabel = isLoading ? 'Refreshing' : status.state === 'error' ? 'Retry' : snap ? 'Refresh' : 'Count'

  const header = () => {
    const facts = [
      info ? `up ${fmtDuration(now - info.startedAt)}` : null,
      measure?.cost ? `$${measure.cost.usd.toFixed(2)}` : null,
    ].filter(Boolean)

    const refreshWidth = textWidth(refreshLabel) + 4
    const whoWidth = Math.max(0, cols - refreshWidth - 2)
    const shownName = model?.name ?? 'Model not known yet'
    const effortText = model?.effort ? `${model.effort} effort` : null
    const fallbackText = model?.fallbackFrom ? `fallback from ${model.fallbackFrom}` : null
    const withoutEffort = textWidth(shownName) + (fallbackText ? 2 + textWidth(fallbackText) : 0)
    const isEffortShown = effortText !== null && withoutEffort + 2 + textWidth(effortText) <= whoWidth

    return (
      <Box key="header" flexDirection="column">
        <Box key="top" columnGap={2} alignItems="center">
          <Box key="who" flexGrow={1} flexShrink={1} columnGap={2}>
            {model ? (
              <Text key="name" bold wrap="truncate">
                {model.name}
              </Text>
            ) : (
              <Text key="name" dimColor>
                Model not known yet
              </Text>
            )}
            {model?.fallbackFrom ? (
              <Text key="fallback" color="warning" wrap="truncate">
                {`fallback from ${model.fallbackFrom}`}
              </Text>
            ) : null}
            {isEffortShown ? (
              <Text key="effort" dimColor>
                {effortText}
              </Text>
            ) : null}
          </Box>
          <Box key="refresh-box" flexShrink={0}>
            <Button
              key="refresh"
              hotkey="r"
              label={refreshLabel}
              onPress={
                isLoading
                  ? () => {}
                  : () => {
                      void actions.refresh()
                    }
              }
            />
          </Box>
        </Box>
        {facts.length ? (
          <Text key="facts" dimColor wrap="truncate">
            {facts.join(' · ')}
          </Text>
        ) : null}
      </Box>
    )
  }

  const isStale = () => {
    if (!snap || snap.contextTokens === undefined) return false
    const lastCompaction = compactions.recent.at(-1)
    if (lastCompaction && lastCompaction.at > snap.at) return true
    if (ctx?.tokens === undefined) return false

    return Math.abs(ctx.tokens - snap.contextTokens) > STALE_FRACTION * ctx.window
  }

  const contextSection = () => {
    const out: RenderChildren[] = []
    const pct = ctx?.percent
    const hasLive = ctx?.tokens !== undefined && pct !== undefined
    const tone = pct === undefined ? 'rest' : loadTone(pct)
    out.push(
      heading(
        'Context',
        hasLive
          ? rich([toneRun(`${pct}%`, tone), ` · ${fmtTokens(ctx.tokens!)} / ${fmtTokens(ctx.window)}`])
          : ctx
            ? `${fmtTokens(ctx.window)} window`
            : undefined,
      ),
    )
    if (hasLive) {
      out.push(
        drawGauge(els, opts.surface, 'gauge', pct, tone, { cells: Math.min(64, cols), px: GAUGE_PX[tier], height: 8 }, `Context ${pct}%`),
      )
    }
    if (snap) {
      out.push(
        kv(
          'auto-compact',
          'Auto-compact',
          snap.isAutoCompactEnabled && snap.autoCompactThreshold !== undefined
            ? `at ${fmtTokens(snap.autoCompactThreshold)}${
                ctx?.tokens !== undefined ? `, ${fmtTokens(Math.max(0, snap.autoCompactThreshold - ctx.tokens))} to go` : ''
              }`
            : 'off',
        ),
      )
    }
    if (requests.messageCount > 0) out.push(kv('messages', 'Messages', String(requests.messageCount)))

    if (!snap) {
      out.push(
        isLoading
          ? dim('state', 'Counting…')
          : status.state === 'error'
            ? line('state', 'Could not count the context')
            : hasLive
              ? line('state', 'Breakdown not counted')
              : dim('state', 'No reply yet. Figures appear after the first response.'),
      )

      return section('context', out)
    }

    out.push(breakdownBody())
    const stateParts = [`${snap.detail === 'summary' ? 'Estimated' : 'Counted'} ${fmtAgo(now - snap.at)}`]
    if (isStale()) stateParts.push('context changed since; Refresh')
    out.push(dim('counted', stateParts.join(' · ')))
    if (isLoading) out.push(dim('state', 'Counting…'))
    if (status.state === 'error') out.push(line('state', 'Could not count the context'))
    out.push(...listings())

    return section('context', out)
  }

  const breakdownBody = () => {
    const s = snap!
    const squares = s.squares
    let perRow = squares.length > 100 ? 20 : 10
    if (perRow * 2 > cols - 2) perRow = 10
    if (perRow * 2 > cols - 2) perRow = 5
    const slots = slotMap(s.categories)
    const legendCategories = s.categories.filter(c => c.kind !== 'deferred')
    const pctOf = (c: SnapCategory) => Math.round((c.tokens / Math.max(1, s.rawMaxTokens)) * 100)
    const isSideBySide = isTerminal ? cols >= perRow * 2 + 34 : cols >= 80

    const used = s.categories
      .filter(c => c.kind === 'used')
      .sort((a, b) => b.tokens - a.tokens)
    const alt = `Context ${Math.round(s.percentage)}%: ${used
      .slice(0, 6)
      .map(c => `${c.name} ${fmtTokens(c.tokens)}`)
      .join(', ')}${used.length > 6 ? ', …' : ''}`

    const rows: RenderChildren[] = []
    if (isTerminal) {
      for (let r = 0; r * perRow < squares.length; r++) {
        const row = squares.slice(r * perRow, (r + 1) * perRow)
        const runs: { category: string; color: string; kind: string; text: string }[] = []
        for (const q of row) {
          const glyph = q.kind === 'used' ? (q.fullness >= 0.7 ? '■ ' : '□ ') : q.kind === 'buffer' ? '▪ ' : '· '
          const last = runs.at(-1)
          if (last && last.category === q.category) last.text += glyph
          else runs.push({ category: q.category, color: q.color, kind: q.kind, text: glyph })
        }
        rows.push(
          <Text key={`grid-${r}`}>
            {runs.map((run, i) => (
              <Text key={`grid-${r}-${i}`} color={run.color} dimColor={run.kind !== 'used'}>
                {run.text}
              </Text>
            ))}
          </Text>,
        )
      }
    }

    const docs = isTerminal
      ? null
      : memoized(
          [s.at, cols, squares.length, s.rawMaxTokens, s.percentage, ...s.categories.map(c => `${c.name}:${c.kind}:${c.tokens}`)].join('|'),
          () => ({
            grid: gridSvg(squares, perRow, slots, alt),
            marks: legendCategories.map(c =>
              swatchSvg(c.kind === 'used' ? slots[c.name] : undefined, `${c.name} ${fmtTokens1(c.tokens)}, ${pctOf(c)}%`),
            ),
          }),
        )

    const legendRow = (c: SnapCategory, i: number) => (
      <Box key={`legend-${i}`} columnGap={1} alignItems="center">
        {isTerminal ? (
          <Text key="mark" color={c.color} dimColor={c.kind !== 'used'}>
            {c.kind === 'used' ? '■' : c.kind === 'buffer' ? '▪' : '·'}
          </Text>
        ) : (
          docs && svg('mark', docs.marks[i]!)
        )}
        <Box key="name" flexGrow={1}>
          <Text wrap="truncate-middle">{c.name}</Text>
        </Box>
        <Box key="tokens" width={7} justifyContent="flex-end">
          <Text>{fmtTokens1(c.tokens)}</Text>
        </Box>
        <Box key="pct" width={PERCENT} justifyContent="flex-end">
          <Text>{`${pctOf(c)}%`}</Text>
        </Box>
      </Box>
    )

    const grid = isTerminal ? (
      <Box key="grid" flexDirection="column" width={perRow * 2}>
        {rows}
      </Box>
    ) : (
      <Box key="grid" flexDirection="column">
        {docs && svg('grid-svg', docs.grid)}
      </Box>
    )
    const legend = (
      <Box key="legend" flexDirection="column" flexGrow={1} marginLeft={isSideBySide ? 2 : 0} marginTop={isSideBySide ? 0 : 1}>
        {legendCategories.map(legendRow)}
      </Box>
    )

    return (
      <Box key="breakdown" flexDirection={isSideBySide ? 'row' : 'column'} marginTop={1}>
        {grid}
        {legend}
      </Box>
    )
  }

  const listings = () => {
    const s = snap!
    const out: RenderChildren[] = []
    const memoryRows = limited('memory', s.memoryFiles, TOP.memory)
    out.push(
      <Box key="memory" flexDirection="column" marginTop={1}>
        {subheading('Memory files', s.memoryTotal.count > 0 ? `${s.memoryTotal.count} · ${fmtTokens1(s.memoryTotal.tokens)}` : undefined)}
        <Box key="rows" flexDirection="column" marginLeft={2}>
          {s.memoryTotal.count === 0
            ? dim('none', 'No memory files')
            : table(
                'memory-rows',
                [{ label: '' }, { label: '', width: 9 }, { label: '', width: 7, align: 'right' }],
                memoryRows.map(f => [f.path, f.type, fmtTokens1(f.tokens)]),
                false,
              )}
          {moreButton('memory', s.memoryFiles.length, TOP.memory)}
        </Box>
      </Box>,
    )
    const mcpTools = s.mcpServers.reduce((n, m) => n + m.tools, 0)
    const mcpTokens = s.mcpServers.reduce((n, m) => n + m.tokens, 0)
    out.push(
      <Box key="mcp" flexDirection="column" marginTop={1}>
        {subheading(
          'MCP',
          s.mcpServers.length > 0
            ? `${s.mcpServers.length} ${plural(s.mcpServers.length, 'server')} · ${mcpTools} ${plural(mcpTools, 'tool')} · ${fmtTokens1(mcpTokens)}`
            : undefined,
        )}
        <Box key="rows" flexDirection="column" marginLeft={2}>
          {s.mcpServers.length === 0
            ? dim('none', 'No MCP tools')
            : table(
                'mcp-rows',
                [{ label: '' }, { label: '', width: 10, align: 'right' }, { label: '', width: 7, align: 'right' }],
                limited('mcp', s.mcpServers, TOP.mcp).map(m => [
                  m.server,
                  `${m.loaded < m.tools ? `${m.loaded}/` : ''}${m.tools} ${plural(m.tools, 'tool')}`,
                  fmtTokens1(m.tokens),
                ]),
                false,
              )}
          {moreButton('mcp', s.mcpServers.length, TOP.mcp)}
        </Box>
      </Box>,
    )
    const extras = [
      s.skills ? `skills ${s.skills.included} of ${s.skills.total} listed (${fmtTokens1(s.skills.tokens)})` : null,
      s.agents.length > 0 ? `agents ${s.agents.length} (${fmtTokens1(s.agents.reduce((n, a) => n + a.tokens, 0))})` : null,
      s.slashCommands ? `slash commands ${s.slashCommands.included} of ${s.slashCommands.total} (${fmtTokens1(s.slashCommands.tokens)})` : null,
    ].filter(Boolean)
    if (extras.length > 0) {
      out.push(
        <Box key="extras" flexDirection="column" marginTop={1}>
          {dim('extras', `Also in context: ${extras.join(' · ')}`)}
        </Box>,
      )
    }

    return out
  }

  const cacheSection = () => {
    const hits = requests.history.flatMap(s => (s.hit === null ? [] : [s.hit])).slice(-sparkWidth)
    if (!cache && requests.history.length === 0) return section('cache', [heading('Prompt cache'), dim('none', 'None yet')])

    const out: RenderChildren[] = []
    let right: RenderChildren
    if (cache) {
      const hit = hitRate(cache.lastRead, cache.lastWrite, cache.lastUncached)
      const state = cacheState(cache.lastAt, now, false)
      right = rich([
        hit === null ? dimRun('- hit') : toneRun(`${hit}% hit`, hitTone(hit)),
        ' · ',
        { text: '●', color: state.dot },
        ` ${state.text}`,
      ])
    }
    out.push(heading('Prompt cache', right))
    if (cache) {
      const sess = hitRate(cache.totalRead, cache.totalWrite, cache.totalUncached)
      out.push(
        kv(
          'session',
          'Session',
          `${sess === null ? '-' : `${sess}%`} hit · ${fmtTokens(cache.totalRead)} read · ${fmtTokens(cache.totalWrite)} written · ${fmtTokens(cache.totalUncached)} uncached`,
        ),
      )
    }
    if (hits.length > 0) {
      const sorted = [...hits].sort((a, b) => a - b)
      const median = sorted[Math.floor(sorted.length / 2)]!
      out.push(
        kv(
          'trend',
          'Trend',
          sparkline(
            'hits',
            hits,
            100,
            hitTone,
            `Cache hit, last ${hits.length} ${plural(hits.length, 'request')}: latest ${hits.at(-1)}%, median ${median}%, min ${sorted[0]}%`,
            `last ${hits.length} ${plural(hits.length, 'request')}`,
          ),
        ),
      )
    }
    const timed = requests.history
    if (timed.length > 0) {
      const totalMs = timed.reduce((n, s) => n + s.ms, 0)
      const totalOut = timed.reduce((n, s) => n + s.output, 0)
      const avg = fmtMs(totalMs / timed.length)
      out.push(kv('speed', 'Speed', `avg ${avg} per request${totalMs > 0 ? ` · ${Math.round(totalOut / (totalMs / 1000))} tok/s` : ''}`))
    }

    return section('cache', out)
  }

  const limitsSection = () => {
    const limits = measure?.rateLimits ?? []
    if (limits.length === 0) {
      return section('limits', [heading('Usage limits'), dim('none', 'No usage-limit readings (API key, or no reply yet)')])
    }
    const rows = limits.map(l => {
      const kind = clean(l.kind)
      const pct = Math.round(l.percentUsed)
      const resetMs = l.resetsAt ? Date.parse(l.resetsAt) : NaN
      const resetIn = Number.isFinite(resetMs) ? resetMs - now : NaN
      const isPast = Number.isFinite(resetIn) && resetIn <= 0
      const tone: Tone = isPast ? 'idle' : loadTone(pct)
      const reset =
        resetIn > 0
          ? `resets ${fmtClock(resetMs, new Date(resetMs).toDateString() !== new Date(now).toDateString())} (in ${fmtDuration(resetIn)})`
          : null
      const burn = resetIn > 0 ? pace(trends.limits[kind] ?? [], now) : null
      const pacing = burn && burn.msTo100 < resetIn ? `At this pace 100% in ${fmtDuration(burn.msTo100)}, before reset` : null
      const size =
        tier === 'narrow'
          ? { ...LIMIT_SIZE.narrow, cells: Math.max(LIMIT_MIN_CELLS, Math.min(LIMIT_SIZE.narrow.cells, cols - LABEL - PERCENT)) }
          : LIMIT_SIZE[tier]
      const inRow = tier === 'wide' ? reset : tier === 'medium' && resetIn > 0 ? `in ${fmtDuration(resetIn)}` : null

      return (
        <Box key={`limit-${kind}`} flexDirection="column">
          <Box alignItems="center">
            <Box key="label" width={LABEL} flexShrink={0}>
              <Text dimColor wrap="truncate">
                {limitLabel(kind)}
              </Text>
            </Box>
            {drawGauge(els, opts.surface, 'gauge', pct, tone, size, `${limitLabel(kind)} limit ${pct}%`)}
            <Box key="pct" width={5} justifyContent="flex-end">
              {runText(Text, 'pct', toneRun(`${pct}%`, tone))}
            </Box>
            {inRow ? (
              <Box key="reset" marginLeft={2}>
                {dim('reset', inRow)}
              </Box>
            ) : null}
          </Box>
          {tier === 'narrow' && reset ? (
            <Box key="reset" marginLeft={LABEL}>
              {dim('reset', reset)}
            </Box>
          ) : null}
          {pacing ? (
            <Box key="pace" marginLeft={LABEL}>
              {dim('pace', pacing)}
            </Box>
          ) : null}
        </Box>
      )
    })

    return section('limits', [heading('Usage limits'), ...rows])
  }

  const tokensSection = () => {
    const total = {
      input: requests.main.input + requests.agents.input,
      output: requests.main.output + requests.agents.output,
      cacheRead: requests.main.cacheRead + requests.agents.cacheRead,
      cacheWrite: requests.main.cacheWrite + requests.agents.cacheWrite,
      requests: requests.main.requests + requests.agents.requests,
    }
    if (total.requests === 0 && requests.noResponse === 0) return section('tokens', [heading('Tokens'), dim('none', 'None yet')])

    const out: RenderChildren[] = [heading('Tokens', `${total.requests} ${plural(total.requests, 'request')}`)]
    if (tier === 'narrow') {
      out.push(
        table(
          'totals',
          [{ label: '' }, { label: '', width: 8, align: 'right' }],
          [
            ['Input', fmtTokens(total.input)],
            ['Output', fmtTokens(total.output)],
            ['Cache read', fmtTokens(total.cacheRead)],
            ['Cache write', fmtTokens(total.cacheWrite)],
          ],
          false,
        ),
      )
    } else {
      const row = (name: string, t: typeof total) => [
        name,
        fmtTokens(t.input),
        fmtTokens(t.output),
        fmtTokens(t.cacheRead),
        fmtTokens(t.cacheWrite),
        String(t.requests),
      ]
      out.push(
        table(
          'totals',
          [
            { label: '' },
            { label: 'Input', width: 8, align: 'right' },
            { label: 'Output', width: 8, align: 'right' },
            { label: 'Cache read', width: 12, align: 'right' },
            { label: 'Cache write', width: 13, align: 'right' },
            { label: 'Req', width: 6, align: 'right' },
          ],
          [row('Main', requests.main), row('Subagents', requests.agents), row('Total', total)],
        ),
      )
    }
    const models = Object.entries(requests.byModel).sort((a, b) => b[1].requests - a[1].requests)
    if (models.length > 0) {
      out.push(kv('models', 'Models', models.map(([m, t]) => `${modelId(m)} ${t.requests}`).join(' · ')))
    }
    if (requests.noResponse > 0) out.push(dim('no-response', `${requests.noResponse} ${plural(requests.noResponse, 'request')} got no response`))

    return section('tokens', out)
  }

  const costSection = () => {
    if (!measure?.cost) return section('cost', [heading('Cost'), dim('none', 'No cost ledger')])
    const deltas = trends.cost.slice(1).map((s, i) => s.usd - trends.cost[i]!.usd)
    const out: RenderChildren[] = [heading('Cost', `$${measure.cost.usd.toFixed(2)}`)]
    if (deltas.length > 0) {
      out.push(
        kv(
          'per-update',
          'Per update',
          `last $${deltas.at(-1)!.toFixed(2)} · avg $${(deltas.reduce((n, d) => n + d, 0) / deltas.length).toFixed(2)}`,
        ),
      )
    }
    const shown = deltas.slice(-sparkWidth)
    if (shown.length > 1) {
      out.push(
        kv('trend', 'Trend', sparkline('trend', shown, Math.max(...shown), undefined, `Cost per update, last ${shown.length}: latest $${shown.at(-1)!.toFixed(2)}`)),
      )
    }

    return section('cost', out)
  }

  const turnsSection = () => {
    if (turns.count === 0) return section('turns', [heading('Turns'), dim('none', 'None yet')])
    const out: RenderChildren[] = [
      heading('Turns', String(turns.count)),
      kv('duration', 'Duration', `avg ${fmtMs(turns.totalMs / turns.count)} · longest ${fmtMs(turns.longestMs)}`),
    ]
    const outcomes: string[] = []
    if (turns.aborted > 0) outcomes.push(`${turns.aborted} interrupted`)
    if (turns.refused > 0) outcomes.push(`${turns.refused} refused`)
    if (turns.errored > 0) outcomes.push(`${turns.errored} failed`)
    if (outcomes.length > 0) out.push(kv('outcomes', 'Outcomes', outcomes.join(' · ')))
    const shown = turns.recent.map(t => t.ms).slice(-sparkWidth)
    if (shown.length > 1) {
      out.push(
        kv('trend', 'Trend', sparkline('trend', shown, Math.max(...shown), undefined, `Turn durations, last ${shown.length}: latest ${fmtMs(shown.at(-1)!)}, longest ${fmtMs(Math.max(...shown))}`)),
      )
    }

    return section('turns', out)
  }

  const toolsSection = () => {
    const entries = Object.entries(tools).sort((a, b) => b[1].calls - a[1].calls)
    if (entries.length === 0) return section('tools', [heading('Tools'), dim('none', 'No tool calls yet')])
    const columns: Col[] = [
      { label: '' },
      { label: 'Calls', width: 7, align: 'right' },
      { label: 'Errors', width: 8, align: 'right' },
    ]
    if (tier !== 'narrow') columns.push({ label: 'Denied', width: 8, align: 'right' })
    if (tier === 'wide') columns.push({ label: 'Avg', width: 8, align: 'right' })
    const rows = limited('tools', entries, TOP.tools).map(([name, t]) =>
      [name, String(t.calls), String(t.errors), String(t.denied), fmtMs(t.totalMs / Math.max(1, t.calls))].slice(0, columns.length),
    )
    const fromAgents = entries.reduce((n, [, t]) => n + t.fromAgents, 0)

    const calls = entries.reduce((n, [, t]) => n + t.calls, 0)

    return section('tools', [
      heading('Tools', `${calls} ${plural(calls, 'call')}`),
      table('tools-rows', columns, rows),
      moreButton('tools', entries.length, TOP.tools),
      fromAgents > 0 ? dim('from-agents', `${fromAgents} calls came from subagents`) : null,
    ])
  }

  const subagentsSection = () => {
    const known = new Set(agents.list.map(a => a.id))
    const orphans = Object.entries(agents.usage).filter(([id]) => !known.has(id))
    if (agents.list.length === 0 && orphans.length === 0) {
      return section('subagents', [heading('Subagents'), dim('none', 'No subagents this session')])
    }
    const running = agents.list.filter(a => a.status === 'running').length
    const items = agents.list
      .map(a => ({ name: a.name ?? a.type, status: a.status, usage: agents.usage[a.id], isRunning: a.status === 'running' }))
      .sort((a, b) => Number(b.isRunning) - Number(a.isRunning) || (b.usage?.lastAt ?? 0) - (a.usage?.lastAt ?? 0))
    const forks = orphans.reduce(
      (n, [, u]) => ({ requests: n.requests + u.requests, input: n.input + u.input, output: n.output + u.output }),
      { requests: 0, input: 0, output: 0 },
    )
    const rowOf = (name: string, status: string, u?: { requests: number; input: number; output: number; model?: string }) => [
      name,
      status,
      u ? String(u.requests) : '-',
      u ? fmtTokens(u.input) : '-',
      u ? fmtTokens(u.output) : '-',
      u?.model ? modelId(u.model) : '-',
    ]
    const rows = limited('subagents', items, TOP.subagents).map(a => rowOf(a.name, a.status, a.usage))
    if (orphans.length > 0) rows.push(rowOf('Engine forks', '-', forks))
    const pick = (indexes: number[]) => rows.map(r => indexes.map(i => r[i] ?? ''))
    const table6 =
      tier === 'wide'
        ? table(
            'agents-rows',
            [
              { label: '' },
              { label: 'Status', width: 11 },
              { label: 'Req', width: 6, align: 'right' },
              { label: 'In', width: 7, align: 'right' },
              { label: 'Out', width: 7, align: 'right' },
              { label: 'Model', width: 14, align: 'right' },
            ],
            rows,
          )
        : tier === 'medium'
          ? table(
              'agents-rows',
              [
                { label: '' },
                { label: 'Status', width: 11 },
                { label: 'Req', width: 6, align: 'right' },
                { label: 'In', width: 7, align: 'right' },
                { label: 'Out', width: 7, align: 'right' },
              ],
              pick([0, 1, 2, 3, 4]),
            )
          : table(
              'agents-rows',
              [{ label: '' }, { label: 'Status', width: 10 }, { label: 'Out', width: 7, align: 'right' }],
              pick([0, 1, 4]),
            )

    return section('subagents', [
      heading('Subagents', `${running} running · ${agents.list.length} total`),
      table6,
      moreButton('subagents', items.length, TOP.subagents),
    ])
  }

  const compactionsSection = () => {
    if (compactions.count === 0 && compactions.subagentCount === 0) {
      const none = snap
        ? snap.isAutoCompactEnabled && snap.autoCompactThreshold !== undefined
          ? `None. Auto-compact at ${fmtTokens(snap.autoCompactThreshold)}${
              ctx?.tokens !== undefined ? ` (${fmtTokens(Math.max(0, snap.autoCompactThreshold - ctx.tokens))} to go)` : ''
            }`
          : 'None. Auto-compact is off'
        : 'None yet'

      return section('compactions', [heading('Compactions'), dim('none', none)])
    }
    const title = `${compactions.count}${compactions.subagentCount > 0 ? ` · ${compactions.subagentCount} in subagents` : ''}`
    const showAgo = cols >= COMPACTION_AGO_MIN
    const rows = [...compactions.recent].reverse().map(c => {
      const range = c.before !== undefined && c.after !== undefined ? `${fmtTokens(c.before)} → ${fmtTokens(c.after)}` : '-'

      return showAgo ? [c.trigger, range, fmtAgo(now - c.at)] : [c.trigger, range]
    })

    return section('compactions', [
      heading('Compactions', title),
      table(
        'compaction-rows',
        showAgo ? [{ label: '', width: 10 }, { label: '', width: 18 }, { label: '' }] : [{ label: '', width: 8 }, { label: '' }],
        rows,
        false,
      ),
    ])
  }

  const sessionSection = () => {
    if (!info) return section('session', [heading('Session'), dim('none', 'Not counted yet')])
    const started = `${fmtClock(info.startedAt, true)}${
      requests.trackedSince > info.startedAt + 60_000 ? ` · tracking since ${fmtClock(requests.trackedSince)}` : ''
    }`
    const builtAt = info.builtAt ? Date.parse(info.builtAt) : NaN

    return section('session', [
      heading('Session'),
      kv('id', 'Id', shortId(info.id)),
      model ? kv('model', 'Model', model.id) : null,
      kv('started', 'Started', started),
      kv('engine', 'Engine', `${info.version}${Number.isFinite(builtAt) ? ` (built ${fmtDate(builtAt)})` : ''}`),
      kv('dir', 'Dir', info.cwd, 'truncate-start'),
      kv('prompts', 'Prompts', String(info.prompts)),
    ])
  }

  return (
    <Box key="meter" flexDirection="column">
      {header()}
      {contextSection()}
      {limitsSection()}
      {cacheSection()}
      {costSection()}
      {tokensSection()}
      {turnsSection()}
      {toolsSection()}
      {subagentsSection()}
      {compactionsSection()}
      {sessionSection()}
      {isTerminal ? null : (
        <Box key="close-row" marginTop={1}>
          <Button
            key="close"
            role="dismiss"
            label="Close"
            onPress={() => {
              void actions.close()
            }}
          />
        </Box>
      )}
    </Box>
  )
}
