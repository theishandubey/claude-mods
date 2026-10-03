import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type {
  AgentStats,
  BreakdownState,
  CompactionStats,
  Measure,
  RequestStats,
  Totals,
  Trends,
  TurnStats,
} from '../types'
import { SVG_COLORS, clean, fmtDuration, fmtTokens, hitColor, hitRate, limitLabel, loadColor } from './format'
import { drawPane } from './pane'
import { addAgentStep, addCompaction, addCost, addLimitSamples, addStep, addTool, addTurn, toSnap } from './metrics'

const cacheAtom = atom({ plugin: 'meter', key: 'cache' } as const, null)
const measureAtom = atom({ plugin: 'meter', key: 'measure' } as const, null)
const nowAtom = atom({ plugin: 'meter', key: 'now' } as const, 0)

const EMPTY_TOTALS: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 }
const EMPTY_REQUESTS: RequestStats = {
  trackedSince: 0,
  main: EMPTY_TOTALS,
  agents: EMPTY_TOTALS,
  byModel: {},
  noResponse: 0,
  history: [],
  lastModel: null,
  requestedModel: null,
  effort: null,
  messageCount: 0,
}
const EMPTY_TURNS: TurnStats = { count: 0, totalMs: 0, longestMs: 0, aborted: 0, errored: 0, refused: 0, recent: [] }
const EMPTY_AGENTS: AgentStats = { usage: {}, list: [] }
const EMPTY_COMPACTIONS: CompactionStats = { count: 0, subagentCount: 0, recent: [] }
const EMPTY_TRENDS: Trends = { cost: [], limits: {} }
const IDLE = { state: 'idle' } as const
const EMPTY_BREAKDOWN: BreakdownState = { snap: null, status: IDLE }

const requestsAtom = atom({ plugin: 'meter', key: 'requests' } as const, EMPTY_REQUESTS)
const turnsAtom = atom({ plugin: 'meter', key: 'turns' } as const, EMPTY_TURNS)
const toolsAtom = atom({ plugin: 'meter', key: 'tools' } as const, {})
const agentsAtom = atom({ plugin: 'meter', key: 'agents' } as const, EMPTY_AGENTS)
const compactionsAtom = atom({ plugin: 'meter', key: 'compactions' } as const, EMPTY_COMPACTIONS)
const trendsAtom = atom({ plugin: 'meter', key: 'trends' } as const, EMPTY_TRENDS)
const breakdownAtom = atom({ plugin: 'meter', key: 'breakdown' } as const, EMPTY_BREAKDOWN)
const infoAtom = atom({ plugin: 'meter', key: 'info' } as const, null)
const expandedAtom = atom({ plugin: 'meter', key: 'expanded' } as const, [])
const epochAtom = atom({ plugin: 'meter', key: 'epoch' } as const, 0)

const PANE = 'meter'
const TITLE = 'Meter'

const STALE_LOADING_MS = 60_000
const AGENTS_LIST_MAX = 50
const CACHE_TTL_MS = 60 * 60 * 1000
const DESKTOP_WIDE = 80
const WIDE = 140
const NARROW = 100

let needsRegister = false
let needsSummary = false

const toMeasure = (m: Measure): Measure => ({
  context: { tokens: m.context.tokens, window: m.context.window, percent: m.context.percent },
  rateLimits: m.rateLimits.map(l => ({ kind: clean(l.kind), percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
  cost: m.cost && { usd: m.cost.usd },
})

const registerCommand = ($: EngineInterface) => {
  void $.command
    .register({ name: 'meter', description: 'Open detailed session metrics', immediate: true })
    .catch(() => {})
}

async function openMeter($: EngineInterface) {
  return $.ui.open({ id: PANE, title: TITLE, focus: true, closeOnEscape: true, rows: 30, columns: 80 })
}

const text = (r: PromiseSettledResult<string>, fallback: string) =>
  r.status === 'fulfilled' ? clean(r.value) : fallback

async function refreshAgents($: EngineInterface, epoch: number) {
  try {
    const list = await $.agent.list()
    if ((await read($, epochAtom)) !== epoch) return
    await update($, agentsAtom, a => ({
      ...a,
      list: list.slice(-AGENTS_LIST_MAX).map(row => ({
        id: clean(row.id),
        type: clean(row.type),
        description: clean(row.description),
        status: clean(row.status),
        ...(row.name !== undefined && { name: clean(row.name) }),
      })),
    }))
  } catch {}
}

async function refreshDetails($: EngineInterface, detail: 'full' | 'summary') {
  const started = await $.clock.now()
  let go = false
  await update($, breakdownAtom, b => {
    go = !(b.status.state === 'loading' && started - b.status.since < STALE_LOADING_MS)

    return go ? { ...b, status: { state: 'loading' as const, since: started } } : b
  })
  if (!go) return

  try {
    const epoch = await read($, epochAtom)
    const [id, version, model, turns, cwd, first] = await Promise.allSettled([
      $.session.id(),
      $.session.version(),
      $.session.model(),
      $.session.turns(),
      $.session.cwd(),
      $.session.usage({ breakdown: detail }),
    ])
    let usage = first
    let counted = detail
    if (detail === 'full' && !(usage.status === 'fulfilled' && usage.value.context.breakdown)) {
      [usage] = await Promise.allSettled([$.session.usage({ breakdown: 'summary' })])
      counted = 'summary'
    }
    await refreshAgents($, epoch)

    if ((await read($, epochAtom)) !== epoch) {
      await update($, breakdownAtom, b => ({ ...b, status: IDLE }))

      return
    }

    const at = await $.clock.now()
    await update($, infoAtom, prev => ({
      id: text(id, prev?.id ?? '-'),
      version: version.status === 'fulfilled' ? clean(version.value.version) : (prev?.version ?? '-'),
      ...(version.status === 'fulfilled' && version.value.builtAt !== undefined && { builtAt: clean(version.value.builtAt) }),
      model: text(model, prev?.model ?? '-'),
      startedAt: usage.status === 'fulfilled' ? usage.value.startedAt : (prev?.startedAt ?? at),
      prompts: turns.status === 'fulfilled' ? turns.value : (prev?.prompts ?? 0),
      cwd: text(cwd, prev?.cwd ?? '-'),
      at,
    }))

    const breakdown = usage.status === 'fulfilled' ? usage.value.context.breakdown : undefined
    if (usage.status === 'fulfilled' && breakdown) {
      const snap = toSnap(breakdown, usage.value.context.tokens, at, counted)
      await update($, breakdownAtom, () => ({ snap, status: IDLE }))
    } else {
      await update($, breakdownAtom, b => ({ ...b, status: { state: 'error' as const } }))
    }
  } catch (err) {
    await update($, breakdownAtom, b => ({ ...b, status: { state: 'error' as const } }))
    throw err
  }
}

async function resetSession($: EngineInterface) {
  const now = await $.clock.now()
  await update($, epochAtom, n => n + 1)
  await update($, cacheAtom, () => null)
  await update($, measureAtom, () => null)
  await update($, requestsAtom, () => ({ ...EMPTY_REQUESTS, trackedSince: now }))
  await update($, turnsAtom, () => EMPTY_TURNS)
  await update($, toolsAtom, () => ({}))
  await update($, agentsAtom, () => EMPTY_AGENTS)
  await update($, compactionsAtom, () => EMPTY_COMPACTIONS)
  await update($, trendsAtom, t => ({ ...EMPTY_TRENDS, limits: t.limits }))
  await update($, breakdownAtom, () => EMPTY_BREAKDOWN)
  await update($, infoAtom, () => null)
}

async function countAfterReset($: EngineInterface) {
  if (!needsSummary) return
  needsSummary = false
  if ((await $.ui.panes()).some(p => p.id === PANE)) void refreshDetails($, 'summary').catch(() => {})
}

async function recordTool(
  $: EngineInterface,
  tool: string,
  t0: number,
  isFromAgent: boolean,
  result: { deny?: string; isError?: true } | null,
) {
  const ms = (await $.clock.now()) - t0
  await update($, toolsAtom, tools =>
    addTool(tools, tool, {
      isDenied: result?.deny !== undefined,
      isError: result === null || result.isError === true,
      ms,
      isFromAgent,
    }),
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const usage = await $.session.usage()
    await update($, measureAtom, () => toMeasure(usage))
    const now = await $.clock.now()
    await update($, requestsAtom, r => (r.trackedSince ? r : { ...r, trackedSince: now }))
    await update($, breakdownAtom, b => ({ ...b, status: IDLE }))
    $.clock.every(30_000, async () => {
      const t = await $.clock.now()
      await update($, nowAtom, () => t)
    })
    registerCommand($)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    const isReset = e.reason === 'clear' || e.reason === 'resume'
    if (isReset) {
      needsRegister = true
      await resetSession($)
    }
    const result = await next(e)
    if (isReset) needsSummary = true

    return result
  })

  on('turn.start', async ($, e, next) => {
    if (needsRegister) {
      needsRegister = false
      registerCommand($)
    }
    void countAfterReset($).catch(() => {})

    return next(e)
  })

  on('command.run', { command: 'meter' }, async $ => {
    const opened = await openMeter($)
    void refreshDetails($, 'full').catch(() => {})

    return opened.isPlaced ? {} : { text: clean(`Meter pane waits: ${opened.reason}`) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface !== 'desktop' && e.surface !== 'terminal') return next(e)
    const data = {
      measure: await read($, measureAtom),
      cache: await read($, cacheAtom),
      requests: await read($, requestsAtom),
      turns: await read($, turnsAtom),
      tools: await read($, toolsAtom),
      agents: await read($, agentsAtom),
      compactions: await read($, compactionsAtom),
      trends: await read($, trendsAtom),
      breakdown: await read($, breakdownAtom),
      info: await read($, infoAtom),
      expanded: await read($, expandedAtom),
    }
    await read($, nowAtom)
    const now = await $.clock.now()
    const actions = {
      refresh: () => refreshDetails($, 'full').catch(() => {}),
      toggleExpanded: async (name: string) => {
        await update($, expandedAtom, list => (list.includes(name) ? list.filter(n => n !== name) : [...list, name]))
      },
      close: () => $.ui.close({ id: PANE }),
    }

    return drawPane($.ui.resolve(e), data, actions, { surface: e.surface, bodyColumns: e.props.bodyColumns, now })
  })

  on('session.measure', async ($, e, next) => {
    await update($, measureAtom, () => toMeasure(e))
    void countAfterReset($).catch(() => {})
    const cost = e.changed.includes('cost') ? e.cost : undefined
    const hasLimits = e.changed.includes('rateLimits')
    if (cost || hasLimits) {
      const at = await $.clock.now()
      await update($, trendsAtom, t => {
        const withCost = cost ? addCost(t, at, cost.usd) : t

        return hasLimits ? addLimitSamples(withCost, at, e.rateLimits) : withCost
      })
    }

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const agentId = e.agentId
    const epoch = agentId === undefined ? 0 : await read($, epochAtom)
    const t0 = await $.clock.now()
    const result = yield* next(e)
    const t1 = await $.clock.now()
    const usage = result.usage
    if (agentId === undefined && usage) {
      await update($, cacheAtom, prev => ({
        lastRead: usage.cache_read_input_tokens,
        lastWrite: usage.cache_creation_input_tokens,
        lastUncached: usage.input_tokens,
        totalRead: (prev?.totalRead ?? 0) + usage.cache_read_input_tokens,
        totalWrite: (prev?.totalWrite ?? 0) + usage.cache_creation_input_tokens,
        totalUncached: (prev?.totalUncached ?? 0) + usage.input_tokens,
        lastAt: t1,
        model: clean(usage.model),
      }))
    }
    if (agentId !== undefined && usage) {
      const id = clean(agentId)
      const seen = await read($, agentsAtom)
      const isNew = !Object.hasOwn(seen.usage, id) && !seen.list.some(row => row.id === id)
      await update($, agentsAtom, a => addAgentStep(a, agentId, usage, t1))
      if (isNew) void refreshAgents($, epoch)
    }
    await update($, requestsAtom, r =>
      addStep(r, {
        at: t1,
        ms: t1 - t0,
        usage,
        requested: e.model,
        effort: e.effort === undefined ? null : String(e.effort),
        messageCount: e.messageCount,
        isAgent: agentId !== undefined,
      }),
    )

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const epoch = await read($, epochAtom)
    if (e.agentId === undefined) {
      const at = await $.clock.now()
      await update($, turnsAtom, t => addTurn(t, at, e.durationMs, e.reason))
    }
    const result = await next(e)
    if (e.agentId !== undefined) void refreshAgents($, epoch)

    return result
  })

  on('tool.call', async ($, e, next) => {
    const t0 = await $.clock.now()
    const isFromAgent = e.agentId !== undefined
    const epoch = await read($, epochAtom)
    let result
    try {
      result = await next(e)
    } catch (err) {
      await recordTool($, e.tool, t0, isFromAgent, null)
      throw err
    } finally {
      if (e.tool === 'Agent') void refreshAgents($, epoch)
    }
    await recordTool($, e.tool, t0, isFromAgent, result)

    return result
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.trigger === 'precompute' || result.skip !== undefined) return result
    const at = await $.clock.now()
    const trigger = e.trigger
    await update($, compactionsAtom, c =>
      addCompaction(c, {
        at,
        trigger,
        before: result.tokensBefore,
        after: result.tokensAfter,
        isSubagent: e.agentId !== undefined,
      }),
    )

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'desktop' && e.surface !== 'terminal') return next(e)

    const measure = await read($, measureAtom)
    const cache = await read($, cacheAtom)
    await read($, nowAtom)
    const now = await $.clock.now()
    if (e.props.hasSurvey || (!measure && !cache)) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const svg = e.surface === 'desktop' ? $.ui.resolve(e) : null
    const isTerminal = e.surface === 'terminal'
    const cols = e.props.bodyColumns
    const isWide = isTerminal ? cols >= WIDE : cols >= DESKTOP_WIDE
    const isNarrow = isTerminal && cols < NARROW
    const showContextBar = isTerminal ? !isNarrow : true
    const showLimitBars = isWide
    const cells = isWide ? 10 : 6

    const gauge = (pct: number, color: string | undefined, key: string) => {
      const ratio = Math.min(Math.max(pct, 0), 100) / 100
      if (svg) {
        const { Svg } = svg
        const w = 44
        const fill = ratio === 0 ? 0 : Math.max(3, Math.round(ratio * w))
        return (
          <Svg
            key={key}
            width={w}
            height={6}
            alt={`${Math.round(pct)}%`}
            source={`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="6" viewBox="0 0 ${w} 6"><rect width="${w}" height="6" rx="3" fill="rgba(128,128,128,0.28)"/><rect width="${fill}" height="6" rx="3" fill="${color ? SVG_COLORS[color] : 'rgba(128,128,128,0.6)'}"/></svg>`}
          />
        )
      }
      const filled = ratio === 0 ? 0 : Math.max(1, Math.round(ratio * cells))
      return (
        <Text key={key}>
          <Text color={color} dimColor={!color}>{'━'.repeat(filled)}</Text>
          <Text dimColor>{'━'.repeat(cells - filled)}</Text>
        </Text>
      )
    }

    const segment = (key: string, parts: RenderChildren[]) => (
      <Box key={key} alignItems="center" columnGap={1}>
        {parts.filter(p => p !== null && p !== undefined && p !== false)}
      </Box>
    )
    const label = (text: string) => <Text key="label" dimColor>{text}</Text>

    const segments: RenderChildren[] = []

    const ctx = measure?.context
    if (ctx) {
      const pct = ctx.percent
      segments.push(
        segment('ctx', pct === undefined
          ? [label('Context'), <Text key="v" dimColor>{fmtTokens(ctx.window)} window</Text>]
          : [
              label('Context'),
              showContextBar ? gauge(pct, loadColor(pct), 'bar') : null,
              <Text key="v" color={loadColor(pct)} bold>{pct}%</Text>,
              isTerminal && isWide && ctx.tokens !== undefined
                ? <Text key="t" dimColor>{`  ${fmtTokens(ctx.tokens)} / ${fmtTokens(ctx.window)}`}</Text>
                : null,
            ]),
      )
    }

    const idle = cache ? Math.max(0, now - cache.lastAt) : 0
    const ttlLeft = CACHE_TTL_MS - idle
    if (cache) {
      const hit = hitRate(cache.lastRead, cache.lastWrite, cache.lastUncached)
      const state = e.props.isWorking
        ? { dot: 'success', text: 'live', short: 'live' }
        : ttlLeft > 0
          ? { dot: ttlLeft < 10 * 60000 ? 'warning' : 'success', text: `warm ${fmtDuration(ttlLeft)}`, short: fmtDuration(ttlLeft) }
          : { dot: 'error', text: 'cold', short: 'cold' }
      segments.push(
        isTerminal
          ? segment('cache', [
              label('Cache'),
              hit === null
                ? <Text key="v" dimColor>-</Text>
                : <Text key="v">
                    <Text color={hitColor(hit)} bold>{hit}%</Text>
                    {isNarrow ? null : <Text dimColor> hit</Text>}
                  </Text>,
              <Text key="s">
                <Text color={state.dot}>{isNarrow ? ' ●' : '●'}</Text>
                <Text dimColor> {isNarrow ? state.short : state.text}</Text>
              </Text>,
            ])
          : segment('cache', [
              label('Cache'),
              hit === null
                ? <Text key="v" dimColor>-</Text>
                : <Text key="v">
                    <Text color={hitColor(hit)} bold>{hit}%</Text>
                    <Text dimColor> hit</Text>
                  </Text>,
              <Text key="s">
                <Text color={state.dot}> ●</Text>
                <Text dimColor> {state.text}</Text>
              </Text>,
            ]),
      )
    }

    for (const l of measure?.rateLimits ?? []) {
      const pct = Math.round(l.percentUsed)
      const resetIn = l.resetsAt ? Date.parse(l.resetsAt) - now : NaN
      const isStale = Number.isFinite(resetIn) && resetIn <= 0
      const color = isStale ? undefined : loadColor(pct)
      const showReset = resetIn > 0 && !isNarrow
      segments.push(
        segment(`limit-${l.kind}`, [
          label(limitLabel(l.kind)),
          showLimitBars ? gauge(pct, color, 'bar') : null,
          <Text key="v" color={color} dimColor={isStale} bold={!isStale}>{pct}%</Text>,
          showReset
            ? <Text key="r" dimColor>{isTerminal ? `  ↻ ${fmtDuration(resetIn)}` : ` ↻ ${fmtDuration(resetIn)}`}</Text>
            : null,
        ]),
      )
    }

    if (measure?.cost) {
      segments.push(
        segment('cost', [
          isNarrow ? null : label('Cost'),
          <Text key="v" bold>${measure.cost.usd.toFixed(2)}</Text>,
        ]),
      )
    }

    const details: [string, string][] = []
    if (ctx?.tokens !== undefined) {
      details.push(['Context', `${ctx.tokens.toLocaleString()} of ${ctx.window.toLocaleString()} tokens`])
    }
    if (cache) {
      details.push(['Last request', `${fmtTokens(cache.lastRead)} read · ${fmtTokens(cache.lastWrite)} written · ${fmtTokens(cache.lastUncached)} uncached`])
      const sess = hitRate(cache.totalRead, cache.totalWrite, cache.totalUncached)
      details.push(['Session cache', `${sess ?? '-'}% hit · ${fmtTokens(cache.totalRead)} read · ${fmtTokens(cache.totalWrite)} written`])
      details.push(['Cache TTL', ttlLeft > 0 ? `~${fmtDuration(ttlLeft)} left (idle ${fmtDuration(idle)}, assumes 1h)` : `expired ${fmtDuration(-ttlLeft)} ago`])
      details.push(['Model', cache.model])
    }
    for (const l of measure?.rateLimits ?? []) {
      if (l.resetsAt && Date.parse(l.resetsAt) > now) {
        const at = new Date(l.resetsAt)
        details.push([`${limitLabel(l.kind)} limit`, `${Math.round(l.percentUsed)}% used · resets ${at.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`])
      }
    }
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
        <Box
          key="card"
          display="none"
          hover={{ display: 'flex', scope: 'meter' }}
          flexDirection="column"
          marginBottom={1}
        >
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

    return (
      <Box key="meter" flexDirection="column" hover={{ scope: 'meter' }}>
        {card}
        <Box key="row" flexWrap="wrap" alignItems="center" columnGap={isNarrow ? 2 : 3}>
          {segments}
        </Box>
      </Box>
    )
  })
}
