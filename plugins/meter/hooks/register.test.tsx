import { expect, mock, test } from 'claude-code/testing'

import { fmtTokens, fmtTokens1 } from './format'
import { memoized } from './svg'

const NOW = Date.parse('2026-10-04T12:00:00Z')

type Node = { type: string; props?: Record<string, unknown>; hover?: Record<string, unknown>; children?: unknown[] }

const flatten = (node: unknown, card = false): string => {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(n => flatten(n, card)).join('')
  const el = node as Node
  if (el.type === 'Svg') return `[bar ${String(el.props?.alt)}]`
  const isCard = el.type === 'Box' && el.props?.display === 'none'
  const inner = (el.children ?? []).map(n => flatten(n, card || isCard)).join(el.props?.flexDirection === 'column' ? '\n' : el.props?.columnGap ? ' '.repeat(Number(el.props.columnGap)) : '')
  return isCard ? `[hover card]\n${inner}\n[/card]\n` : inner
}

type Surface = 'terminal' | 'desktop'

const drawBand = async ($: any, on: any, surface: Surface, bodyColumns: number) => {
  const clock = mock.clock(on, { now: NOW - 8 * 60000 })
  on('turn.step', async function* (_: unknown, e: { turnId: string; index: number }) {
    return {
      turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn',
      usage: { input_tokens: 40, output_tokens: 10, cache_read_input_tokens: 88_000, cache_creation_input_tokens: 2_100, model: 'claude-opus-5-5' },
    }
  })
  on('session.measure', (_: unknown, e: { changed: unknown }) => ({ changed: e.changed }))
  await $.session.measure({
    context: { tokens: 91_234, window: 200_000, percent: 46 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 23.5, resetsAt: new Date(NOW + 130 * 60000).toISOString() },
      { kind: 'seven_day', percentUsed: 88, resetsAt: new Date(NOW + 76 * 3600000).toISOString() },
    ],
    cost: { usd: 1.8432 },
    changed: ['context', 'rateLimits', 'cost'],
  })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
  }
  await clock.advance(8 * 60000)
  const ui = await $.ui.mount({
    plugin: 'meter',
    surface,
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  })
  return ui.drawn()
}

const splitCard = (text: string) => ({ text, row: text.slice(text.indexOf('[/card]') + 8) })

const findNode = (node: unknown, pred: (n: Node) => boolean): Node | undefined => {
  if (node === null || typeof node !== 'object') return undefined
  if (Array.isArray(node)) return node.map(n => findNode(n, pred)).find(Boolean)
  const el = node as Node
  if (pred(el)) return el
  return (el.children ?? []).map(n => findNode(n, pred)).find(Boolean)
}

const count = (text: string, ch: string) => text.split(ch).length - 1

for (const bodyColumns of [140, 100, 60]) {
  test(`draws on desktop at ${bodyColumns} columns`, async ($, on) => {
    const { text, row } = splitCard(flatten(await drawBand($, on, 'desktop', bodyColumns)))
    expect(text).toContain('~52m left (idle 8m, assumes 1h)')
    expect(row).toContain('Context')
    expect(row).toContain('46%')
    expect(row).toContain('Cache 98%')
    expect(row).toContain('$1.84')
    expect(row).toContain('[bar 46%]')
    expect(row).toContain('↻ 2h 10m')
    if (bodyColumns >= 80) expect(row).toContain('[bar 88%]')
  })
}

test('draws the wide band on the terminal', async ($, on) => {
  const { text, row } = splitCard(flatten(await drawBand($, on, 'terminal', 140)))
  expect(row).toContain('Context')
  expect(row).toContain('46%')
  expect(row).toContain('91k / 200k')
  expect(row).toContain('Cache 98% hit')
  expect(row).toContain('warm 52m')
  expect(row).toContain('5h')
  expect(row).toContain('24%')
  expect(row).toContain('Week')
  expect(row).toContain('88%')
  expect(row).toContain('↻ 2h 10m')
  expect(row).toContain('↻ 3d 4h')
  expect(row).toContain('Cost $1.84')
  expect(count(row, '━')).toBe(30)
  expect(row).not.toContain('[bar')
  expect(row.length).toBeLessThanOrEqual(140)
  expect(text).toContain('~52m left (idle 8m, assumes 1h)')
})

test('draws the medium band on the terminal', async ($, on) => {
  const { row } = splitCard(flatten(await drawBand($, on, 'terminal', 100)))
  expect(row).toContain('Context')
  expect(row).toContain('46%')
  expect(row).not.toContain('91k / 200k')
  expect(row).toContain('Cache 98% hit')
  expect(row).toContain('↻ 2h 10m')
  expect(row).toContain('↻ 3d 4h')
  expect(row).toContain('Cost $1.84')
  expect(count(row, '━')).toBe(6)
  expect(row.length).toBeLessThanOrEqual(100)
})

test('draws the narrow band on the terminal', async ($, on) => {
  const { row } = splitCard(flatten(await drawBand($, on, 'terminal', 60)))
  expect(row).toContain('46%')
  expect(row).toContain('5h 24%')
  expect(row).toContain('Week 88%')
  expect(row).toContain('$1.84')
  expect(row).not.toContain('91k / 200k')
  expect(row).not.toContain('↻')
  expect(row).not.toContain('Cost')
  expect(row).toContain('Cache 98%  ● 52m')
  expect(row).not.toContain('hit')
  expect(count(row, '━')).toBe(0)
  expect(row.length).toBeLessThanOrEqual(60)
})

test('reveals the terminal hover card above the band', async ($, on) => {
  const tree = await drawBand($, on, 'terminal', 140)
  const band = findNode(tree, n => n.type === 'Box' && n.props?.key === 'meter')
  const card = findNode(tree, n => n.type === 'Box' && n.props?.display === 'none')
  expect(band?.hover).toEqual({ scope: 'meter' })
  expect(card?.props).toMatchObject({
    position: 'absolute',
    top: -9,
    left: 0,
    borderStyle: 'round',
    borderDimColor: true,
    paddingX: 1,
  })
  expect(card?.hover).toEqual({ display: 'flex', scope: 'meter' })
  expect(flatten(card)).toContain('Context  ')
  expect(flatten(card)).toContain('91,234 of 200,000 tokens')
  expect(findNode(card, n => n.type === 'Text' && n.props?.wrap === 'truncate')).toBeDefined()
})

const mountProps = (surface: string = 'desktop') => ({
  plugin: 'meter',
  surface,
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 140, scroll: { offset: 0, bodyRows: 10 }, view: {} },
}) as never

for (const surface of ['terminal', 'desktop'] as const) {
  test(`clears the band on /clear on the ${surface}`, async ($, on) => {
    mock.clock(on, { now: NOW })
    on('session.measure', (_, e) => ({ changed: e.changed }))
    on('session.end', (_, e) => ({ sessionId: e.sessionId }))
    on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }) as never)
    await $.session.measure({
      context: { tokens: 91_234, window: 200_000, percent: 46 },
      rateLimits: [],
      cost: { usd: 1.8432 },
      changed: ['context', 'cost'],
    } as never)
    const before = flatten(await (await $.ui.mount(mountProps(surface))).drawn())
    expect(before).toContain('$1.84')
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
    const after = flatten(await (await $.ui.mount(mountProps(surface))).drawn())
    expect(after).toContain('engine band')
    expect(after).not.toContain('$1.84')
  })

  test(`drops the countdown once a limit has reset on the ${surface}`, async ($, on) => {
    mock.clock(on, { now: NOW })
    on('session.measure', (_, e) => ({ changed: e.changed }))
    await $.session.measure({
      context: { tokens: 91_234, window: 200_000, percent: 46 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 23.5, resetsAt: new Date(NOW - 5 * 60000).toISOString() },
        { kind: 'seven_day', percentUsed: 88, resetsAt: new Date(NOW + 76 * 3600000).toISOString() },
      ],
      changed: ['context', 'rateLimits'],
    } as never)
    const tree = await (await $.ui.mount(mountProps(surface))).drawn()
    const text = flatten(tree)
    const row = text.slice(text.indexOf('[/card]') + 8)
    const stale = findNode(tree, n => n.type === 'Text' && flatten(n) === '24%')
    const live = findNode(tree, n => n.type === 'Text' && flatten(n) === '88%')
    expect(stale?.props).toMatchObject({ dimColor: true, bold: false })
    expect(stale?.props?.color).toBeUndefined()
    expect(live?.props).toMatchObject({ color: 'error', bold: true })
    expect(row).toContain('5h')
    expect(row).toContain('24%')
    expect(row).not.toContain('↻ 0m')
    expect(row).toContain('↻ 3d 4h')
    expect(text).not.toContain('5h limit')
    expect(text).toContain('Week limit')
  })
}

test('draws nothing of its own on a surface other than the terminal and desktop', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }) as never)
  await $.session.measure({
    context: { tokens: 91_234, window: 200_000, percent: 46 },
    rateLimits: [],
    cost: { usd: 1.8432 },
    changed: ['context', 'cost'],
  } as never)
  const text = flatten(await (await $.ui.mount(mountProps('mobile'))).drawn())
  expect(text).toBe('engine band')
})

const startSession = async ($: any, on: any, surface: string) => {
  const calls = { every: 0, commands: [] as string[] }
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } }) as never)
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => {
    calls.every++
    return { value: undefined }
  })
  on('command.register', (_: unknown, e: { name: string }) => {
    calls.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start', (_: unknown, e: unknown) => e as never)
  on('session.end', (_: unknown, e: { sessionId: string }) => ({ sessionId: e.sessionId }) as never)
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }) as never)
  await $.session.start({ cwd: '/work', surface, isInteractive: true })
  return calls
}

for (const surface of ['terminal', 'desktop']) {
  test(`starts the clock and /meter on the ${surface}`, async ($, on) => {
    const calls = await startSession($, on, surface)
    expect(calls.every).toBe(1)
    expect(calls.commands).toEqual(['meter'])
  })
}

for (const reason of ['clear', 'resume']) {
  test(`registers /meter again on the first turn after a ${reason}`, async ($, on) => {
    const calls = await startSession($, on, 'terminal')
    await $.turn.start({ text: 'hi', turnId: 't0' })
    expect(calls.commands).toEqual(['meter'])
    await $.session.end({ reason, sessionId: 's1' } as never)
    expect(calls.commands).toEqual(['meter'])
    await $.turn.start({ text: 'hi', turnId: 't1' })
    expect(calls.commands).toEqual(['meter', 'meter'])
    await $.turn.start({ text: 'again', turnId: 't2' })
    expect(calls.commands).toEqual(['meter', 'meter'])
  })
}

const BREAKDOWN_ROWS: [string, string, 'used' | 'free' | 'buffer', number, number, number][] = [
  ['System prompt', 'promptBorder', 'used', 3100, 2, 0.55],
  ['System tools', 'permission', 'used', 14200, 7, 0.1],
  ['MCP tools', 'claude', 'used', 12400, 6, 0.2],
  ['Memory files', 'suggestion', 'used', 4200, 2, 0.1],
  ['Messages', 'success', 'used', 52000, 26, 1],
  ['Free space', 'inactive', 'free', 81000, 40, 1],
  ['Autocompact buffer', 'inactive', 'buffer', 33000, 17, 1],
]

const breakdownFixture = (overrides: Record<string, unknown> = {}) => {
  const squares = BREAKDOWN_ROWS.flatMap(([categoryName, color, kind, tokens, count, last]) =>
    Array.from({ length: count }, (_, i) => ({
      color,
      isFilled: kind === 'used',
      categoryName,
      tokens,
      percentage: Math.round(tokens / 2000),
      squareFullness: i === count - 1 && kind === 'used' ? last : 1,
    })),
  )
  return {
    categories: BREAKDOWN_ROWS.map(([name, color, kind, tokens]) => ({ name, tokens, color, isDeferred: false, kind })),
    totalTokens: 91_000,
    maxTokens: 200_000,
    rawMaxTokens: 200_000,
    autocompactSource: 'auto',
    percentage: 46,
    gridRows: Array.from({ length: 10 }, (_, r) => squares.slice(r * 10, r * 10 + 10)),
    model: 'claude-opus-5-5',
    memoryFiles: [
      { path: '/Users/me/.claude/CLAUDE.md', type: 'User', tokens: 1900 },
      { path: '/work/claude-mods/CLAUDE.md', type: 'Project', tokens: 1100 },
    ],
    mcpTools: [
      { name: 'mcp__linear__list', serverName: 'linear', tokens: 5000, isLoaded: true },
      { name: 'mcp__linear__create', serverName: 'linear', tokens: 3000, isLoaded: true },
      { name: 'mcp__github__pr', serverName: 'github', tokens: 4400, isLoaded: true },
    ],
    agents: [{ agentType: 'code-reviewer', source: 'plugin', tokens: 300 }],
    slashCommands: { totalCommands: 20, includedCommands: 18, tokens: 1100 },
    skills: {
      totalSkills: 14,
      includedSkills: 12,
      tokens: 2100,
      skillFrontmatter: [
        { name: 'tdd', source: 'userSettings', tokens: 400 },
        { name: 'dataviz', source: 'plugin', tokens: 900 },
      ],
    },
    autoCompactThreshold: 167_000,
    isAutoCompactEnabled: true,
    apiUsage: null,
    ...overrides,
  }
}

const MESSAGE = { role: 'user', text: 'summary', toolUses: [] }

type Harness = Awaited<ReturnType<typeof harness>>

const harness = async ($: any, on: any, options: { isPlaced?: boolean; reason?: string; panes?: string[] } = {}) => {
  const clock = mock.clock(on, { now: NOW })
  const h = {
    clock,
    opens: [] as Record<string, unknown>[],
    closes: [] as Record<string, unknown>[],
    registers: [] as Record<string, unknown>[],
    usageCalls: [] as (string | undefined)[],
    agentLists: 0,
    isPlaced: options.isPlaced ?? true,
    reason: options.reason ?? 'waiting',
    panes: options.panes ?? [],
    fail: new Set<string>(),
    sets: [] as string[],
    gate: null as Promise<void> | null,
    agentGate: null as Promise<void> | null,
    ending: null as (() => Promise<void>) | null,
    completing: null as (() => void) | null,
    calling: null as (() => void) | null,
    registerFails: false,
    breakdown: breakdownFixture() as Record<string, unknown>,
    agents: [] as Record<string, unknown>[],
    info: { id: '7edccffa-9eee-408a-aa82-52bd0ecd433', version: '2.1.286', builtAt: '2026-10-02T10:00:00Z', model: 'claude-opus-5-5', turns: 12, cwd: '/work/claude-mods' },
    state: {} as Record<string, any>,
    usage: null as Record<string, unknown> | null,
    stepMs: 0,
    toolMode: 'ok' as 'ok' | 'error' | 'deny' | 'throw',
    toolMs: 0,
    compact: { messages: [MESSAGE], tokensBefore: 187_000, tokensAfter: 22_000 } as Record<string, unknown>,
    measure: { context: { tokens: 91_234, window: 200_000, percent: 46 }, rateLimits: [] as unknown[], cost: undefined as unknown },
  }
  on('state.set', (_: unknown, e: { plugin: string; key: string; value: unknown }, next: any) => {
    if (e.plugin === 'meter') {
      h.state[e.key] = e.value
      h.sets.push(e.key)
    }
    return next(e)
  })
  on('session.usage', async (_: unknown, e: { breakdown?: string }) => {
    h.usageCalls.push(e.breakdown)
    if (e.breakdown === 'full' && h.gate) await h.gate
    if (e.breakdown && h.fail.has(e.breakdown)) return { deny: `${e.breakdown} failed` }
    return {
      value: {
        startedAt: NOW - (2 * 60 + 14) * 60000,
        context: { ...h.measure.context, ...(e.breakdown ? { breakdown: h.breakdown } : {}) },
        rateLimits: h.measure.rateLimits,
        cost: h.measure.cost,
      },
    }
  })
  on('session.id', () => ({ value: h.info.id }))
  on('session.version', () => ({ value: { version: h.info.version, builtAt: h.info.builtAt } }))
  on('session.model', () => ({ value: h.info.model }))
  on('session.turns', () => ({ value: h.info.turns }))
  on('session.cwd', () => ({ value: h.info.cwd }))
  on('agent.list', async () => {
    h.agentLists++
    if (h.agentGate) await h.agentGate
    return { value: h.agents }
  })
  on('ui.open', (_: unknown, e: Record<string, unknown>) => {
    h.opens.push(e)
    return { value: h.isPlaced ? { isPlaced: true } : { isPlaced: false, reason: h.reason } }
  })
  on('ui.close', (_: unknown, e: Record<string, unknown>) => {
    h.closes.push(e)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: h.panes.map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) }))
  on('command.register', (_: unknown, e: { name: string }) => {
    h.registers.push(e)
    if (h.registerFails) return { deny: 'refused' }
    return { value: { command: e.name } }
  })
  on('session.start', (_: unknown, e: unknown) => e as never)
  on('session.end', async (_: unknown, e: { sessionId: string }) => {
    await h.ending?.()
    return { sessionId: e.sessionId } as never
  })
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }) as never)
  on('session.measure', (_: unknown, e: { changed: unknown }) => ({ changed: e.changed }))
  on('turn.step', async function* (_: unknown, e: { turnId: string; index: number }) {
    if (h.stepMs) await clock.advance(h.stepMs)
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: h.usage }
  })
  on('turn.complete', (_: unknown, e: { answer: string }) => {
    h.completing?.()
    return { text: e.answer }
  })
  on('tool.call', async () => {
    h.calling?.()
    if (h.toolMs) await clock.advance(h.toolMs)
    if (h.toolMode === 'throw') throw new Error('tool crashed')
    if (h.toolMode === 'deny') return { deny: 'not allowed' }
    if (h.toolMode === 'error') return { result: 'bad', isError: true }
    return { result: 'fine' }
  })
  on('session.compact', () => h.compact as never)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine draw'] }) as never)
  return h
}

const startMeter = async ($: any, on: any, options?: Parameters<typeof harness>[2] & { isFresh?: boolean }) => {
  const h = await harness($, on, options)
  if (options?.isFresh) h.measure.context = { window: 200_000 } as never
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  return h
}

const runMeter = ($: any) => $.command.run({ command: 'meter' })

test('registers /meter as an immediate command without arguments', async ($, on) => {
  const h = await startMeter($, on)
  expect(h.registers).toEqual([{ name: 'meter', description: 'Open detailed session metrics', immediate: true }])
})

test('/meter opens the pane and counts the context in full once', async ($, on) => {
  const h = await startMeter($, on)
  const result = await runMeter($)
  expect(h.opens).toEqual([{ id: 'meter', title: 'Meter', focus: true, closeOnEscape: true, rows: 30, columns: 80 }])
  expect(result.text).toBeUndefined()
  await h.clock.settle()
  expect(h.usageCalls.filter(c => c === 'full')).toHaveLength(1)
})

test('/meter twice re-opens the same pane and leaves the band up', async ($, on) => {
  const h = await startMeter($, on)
  await runMeter($)
  await runMeter($)
  expect(h.opens).toHaveLength(2)
  expect(h.opens[1]?.id).toBe('meter')
  expect(h.closes).toHaveLength(0)
  await $.session.measure({ ...h.measure, changed: ['context'] } as never)
  const band = flatten(await (await $.ui.mount(mountProps('terminal'))).drawn())
  expect(band).toContain('46%')
})

test('/meter says why the pane waits when it is not placed', async ($, on) => {
  await startMeter($, on, { isPlaced: false, reason: 'widen the terminal\u0007\nto 144 columns' })
  const result = await runMeter($)
  expect(result.text).toContain('Meter pane waits: widen the terminal')
  expect(result.text).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
})

test('keeps drawing the band after /meter on both surfaces', async ($, on) => {
  const h = await startMeter($, on)
  await runMeter($)
  await $.session.measure({ ...h.measure, cost: { usd: 1.8432 }, changed: ['context', 'cost'] } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = flatten(await (await $.ui.mount(mountProps(surface))).drawn())
    expect(band).toContain('$1.84')
  }
})

test('session.start completes when registering /meter is refused', async ($, on) => {
  const h = await harness($, on)
  h.registerFails = true
  const result = await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  expect(result).toBeDefined()
  expect(h.registers).toHaveLength(1)
})

const USAGE = { input_tokens: 40, output_tokens: 10, cache_read_input_tokens: 88_000, cache_creation_input_tokens: 2_100, model: 'claude-opus-5-5' }

const runStep = async ($: any, input: Record<string, unknown> = {}) => {
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3, effort: 'high', ...input })) {
  }
}

test('counts a main-thread step into the request totals and history', async ($, on) => {
  const h = await startMeter($, on)
  h.usage = USAGE
  h.stepMs = 1500
  await runStep($)
  const requests = h.state.requests
  expect(requests.main).toEqual({ input: 40, output: 10, cacheRead: 88_000, cacheWrite: 2_100, requests: 1 })
  expect(requests.byModel['claude-opus-5-5'].requests).toBe(1)
  expect(requests.history).toEqual([{ at: NOW + 1500, ms: 1500, hit: 98, output: 10 }])
  expect(requests).toMatchObject({ effort: 'high', lastModel: 'claude-opus-5-5', requestedModel: 'claude-opus-5-5', messageCount: 3, noResponse: 0 })
  expect(requests.trackedSince).toBe(NOW)
})

test('counts a step that got no response only as one without', async ($, on) => {
  const h = await startMeter($, on)
  h.usage = null
  await runStep($)
  const requests = h.state.requests
  expect(requests.noResponse).toBe(1)
  expect(requests.main.requests).toBe(0)
  expect(requests.history).toEqual([])
  expect(h.state.cache).toBeUndefined()
})

test('counts a subagent step into the agent totals and leaves the cache meter alone', async ($, on) => {
  const h = await startMeter($, on)
  h.usage = USAGE
  await runStep($)
  const cacheBefore = h.state.cache
  h.usage = { ...USAGE, output_tokens: 7, model: 'claude-sonnet-5-5' }
  await runStep($, { agentId: 'a1', model: 'claude-sonnet-5-5' })
  const requests = h.state.requests
  expect(requests.main.requests).toBe(1)
  expect(requests.agents).toEqual({ input: 40, output: 7, cacheRead: 88_000, cacheWrite: 2_100, requests: 1 })
  expect(requests.byModel['claude-sonnet-5-5'].requests).toBe(1)
  expect(requests.history).toHaveLength(1)
  expect(requests.lastModel).toBe('claude-opus-5-5')
  expect(h.state.agents.usage.a1).toMatchObject({ requests: 1, output: 7, model: 'claude-sonnet-5-5', lastAt: NOW })
  expect(h.state.agents.usage.a1).not.toHaveProperty('firstAt')
  expect(h.state.cache).toEqual(cacheBefore)
})

test('keeps 60 request samples and drops the oldest', async ($, on) => {
  const h = await startMeter($, on)
  h.usage = USAGE
  for (let i = 0; i < 65; i++) {
    h.usage = { ...USAGE, output_tokens: i }
    await runStep($, { index: i })
  }
  const history = h.state.requests.history
  expect(history).toHaveLength(60)
  expect(history[0].output).toBe(5)
  expect(history[59].output).toBe(64)
  expect(h.state.requests.main.requests).toBe(65)
})

const complete = ($: any, input: Record<string, unknown> = {}) =>
  $.turn.complete({ answer: 'done', durationMs: 4000, isAborted: false, turnId: 't1', reason: 'answer', ...input })

test('counts main-thread turns by how they ended', async ($, on) => {
  const h = await startMeter($, on)
  await complete($, { durationMs: 4000 })
  await complete($, { durationMs: 252_000, reason: 'aborted', isAborted: true })
  await complete($, { durationMs: 1000, reason: 'refusal', refusal: { category: null, explanation: null } })
  await complete($, { durationMs: 500, reason: 'error' })
  const turns = h.state.turns
  expect(turns).toMatchObject({ count: 4, totalMs: 257_500, longestMs: 252_000, aborted: 1, refused: 1, errored: 1 })
  expect(turns.recent.map((t: { reason: string }) => t.reason)).toEqual(['answer', 'aborted', 'refusal', 'error'])
  expect(h.agentLists).toBe(0)
})

test('does not count a subagent turn and re-reads the agent list', async ($, on) => {
  const h = await startMeter($, on)
  h.agents = [{ id: 'a1', description: 'Review', type: 'code-reviewer', status: 'completed' }]
  await complete($, { agentId: 'a1' })
  await h.clock.settle()
  expect(h.state.turns).toBeUndefined()
  expect(h.agentLists).toBe(1)
  expect(h.state.agents.list).toEqual([{ id: 'a1', description: 'Review', type: 'code-reviewer', status: 'completed' }])
})

test('keeps the last 30 turns', async ($, on) => {
  const h = await startMeter($, on)
  for (let i = 0; i < 33; i++) await complete($, { durationMs: i })
  expect(h.state.turns.count).toBe(33)
  expect(h.state.turns.recent).toHaveLength(30)
  expect(h.state.turns.recent[0].ms).toBe(3)
})

const callTool = ($: any, input: Record<string, unknown> = {}) => $.tool.call({ tool: 'Bash', command: 'ls', ...input })

test('counts tool calls by outcome, including the one that throws', async ($, on) => {
  const h = await startMeter($, on)
  h.toolMs = 2000
  await callTool($)
  h.toolMs = 0
  h.toolMode = 'error'
  await callTool($)
  h.toolMode = 'deny'
  await callTool($)
  h.toolMode = 'throw'
  await expect(callTool($)).rejects.toThrow()
  expect(h.state.tools.Bash).toEqual({ calls: 4, errors: 2, denied: 1, totalMs: 2000, fromAgents: 0 })
})

test('files the 41st distinct tool under (other)', async ($, on) => {
  const h = await startMeter($, on)
  for (let i = 0; i < 41; i++) await callTool($, { tool: `mcp__s__t${i}` })
  await callTool($, { tool: 'mcp__s__t0' })
  expect(Object.keys(h.state.tools)).toHaveLength(41)
  expect(h.state.tools['(other)'].calls).toBe(1)
  expect(h.state.tools.mcp__s__t0.calls).toBe(2)
})

test('counts the calls a subagent makes', async ($, on) => {
  const h = await startMeter($, on)
  await callTool($, { agentId: 'a1' })
  expect(h.state.tools.Bash.fromAgents).toBe(1)
})

const compact = ($: any, input: Record<string, unknown> = {}) =>
  $.session.compact({ trigger: 'plugin', messages: [MESSAGE], ...input })

test('records the size before and after a compaction', async ($, on) => {
  const h = await startMeter($, on)
  await compact($)
  await compact($, { trigger: 'auto' })
  expect(h.state.compactions).toEqual({
    count: 2,
    subagentCount: 0,
    recent: [
      { at: NOW, trigger: 'plugin', before: 187_000, after: 22_000 },
      { at: NOW, trigger: 'auto', before: 187_000, after: 22_000 },
    ],
  })
})

test('ignores a precompute and a skipped compaction', async ($, on) => {
  const h = await startMeter($, on)
  await compact($, { trigger: 'precompute' })
  h.compact = { skip: 'blocked' }
  await compact($, { trigger: 'manual' })
  expect(h.state.compactions).toBeUndefined()
})

test('counts a subagent compaction apart from the main one', async ($, on) => {
  const h = await startMeter($, on)
  await compact($, { agentId: 'a1' })
  expect(h.state.compactions).toEqual({ count: 0, subagentCount: 1, recent: [] })
})

const measureWith = ($: any, h: Harness, extra: Record<string, unknown>) =>
  $.session.measure({ ...h.measure, ...extra } as never)

test('samples cost only when the measure says it changed', async ($, on) => {
  const h = await startMeter($, on)
  await measureWith($, h, { cost: { usd: 1 }, changed: ['context'] })
  expect(h.state.trends).toBeUndefined()
  await measureWith($, h, { cost: { usd: 1 }, changed: ['cost'] })
  await h.clock.advance(1000)
  await measureWith($, h, { cost: { usd: 1.5 }, changed: ['cost', 'context'] })
  expect(h.state.trends.cost).toEqual([
    { at: NOW, usd: 1 },
    { at: NOW + 1000, usd: 1.5 },
  ])
})

test('samples a limit when its percent moves and starts over when the window resets', async ($, on) => {
  const h = await startMeter($, on)
  const limit = (pct: number, resetsAt: string) => [{ kind: 'five_hour', percentUsed: pct, resetsAt }]
  const first = new Date(NOW + 3_600_000).toISOString()
  const second = new Date(NOW + 5 * 3_600_000).toISOString()
  await measureWith($, h, { rateLimits: limit(10, first), changed: ['rateLimits'] })
  await h.clock.advance(60_000)
  await measureWith($, h, { rateLimits: limit(10, first), changed: ['rateLimits'] })
  await measureWith($, h, { rateLimits: limit(12, first), changed: ['rateLimits'] })
  expect(h.state.trends.limits.five_hour).toEqual([
    { at: NOW, pct: 10, resetsAt: first },
    { at: NOW + 60_000, pct: 12, resetsAt: first },
  ])
  await measureWith($, h, { rateLimits: limit(3, second), changed: ['rateLimits'] })
  expect(h.state.trends.limits.five_hour).toEqual([{ at: NOW + 60_000, pct: 3, resetsAt: second }])
})

test('counts the context in full once and falls back to a summary estimate', async ($, on) => {
  const h = await startMeter($, on)
  h.fail.add('full')
  await runMeter($)
  await h.clock.settle()
  expect(h.usageCalls.slice(1)).toEqual(['full', 'summary'])
  expect(h.state.breakdown.snap).toMatchObject({ detail: 'summary', contextTokens: 91_234, percentage: 46, model: 'claude-opus-5-5' })
  expect(h.state.breakdown.status).toEqual({ state: 'idle' })
  expect(h.state.info).toMatchObject({ id: h.info.id, version: '2.1.286', prompts: 12, cwd: '/work/claude-mods', startedAt: NOW - 134 * 60000 })
})

test('keeps the previous count and flags an error when both counts fail', async ($, on) => {
  const h = await startMeter($, on)
  await runMeter($)
  await h.clock.settle()
  const before = h.state.breakdown.snap
  expect(before.detail).toBe('full')
  h.fail.add('full')
  h.fail.add('summary')
  await runMeter($)
  await h.clock.settle()
  expect(h.state.breakdown.snap).toEqual(before)
  expect(h.state.breakdown.status).toEqual({ state: 'error' })
})

test('starts one count at a time', async ($, on) => {
  const h = await startMeter($, on)
  let release = () => {}
  h.gate = new Promise<void>(resolve => (release = resolve))
  await runMeter($)
  await runMeter($)
  await h.clock.settle()
  expect(h.usageCalls.filter(c => c === 'full')).toHaveLength(1)
  release()
  await h.clock.settle()
  expect(h.state.breakdown.status).toEqual({ state: 'idle' })
})

test('starts a new count when an earlier one has hung for a minute', async ($, on) => {
  const h = await startMeter($, on)
  h.gate = new Promise<void>(() => {})
  await runMeter($)
  await h.clock.settle()
  await h.clock.advance(61_000)
  await runMeter($)
  await h.clock.settle()
  expect(h.usageCalls.filter(c => c === 'full')).toHaveLength(2)
})

test('/clear resets the session figures and keeps the limit trends', async ($, on) => {
  const h = await startMeter($, on)
  h.usage = USAGE
  await runStep($)
  await complete($)
  await callTool($)
  await compact($)
  await measureWith($, h, { cost: { usd: 1 }, rateLimits: [{ kind: 'five_hour', percentUsed: 10 }], changed: ['cost', 'rateLimits'] })
  await runMeter($)
  await h.clock.settle()
  const epoch = h.state.epoch
  await h.clock.advance(5000)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
  await h.clock.settle()
  expect(h.state.epoch).toBe((epoch ?? 0) + 1)
  expect(h.state.requests).toMatchObject({ trackedSince: NOW + 5000, noResponse: 0, history: [], main: { requests: 0 } })
  expect(h.state.turns.count).toBe(0)
  expect(h.state.tools).toEqual({})
  expect(h.state.agents).toEqual({ usage: {}, list: [] })
  expect(h.state.compactions.count).toBe(0)
  expect(h.state.breakdown).toEqual({ snap: null, status: { state: 'idle' } })
  expect(h.state.info).toBeNull()
  expect(h.state.trends.cost).toEqual([])
  expect(h.state.trends.limits.five_hour).toHaveLength(1)
  expect(h.usageCalls.filter(c => c !== undefined)).toEqual(['full'])
})

const clearSession = ($: any) => $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)

test('/clear with the pane open counts a summary from the first turn of the new session', async ($, on) => {
  const h = await startMeter($, on, { panes: ['meter'] })
  await clearSession($)
  await h.clock.settle()
  expect(h.usageCalls.slice(1)).toEqual([])
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await h.clock.settle()
  expect(h.usageCalls.slice(1)).toEqual(['summary'])
  expect(h.state.breakdown.snap.detail).toBe('summary')
  await $.turn.start({ text: 'again', turnId: 't2' })
  await h.clock.settle()
  expect(h.usageCalls.slice(1)).toEqual(['summary'])
})

test('/clear with the pane open counts a summary from the first measure of the new session', async ($, on) => {
  const h = await startMeter($, on, { panes: ['meter'] })
  await clearSession($)
  await h.clock.settle()
  expect(h.usageCalls.slice(1)).toEqual([])
  await $.session.measure({ ...h.measure, changed: ['context'] } as never)
  await h.clock.settle()
  expect(h.usageCalls.slice(1)).toEqual(['summary'])
})

test('/clear without the pane open counts nothing', async ($, on) => {
  const h = await startMeter($, on)
  await clearSession($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await h.clock.settle()
  expect(h.usageCalls).toHaveLength(1)
})

test('/clear with the pane open never draws the session it ended', async ($, on) => {
  const h = await startMeter($, on, { panes: ['meter'] })
  await runMeter($)
  await h.clock.settle()
  expect(h.state.info.id).toBe('7edccffa-9eee-408a-aa82-52bd0ecd433')
  const ui = await mountPane($, 'terminal', 72)
  const draw = async () => paint(await ui.drawn(), 72).join('\n')
  expect(await draw()).toContain('7edccffa')
  let release = () => {}
  const gate = new Promise<void>(resolve => (release = resolve))
  h.ending = async () => {
    await gate
    await $.session.measure({ ...h.measure, changed: ['context'] } as never)
    await h.clock.settle()
    h.info = { ...h.info, id: 'new-session-id', turns: 0 }
  }
  const ending = clearSession($)
  await h.clock.settle()
  expect(h.state.info).toBeNull()
  release()
  await ending
  await h.clock.settle()
  expect(h.state.info).toBeNull()
  const before = await draw()
  expect(before).not.toContain('7edccffa')
  expect(before).toContain('Not counted yet')
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await h.clock.settle()
  expect(h.state.info).toMatchObject({ id: 'new-session-id', prompts: 0 })
  const after = await draw()
  expect(after).toContain('new-session-id')
  expect(after).not.toContain('7edccffa')
})

test('a count in flight across /clear writes nothing', async ($, on) => {
  const h = await startMeter($, on)
  h.agents = [{ id: 'a1', description: 'Review', type: 'code-reviewer', status: 'running' }]
  let release = () => {}
  h.gate = new Promise<void>(resolve => (release = resolve))
  await runMeter($)
  await h.clock.settle()
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
  release()
  await h.clock.settle()
  expect(h.state.breakdown.snap).toBeNull()
  expect(h.state.breakdown.status).toEqual({ state: 'idle' })
  expect(h.state.info).toBeNull()
  expect(h.state.agents).toEqual({ usage: {}, list: [] })
})

type Paint = { type: string; props?: Record<string, any>; children?: unknown[] }

const inlineText = (node: unknown): string => {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(inlineText).join('')
  return ((node as Paint).children ?? []).map(inlineText).join('')
}

const ellipsize = (text: string, width: number, mode: string | undefined) => {
  if (width === Infinity || text.length <= width) return [text]
  if (mode === 'truncate-middle') {
    const keep = Math.max(1, width - 1)
    const head = Math.ceil(keep / 2)
    return [`${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`]
  }
  if (mode === 'truncate-start') return [`…${text.slice(text.length - Math.max(1, width - 1))}`]
  if (mode?.startsWith('truncate')) return [`${text.slice(0, Math.max(1, width - 1))}…`]
  return text.match(new RegExp(`.{1,${Math.max(1, width)}}`, 'g')) ?? ['']
}

const kids = (el: Paint) => (el.children ?? []).flat(Infinity).filter(c => c !== null && c !== undefined && typeof c !== 'boolean')

const naturalWidth = (node: unknown): number => Math.max(0, ...paint(node, Infinity).map(l => l.length))

const paint = (node: unknown, width: number): string[] => {
  if (node === null || node === undefined || typeof node === 'boolean') return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(n => paint(n, width))
  const el = node as Paint
  const p = el.props ?? {}
  if (el.type === 'Svg') return [`[svg ${p.alt}]`]
  if (el.type === 'Button') return [`[ ${p.label} ]`]
  if (el.type === 'Text') return ellipsize(inlineText(el), width, p.wrap)
  const inner = width - (p.marginLeft ?? 0)
  const pad = ' '.repeat(p.marginLeft ?? 0)
  const lead = Array.from({ length: p.marginTop ?? 0 }, () => '')
  const children = kids(el)
  if (p.flexDirection === 'column') {
    const own = typeof p.width === 'number' ? Math.min(inner, p.width) : inner
    return [...lead, ...children.flatMap(c => paint(c, own)).map(l => pad + l)]
  }
  const gap = p.columnGap ?? p.gap ?? 0
  const rowWidth = typeof p.width === 'number' ? p.width : inner
  const fixed = children.map(c => ((c as Paint).props?.width as number | undefined) ?? null)
  const natural = children.map((c, i) => (fixed[i] ?? ((c as Paint).props?.flexGrow ? 0 : Math.min(naturalWidth(c), rowWidth))))
  const used = natural.reduce((a, b) => a + b, 0) + gap * Math.max(0, children.length - 1)
  const growers = children.filter((c, i) => fixed[i] === null && (c as Paint).props?.flexGrow).length
  const spare = Math.max(0, rowWidth - used)
  const widths = natural.map((w, i) => (fixed[i] === null && (children[i] as Paint).props?.flexGrow ? Math.floor(spare / Math.max(1, growers)) : w))
  const betweenExtra = p.justifyContent === 'space-between' && growers === 0 && children.length === 2 ? spare : 0
  const blocks = children.map((c, i) => {
    const lines = paint(c, widths[i]!)
    const align = (c as Paint).props?.justifyContent === 'flex-end'
    return lines.map(l => (typeof fixed[i] === 'number' ? (align ? l.padStart(widths[i]!) : l.padEnd(widths[i]!)) : l))
  })
  const height = Math.max(0, ...blocks.map(b => b.length))
  const rows = Array.from({ length: height }, (_, r) =>
    blocks
      .map((b, i) => (b[r] ?? '').padEnd(typeof fixed[i] === 'number' || widths[i] !== natural[i] ? widths[i]! : naturalWidth(children[i])))
      .reduce((acc, cur, i) => acc + ' '.repeat(i === 0 ? 0 : gap + (i === 1 ? betweenExtra : 0)) + cur, ''),
  )
  return [...lead, ...rows.map(l => (pad + l).trimEnd())]
}

const drawText = (tree: unknown, width: number) => paint(tree, width)

const mountPane = ($: any, surface: Surface | 'mobile', cols: number) =>
  $.ui.mount({
    plugin: 'meter',
    surface,
    component: 'Pane',
    requestId: 'meter',
    props: { title: 'Meter', isFocused: true, bodyColumns: cols, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  })

const collect = (node: unknown, pred: (n: Paint) => boolean, found: Paint[] = []) => {
  if (node === null || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    node.forEach(n => collect(n, pred, found))
    return found
  }
  const el = node as Paint
  if (pred(el)) found.push(el)
  ;(el.children ?? []).forEach(n => collect(n, pred, found))
  return found
}

const fillSession = async ($: any, h: Harness) => {
  h.stepMs = 6200
  h.measure.rateLimits = [
    { kind: 'five_hour', percentUsed: 23.5, resetsAt: new Date(NOW + 130 * 60000).toISOString() },
    { kind: 'seven_day', percentUsed: 88, resetsAt: new Date(NOW + 76 * 3600000).toISOString() },
  ]
  h.measure.cost = { usd: 3.95 }
  await $.session.measure({ ...h.measure, changed: ['context', 'rateLimits', 'cost'] } as never)
  for (const [read, usd] of [[88_000, 4.16], [60_000, 4.3], [90_000, 4.37]] as const) {
    h.usage = { ...USAGE, cache_read_input_tokens: read }
    await runStep($)
    h.measure.cost = { usd }
    await $.session.measure({ ...h.measure, changed: ['cost'] } as never)
  }
  h.usage = { ...USAGE, model: 'claude-sonnet-5-5' }
  await runStep($, { agentId: 'a1', model: 'claude-sonnet-5-5' })
  h.stepMs = 0
  await complete($, { durationMs: 41_000 })
  await complete($, { durationMs: 12_000 })
  h.toolMs = 2100
  await callTool($)
  h.toolMs = 0
  h.agents = [{ id: 'a1', description: 'Review the diff', type: 'code-reviewer', status: 'running' }]
  await compact($, { trigger: 'auto' })
  await runMeter($)
  await h.clock.settle()
}

test('draws the whole pane on the terminal at 72 columns', async ($, on) => {
  const h = await startMeter($, on)
  await fillSession($, h)
  const ui = await mountPane($, 'terminal', 72)
  const tree = await ui.drawn()
  const text = drawText(tree, 72).join('\n')
  for (const word of ['Context', '46%', '91k / 200k', 'System prompt', 'System tools', 'MCP tools', 'Memory files', 'Messages', 'Free space', 'Autocompact buffer']) {
    expect(text).toContain(word)
  }
  for (const title of ['Prompt cache', 'Usage limits', 'Tokens', 'Cost', 'Turns', 'Tools', 'Subagents', 'Compactions', 'Session']) {
    expect(text).toContain(title)
  }
  const grid = collect(tree, n => n.type === 'Box' && n.props?.key === 'grid')
  expect(grid).toHaveLength(1)
  expect(inlineText(grid[0]).replace(/ /g, '')).toHaveLength(100)
  expect(collect(tree, n => n.type === 'Svg')).toHaveLength(0)
  expect(collect(tree, n => n.type === 'Text' && n.props?.color === 'promptBorder').length).toBeGreaterThan(0)
  for (const l of drawText(tree, 72)) expect(l.length).toBeLessThanOrEqual(72)
})

const lineCount = (tree: unknown, pred: (n: Paint) => boolean, width: number) =>
  collect(tree, pred).flatMap(n => paint(n, width))

test('draws the pane on the terminal at 48 columns', async ($, on) => {
  const h = await startMeter($, on)
  await fillSession($, h)
  const tree = await (await mountPane($, 'terminal', 48)).drawn()
  const lines = drawText(tree, 48)
  for (const l of lines) expect(l.length).toBeLessThanOrEqual(48)
  expect(collect(tree, n => n.type === 'Box' && n.props?.key === 'breakdown')[0]?.props?.flexDirection).toBe('column')
  const tools = lineCount(tree, n => n.props?.key === 'tools-rows', 48).join('\n')
  expect(tools).toContain('Calls')
  expect(tools).toContain('Errors')
  expect(tools).not.toContain('Denied')
  expect(tools).not.toContain('Avg')
  const totals = lineCount(tree, n => n.props?.key === 'totals', 48).join('\n')
  expect(totals).toContain('Cache read')
  expect(totals).not.toContain('Subagents')
})

test('shows the tool and subagent columns each width allows', async ($, on) => {
  const h = await startMeter($, on)
  await fillSession($, h)
  const at = async (cols: number) => {
    const ui = await mountPane($, 'terminal', cols)
    const tree = await ui.drawn()
    await ui.unmount()
    return {
      tools: lineCount(tree, n => n.props?.key === 'tools-rows', cols).join('\n'),
      agents: lineCount(tree, n => n.props?.key === 'agents-rows', cols).join('\n'),
    }
  }
  const wide = await at(100)
  expect(wide.tools).toContain('Avg')
  expect(wide.tools).toContain('Denied')
  expect(wide.tools).toContain('2.1s')
  expect(wide.agents).toContain('Model')
  expect(wide.agents).toContain('sonnet-5-5')
  const medium = await at(72)
  expect(medium.tools).toContain('Denied')
  expect(medium.tools).not.toContain('Avg')
  expect(medium.agents).toContain('In')
  expect(medium.agents).not.toContain('Model')
  const narrow = await at(48)
  expect(narrow.agents).toContain('Out')
  expect(narrow.agents).not.toContain('In ')
})

test('draws the pane on the desktop with vector gauges, grid and sparklines', async ($, on) => {
  const h = await startMeter($, on)
  await fillSession($, h)
  const tree = await (await mountPane($, 'desktop', 100)).drawn()
  const svgs = collect(tree, n => n.type === 'Svg')
  const alts = svgs.map(n => String(n.props?.alt))
  expect(alts).toContain('Context 46%')
  expect(alts.some(a => a.startsWith('Context 46%: Messages 52k'))).toBe(true)
  expect(alts.some(a => /^Cache hit, last 3 requests: latest 98%, median 98%, min 97%$/.test(a))).toBe(true)
  expect(alts.some(a => a.startsWith('Turn durations'))).toBe(true)
  expect(alts.some(a => a.startsWith('Cost per update'))).toBe(true)
  const grid = svgs.find(n => String(n.props?.alt).startsWith('Context 46%: '))!
  expect(String(grid.props?.source)).toContain('prefers-color-scheme: dark')
  expect(String(grid.props?.source)).toContain('.s1')
  expect(String(grid.props?.source)).not.toContain('background')
  for (const n of svgs) {
    expect(n.props?.isInteractive).toBeUndefined()
    expect(typeof n.props?.width).toBe('number')
    expect(typeof n.props?.height).toBe('number')
    expect(String(n.props?.source).length).toBeLessThan(131_072)
  }
  const close = collect(tree, n => n.type === 'Button' && n.props?.key === 'close')
  expect(close).toHaveLength(1)
  expect(close[0]?.props?.role).toBe('dismiss')
})

test('draws no close button and no vector element on the terminal', async ($, on) => {
  const h = await startMeter($, on)
  await fillSession($, h)
  const tree = await (await mountPane($, 'terminal', 100)).drawn()
  expect(collect(tree, n => n.type === 'Button' && n.props?.key === 'close')).toHaveLength(0)
  expect(collect(tree, n => n.type === 'Svg')).toHaveLength(0)
})

test('leaves the pane to the engine on a surface other than the terminal and desktop', async ($, on) => {
  await startMeter($, on)
  const text = inlineText(await (await mountPane($, 'mobile', 60)).drawn())
  expect(text).toBe('engine draw')
})

test('never counts the context while drawing', async ($, on) => {
  const h = await startMeter($, on)
  await runMeter($)
  await h.clock.settle()
  const ui = await mountPane($, 'terminal', 72)
  await h.clock.advance(90_000)
  await $.session.measure({ ...h.measure, changed: ['context'] } as never)
  h.usage = USAGE
  await runStep($)
  await ui.redraw()
  expect(h.usageCalls.filter(c => c !== undefined)).toEqual(['full'])
  expect(h.agentLists).toBe(1)
})

const refreshButton = (tree: unknown) => collect(tree, n => n.type === 'Button' && n.props?.key === 'refresh')[0]

test('the refresh button counts again in full and answers the r key', async ($, on) => {
  const h = await startMeter($, on)
  await runMeter($)
  await h.clock.settle()
  const ui = await mountPane($, 'terminal', 72)
  expect(refreshButton(await ui.drawn())?.props).toMatchObject({ label: 'Refresh', hotkey: 'r' })
  await ui.press({ key: 'refresh' })
  await h.clock.settle()
  expect(h.usageCalls.filter(c => c === 'full')).toHaveLength(2)
})

test('a second press while counting does nothing and the label says so', async ($, on) => {
  const h = await startMeter($, on)
  const ui = await mountPane($, 'terminal', 72)
  expect(refreshButton(await ui.drawn())?.props?.label).toBe('Count')
  let release = () => {}
  h.gate = new Promise<void>(resolve => (release = resolve))
  const first = ui.press({ key: 'refresh' })
  await h.clock.settle()
  expect(refreshButton(await ui.drawn())?.props?.label).toBe('Refreshing')
  expect(paint(await ui.drawn(), 72).join('\n')).toContain('Counting…')
  await ui.press({ key: 'refresh' })
  await h.clock.settle()
  expect(h.usageCalls.filter(c => c === 'full')).toHaveLength(1)
  release()
  await first
  await h.clock.settle()
  expect(refreshButton(await ui.drawn())?.props?.label).toBe('Refresh')
})

test('shows an estimate when only the summary count worked', async ($, on) => {
  const h = await startMeter($, on)
  h.fail.add('full')
  await runMeter($)
  await h.clock.settle()
  const text = paint(await (await mountPane($, 'terminal', 72)).drawn(), 72).join('\n')
  expect(text).toContain('Estimated just now')
  expect(text).not.toContain('Counted')
})

test('reports a failed count and keeps the previous one on screen', async ($, on) => {
  const h = await startMeter($, on)
  await runMeter($)
  await h.clock.settle()
  const ui = await mountPane($, 'terminal', 72)
  h.fail.add('full')
  h.fail.add('summary')
  await ui.press({ key: 'refresh' })
  await h.clock.settle()
  const tree = await ui.drawn()
  const text = paint(tree, 72).join('\n')
  expect(text).toContain('Could not count the context')
  expect(text).toContain('System prompt')
  expect(refreshButton(tree)?.props?.label).toBe('Retry')
})

test('says the breakdown was not counted when the figures exist without it', async ($, on) => {
  const h = await startMeter($, on)
  await $.session.measure({ ...h.measure, changed: ['context'] } as never)
  const tree = await (await mountPane($, 'terminal', 72)).drawn()
  expect(paint(tree, 72).join('\n')).toContain('Breakdown not counted')
  expect(refreshButton(tree)?.props?.label).toBe('Count')
})

test('flags a count that the context has moved away from', async ($, on) => {
  const h = await startMeter($, on)
  await runMeter($)
  await h.clock.settle()
  const ui = await mountPane($, 'terminal', 72)
  expect(paint(await ui.drawn(), 72).join('\n')).not.toContain('context changed since')
  await $.session.measure({ ...h.measure, context: { tokens: 93_000, window: 200_000, percent: 46 }, changed: ['context'] } as never)
  expect(paint(await ui.drawn(), 72).join('\n')).not.toContain('context changed since')
  await $.session.measure({ ...h.measure, context: { tokens: 97_000, window: 200_000, percent: 48 }, changed: ['context'] } as never)
  expect(paint(await ui.drawn(), 72).join('\n')).toContain('context changed since; Refresh')
})

test('flags a count that a compaction has overtaken', async ($, on) => {
  const h = await startMeter($, on)
  await runMeter($)
  await h.clock.settle()
  const ui = await mountPane($, 'terminal', 72)
  await h.clock.advance(1000)
  await compact($)
  expect(paint(await ui.drawn(), 72).join('\n')).toContain('context changed since')
})

test('draws the empty states of a fresh session', async ($, on) => {
  await startMeter($, on, { isFresh: true })
  const text = paint(await (await mountPane($, 'terminal', 72)).drawn(), 72).join('\n')
  for (const empty of [
    'No reply yet. Figures appear after the first response.',
    'No usage-limit readings (API key, or no reply yet)',
    'No tool calls yet',
    'No subagents this session',
    'No cost ledger',
    'Not counted yet',
  ]) {
    expect(text).toContain(empty)
  }
  expect(text.match(/None yet/g)).toHaveLength(4)
})

test('draws the empty states again after /clear', async ($, on) => {
  const h = await startMeter($, on)
  await fillSession($, h)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
  await h.clock.settle()
  const text = paint(await (await mountPane($, 'terminal', 72)).drawn(), 72).join('\n')
  expect(text).toContain('No reply yet')
  expect(text).toContain('No tool calls yet')
  expect(text).toContain('No subagents this session')
  expect(text).toContain('None yet')
  expect(text).toContain('No usage-limit readings')
})

test('names the model that answered when it differs from the one asked for', async ($, on) => {
  const h = await startMeter($, on)
  h.usage = { ...USAGE, model: 'claude-sonnet-5-5' }
  await runStep($, { model: 'claude-opus-5-5' })
  const text = paint(await (await mountPane($, 'terminal', 72)).drawn(), 72).join('\n')
  expect(text).toContain('Sonnet 5.5 (fallback from Opus 5.5) · high')
})

test('says when the session is tracked from later than it started', async ($, on) => {
  const h = await startMeter($, on)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
  await runMeter($)
  await h.clock.settle()
  const text = paint(await (await mountPane($, 'terminal', 72)).drawn(), 72).join('\n')
  expect(text).toMatch(/Started +\w{3} \d\d:\d\d · tracking since \d\d:\d\d/)
})

test('predicts when a limit runs out only if that comes before its reset', async ($, on) => {
  const h = await startMeter($, on)
  const resetsAt = new Date(NOW + 5 * 3_600_000).toISOString()
  const feed = async (pct: number) => {
    h.measure.rateLimits = [{ kind: 'five_hour', percentUsed: pct, resetsAt }]
    await $.session.measure({ ...h.measure, changed: ['rateLimits'] } as never)
  }
  await feed(10)
  await h.clock.advance(10 * 60000)
  await feed(20)
  const ui = await mountPane($, 'terminal', 72)
  expect(paint(await ui.drawn(), 72).join('\n')).toContain('At this pace 100% in 1h 20m, before reset')
})

test('counts idle time since the last reading against the pace, not against the remaining budget', async ($, on) => {
  const h = await startMeter($, on)
  const resetsAt = new Date(NOW + 5 * 3_600_000).toISOString()
  const feed = async (pct: number) => {
    h.measure.rateLimits = [{ kind: 'five_hour', percentUsed: pct, resetsAt }]
    await $.session.measure({ ...h.measure, changed: ['rateLimits'] } as never)
  }
  await feed(10)
  await h.clock.advance(10 * 60000)
  await feed(20)
  await h.clock.advance(2 * 60000)
  const text = paint(await (await mountPane($, 'terminal', 72)).drawn(), 72).join('\n')
  expect(text).toContain('At this pace 100% in 1h 36m, before reset')
})

test('does not claim a limit is about to run out after a long idle stretch', async ($, on) => {
  const h = await startMeter($, on)
  const resetsAt = new Date(NOW + 5 * 3_600_000).toISOString()
  const feed = async (pct: number) => {
    h.measure.rateLimits = [{ kind: 'five_hour', percentUsed: pct, resetsAt }]
    await $.session.measure({ ...h.measure, changed: ['rateLimits'] } as never)
  }
  await feed(10)
  await h.clock.advance(10 * 60000)
  await feed(20)
  await h.clock.advance(3 * 3_600_000)
  const text = paint(await (await mountPane($, 'terminal', 72)).drawn(), 72).join('\n')
  expect(text).toContain('20%')
  expect(text).not.toContain('At this pace')
})

test('says nothing of pace when a limit would outlast its window', async ($, on) => {
  const h = await startMeter($, on)
  const resetsAt = new Date(NOW + 5 * 3_600_000).toISOString()
  const feed = async (pct: number) => {
    h.measure.rateLimits = [{ kind: 'five_hour', percentUsed: pct, resetsAt }]
    await $.session.measure({ ...h.measure, changed: ['rateLimits'] } as never)
  }
  await feed(10)
  await h.clock.advance(10 * 60000)
  await feed(11)
  const text = paint(await (await mountPane($, 'terminal', 72)).drawn(), 72).join('\n')
  expect(text).toContain('11%')
  expect(text).not.toContain('At this pace')
})

test('drops the countdown and the colour of a limit that has already reset', async ($, on) => {
  const h = await startMeter($, on)
  h.measure.rateLimits = [{ kind: 'five_hour', percentUsed: 90, resetsAt: new Date(NOW - 60000).toISOString() }]
  await $.session.measure({ ...h.measure, changed: ['rateLimits'] } as never)
  const tree = await (await mountPane($, 'terminal', 72)).drawn()
  const text = paint(tree, 72).join('\n')
  expect(text).toContain('90%')
  expect(text).not.toContain('resets')
  expect(collect(tree, n => n.type === 'Text' && n.props?.color === 'error')).toHaveLength(0)
})

test('strips control characters from every engine string it draws', async ($, on) => {
  const h = await startMeter($, on)
  h.breakdown = breakdownFixture({
    memoryFiles: [{ path: '/tmp/bad\u0007\npath/CLAUDE.md', type: 'Us\u001ber', tokens: 10 }],
    model: 'claude\u0007-opus',
  })
  ;(h.breakdown.categories as { name: string }[])[4]!.name = 'Mess\u0007ages'
  ;(h.breakdown.gridRows as { categoryName: string }[][]).forEach(row =>
    row.forEach(q => {
      if (q.categoryName === 'Messages') q.categoryName = 'Mess\u0007ages'
    }),
  )
  h.info.id = 'abc\u0007def'
  h.info.cwd = '/work/\nrepo'
  h.agents = [{ id: 'a1', description: 'Rev\u0007iew', type: 'code\n-reviewer', status: 'run\u001bning', name: 'bad\u0007name' }]
  h.usage = { ...USAGE, model: 'claude-\u0007opus-5-5' }
  await runStep($)
  await callTool($, { tool: 'mcp__ev\u0007il\ntool' })
  await runMeter($)
  await h.clock.settle()
  const hasControl = /[\u0000-\u001f\u007f-\u009f]/
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface, 100)
    const strings: string[] = []
    const walk = (n: unknown) => {
      if (typeof n === 'string') strings.push(n)
      else if (Array.isArray(n)) n.forEach(walk)
      else if (n && typeof n === 'object') {
        const el = n as Paint
        Object.values(el.props ?? {}).forEach(v => typeof v === 'string' && strings.push(v))
        ;(el.children ?? []).forEach(walk)
      }
    }
    walk(await ui.drawn())
    expect(strings.length).toBeGreaterThan(50)
    expect(strings.filter(s => hasControl.test(s))).toEqual([])
    const text = strings.join(' ')
    expect(text).toContain('mcp__ev il tool')
    expect(text).toContain('bad name')
    await ui.unmount()
  }
})

test('shows ten tools and the rest on request', async ($, on) => {
  const h = await startMeter($, on)
  for (let i = 0; i < 14; i++) await callTool($, { tool: `tool-${String(i).padStart(2, '0')}` })
  const ui = await mountPane($, 'terminal', 72)
  const rows = (tree: unknown) => lineCount(tree, n => n.props?.key === 'tools-rows', 72).filter(l => l.startsWith('tool-')).length
  let tree = await ui.drawn()
  expect(rows(tree)).toBe(10)
  expect(collect(tree, n => n.type === 'Button' && n.props?.key === 'more-tools')[0]?.props?.label).toBe('+4 more')
  await ui.press({ key: 'more-tools' })
  tree = await ui.drawn()
  expect(rows(tree)).toBe(14)
  expect(collect(tree, n => n.type === 'Button' && n.props?.key === 'more-tools')[0]?.props?.label).toBe('Show fewer')
  await ui.press({ key: 'more-tools' })
  expect(rows(await ui.drawn())).toBe(10)
  expect(h.state.expanded).toEqual([])
})

test('keeps the expanded lists across /clear', async ($, on) => {
  const h = await startMeter($, on)
  for (let i = 0; i < 14; i++) await callTool($, { tool: `tool-${String(i).padStart(2, '0')}` })
  const ui = await mountPane($, 'terminal', 72)
  await ui.press({ key: 'more-tools' })
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
  expect(h.state.expanded).toEqual(['tools'])
})

test('the desktop close button closes the pane', async ($, on) => {
  const h = await startMeter($, on)
  const ui = await mountPane($, 'desktop', 100)
  await ui.press({ key: 'close' })
  expect(h.closes).toHaveLength(1)
  expect(h.closes[0]?.id).toBe('meter')
})

test('shows only a few memory files and servers until asked', async ($, on) => {
  const h = await startMeter($, on)
  h.breakdown = breakdownFixture({
    memoryFiles: Array.from({ length: 8 }, (_, i) => ({ path: `/m/file-${i}.md`, type: 'Project', tokens: 100 + i })),
    mcpTools: Array.from({ length: 7 }, (_, i) => ({ name: `t${i}`, serverName: `srv-${i}`, tokens: 50 + i, isLoaded: true })),
  })
  await runMeter($)
  await h.clock.settle()
  const ui = await mountPane($, 'terminal', 72)
  const tree = await ui.drawn()
  const memory = lineCount(tree, n => n.props?.key === 'memory-rows', 72).length
  const mcp = lineCount(tree, n => n.props?.key === 'mcp-rows', 72).length
  expect(memory).toBe(5)
  expect(mcp).toBe(5)
  expect(collect(tree, n => n.type === 'Button' && n.props?.key === 'more-memory')[0]?.props?.label).toBe('+3 more')
  expect(collect(tree, n => n.type === 'Button' && n.props?.key === 'more-mcp')[0]?.props?.label).toBe('+2 more')
})

test('ends a count that cannot read the breakdown as an error, not as one still running', async ($, on) => {
  const h = await startMeter($, on)
  h.breakdown = { ...breakdownFixture(), gridRows: undefined }
  await runMeter($)
  await h.clock.settle()
  expect(h.state.breakdown.status).toEqual({ state: 'error' })
  expect(h.state.breakdown.snap).toBeNull()
})

test('rechunks the grid to the width: 20 across for a big window, then 10, then 5 as the pane narrows', async ($, on) => {
  const h = await startMeter($, on)
  const base = breakdownFixture() as { gridRows: unknown[][] }
  const squares = base.gridRows.flat()
  h.breakdown = { ...base, gridRows: Array.from({ length: 10 }, (_, r) => [...squares, ...squares].slice(r * 20, r * 20 + 20)) }
  await runMeter($)
  await h.clock.settle()
  const widths = async (cols: number) => {
    const ui = await mountPane($, 'terminal', cols)
    const grid = collect(await ui.drawn(), n => n.type === 'Box' && n.props?.key === 'grid')[0]!
    await ui.unmount()
    return [...new Set(grid.children!.map(row => inlineText(row).replace(/ /g, '').length))]
  }
  expect(await widths(72)).toEqual([20])
  expect(await widths(30)).toEqual([10])
  expect(await widths(20)).toEqual([5])
})

const subagentRow = (status: string, id = 'a1') => ({ id, description: 'Review', type: 'code-reviewer', status })

test('reads the agent list when a step comes from a subagent seen nowhere yet', async ($, on) => {
  const h = await startMeter($, on)
  h.usage = USAGE
  h.agents = [subagentRow('running')]
  await runStep($, { agentId: 'a1' })
  await h.clock.settle()
  expect(h.agentLists).toBe(1)
  expect(h.state.agents.list).toHaveLength(1)
  await runStep($, { agentId: 'a1', index: 1 })
  await h.clock.settle()
  expect(h.agentLists).toBe(1)
})

test('does not read the agent list for a subagent that is already listed', async ($, on) => {
  const h = await startMeter($, on)
  h.usage = USAGE
  h.agents = [subagentRow('running')]
  await complete($, { agentId: 'a1' })
  await h.clock.settle()
  expect(h.agentLists).toBe(1)
  await runStep($, { agentId: 'a1' })
  await h.clock.settle()
  expect(h.agentLists).toBe(1)
})

test('after the last subagent turn ends the pane no longer says it is running', async ($, on) => {
  const h = await startMeter($, on)
  h.usage = USAGE
  h.agents = [subagentRow('running')]
  await runStep($, { agentId: 'a1' })
  await h.clock.settle()
  const ui = await mountPane($, 'terminal', 72)
  expect(paint(await ui.drawn(), 72).join('\n')).toContain('1 running · 1 total')
  h.completing = () => {
    h.agents = [subagentRow('completed')]
  }
  await complete($, { agentId: 'a1' })
  await h.clock.settle()
  const text = paint(await ui.drawn(), 72).join('\n')
  expect(text).toContain('0 running · 1 total')
  expect(text).not.toContain('1 running')
})

for (const trigger of ['step', 'turn', 'tool'] as const) {
  test(`an agent list read started by a ${trigger} writes nothing once /clear has come`, async ($, on) => {
    const h = await startMeter($, on)
    h.usage = USAGE
    h.agents = [subagentRow('running')]
    let release = () => {}
    h.agentGate = new Promise<void>(resolve => (release = resolve))
    if (trigger === 'step') await runStep($, { agentId: 'a1' })
    else if (trigger === 'turn') await complete($, { agentId: 'a1' })
    else await callTool($, { tool: 'Agent' })
    await h.clock.settle()
    expect(h.agentLists).toBe(1)
    await clearSession($)
    release()
    await h.clock.settle()
    expect(h.state.agents).toEqual({ usage: {}, list: [] })
  })
}

for (const mode of ['ok', 'throw'] as const) {
  test(`reads the agent list once an Agent tool call has settled (${mode})`, async ($, on) => {
    const h = await startMeter($, on)
    await callTool($)
    await h.clock.settle()
    expect(h.agentLists).toBe(0)
    h.toolMode = mode
    h.calling = () => {
      h.agents = [subagentRow('running')]
    }
    const call = callTool($, { tool: 'Agent' })
    if (mode === 'throw') await expect(call).rejects.toThrow()
    else await call
    await h.clock.settle()
    expect(h.agentLists).toBe(1)
    expect(h.state.agents.list).toHaveLength(1)
  })
}

test('strips control characters from the band strings', async ($, on) => {
  const h = await startMeter($, on)
  h.measure.rateLimits = [{ kind: 'five\u0007_hour', percentUsed: 40, resetsAt: new Date(NOW + 3_600_000).toISOString() }]
  await $.session.measure({ ...h.measure, changed: ['rateLimits'] } as never)
  h.usage = { ...USAGE, model: 'claude-\u0007opus-5-5' }
  await runStep($)
  const hasControl = /[\u0000-\u001f\u007f-\u009f]/
  for (const surface of ['terminal', 'desktop'] as const) {
    const strings: string[] = []
    const walk = (n: unknown) => {
      if (typeof n === 'string') strings.push(n)
      else if (Array.isArray(n)) n.forEach(walk)
      else if (n && typeof n === 'object') {
        const el = n as Paint
        Object.values(el.props ?? {}).forEach(v => typeof v === 'string' && strings.push(v))
        ;(el.children ?? []).forEach(walk)
      }
    }
    walk(await (await $.ui.mount(mountProps(surface))).drawn())
    expect(strings.length).toBeGreaterThan(10)
    expect(strings.filter(v => hasControl.test(v))).toEqual([])
    const text = strings.join(' ')
    expect(text).toContain('five _hour')
    expect(text).toContain('claude- opus-5-5')
  }
})

test('a main-thread step and a subagent step without usage leave the subagent usage empty', async ($, on) => {
  const h = await startMeter($, on)
  h.usage = USAGE
  await runStep($)
  expect(h.state.requests.main.requests).toBe(1)
  expect(h.state.agents).toBeUndefined()
  h.usage = null
  h.sets = []
  await runStep($, { agentId: 'a1' })
  await h.clock.settle()
  expect(h.sets).toEqual(['requests'])
  expect(h.state.agents).toBeUndefined()
  expect(h.agentLists).toBe(0)
})

test('a main-thread step writes the cache and the request totals once each, and a subagent step the agents and totals', async ($, on) => {
  const h = await startMeter($, on)
  h.usage = USAGE
  h.sets = []
  await runStep($)
  expect([...h.sets].sort()).toEqual(['cache', 'requests'])
  await runStep($, { agentId: 'a1' })
  await h.clock.settle()
  h.sets = []
  await runStep($, { agentId: 'a1', index: 1 })
  await h.clock.settle()
  expect([...h.sets].sort()).toEqual(['agents', 'requests'])
})

test('files the 9th distinct model under (other) and keeps counting the ones it has', async ($, on) => {
  const h = await startMeter($, on)
  for (let i = 0; i < 9; i++) {
    h.usage = { ...USAGE, model: `model-${i}` }
    await runStep($, { index: i })
  }
  h.usage = { ...USAGE, model: 'model-0' }
  await runStep($, { index: 9 })
  const byModel = h.state.requests.byModel
  expect(Object.keys(byModel)).toHaveLength(9)
  expect(byModel['(other)'].requests).toBe(1)
  expect(byModel['model-8']).toBeUndefined()
  expect(byModel['model-0'].requests).toBe(2)
})

test('keeps usage for 50 subagents and drops the one idle the longest', async ($, on) => {
  const h = await startMeter($, on)
  h.usage = USAGE
  h.stepMs = 5
  for (let i = 0; i < 50; i++) await runStep($, { agentId: `a${i}`, index: i })
  await runStep($, { agentId: 'a0', index: 50 })
  await runStep($, { agentId: 'a50', index: 51 })
  await h.clock.settle()
  const ids = Object.keys(h.state.agents.usage)
  expect(ids).toHaveLength(50)
  expect(ids).not.toContain('a1')
  expect(ids).toContain('a0')
  expect(ids).toContain('a50')
})

for (const [gap, isShown] of [[59_999, false], [60_000, true]] as const) {
  test(`${isShown ? 'predicts' : 'does not predict'} a limit running out from readings ${gap} ms apart`, async ($, on) => {
    const h = await startMeter($, on)
    const resetsAt = new Date(NOW + 5 * 3_600_000).toISOString()
    const feed = async (pct: number) => {
      h.measure.rateLimits = [{ kind: 'five_hour', percentUsed: pct, resetsAt }]
      await $.session.measure({ ...h.measure, changed: ['rateLimits'] } as never)
    }
    await feed(10)
    await h.clock.advance(gap)
    await feed(20)
    const text = paint(await (await mountPane($, 'terminal', 72)).drawn(), 72).join('\n')
    expect(text).toContain('20%')
    if (isShown) expect(text).toContain('At this pace 100% in 8m, before reset')
    else expect(text).not.toContain('At this pace')
  })
}

test('sizes the cache sparkline to the width, between 8 and 40 requests', async ($, on) => {
  const h = await startMeter($, on)
  h.usage = USAGE
  for (let i = 0; i < 50; i++) await runStep($, { index: i })
  const label = async (cols: number) => {
    const ui = await mountPane($, 'terminal', cols)
    const text = paint(await ui.drawn(), cols).join('\n')
    await ui.unmount()
    return /last (\d+) requests/.exec(text)?.[1]
  }
  expect(await label(200)).toBe('40')
  expect(await label(40)).toBe('16')
  expect(await label(30)).toBe('8')
})

test('every vector the pane draws declares the svg namespace', async ($, on) => {
  const h = await startMeter($, on)
  await fillSession($, h)
  const svgs = collect(await (await mountPane($, 'desktop', 100)).drawn(), n => n.type === 'Svg')
  expect(svgs.length).toBeGreaterThan(5)
  for (const n of svgs) expect(String(n.props?.source)).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" /)
})

test('draws the desktop grid again when the pane width changes', async ($, on) => {
  const h = await startMeter($, on)
  await runMeter($)
  await h.clock.settle()
  const gridWidth = async (cols: number) => {
    const ui = await mountPane($, 'desktop', cols)
    const grid = collect(await ui.drawn(), n => n.type === 'Svg' && String(n.props?.alt).startsWith('Context 46%: '))[0]
    await ui.unmount()
    return grid?.props?.width
  }
  expect(await gridWidth(100)).toBe(127)
  expect(await gridWidth(100)).toBe(127)
  expect(await gridWidth(20)).toBe(62)
})

test('draws the desktop grid again when the same count is renamed within the same moment', async ($, on) => {
  const h = await startMeter($, on)
  await runMeter($)
  await h.clock.settle()
  const ui = await mountPane($, 'desktop', 100)
  const alts = async () => collect(await ui.drawn(), n => n.type === 'Svg').map(n => String(n.props?.alt))
  expect((await alts()).some(a => a.includes('System tools 14k'))).toBe(true)
  const renamed = breakdownFixture() as { categories: { name: string }[]; gridRows: { categoryName: string }[][] }
  renamed.categories.forEach(c => {
    if (c.name === 'System tools') c.name = 'Built-in tools'
  })
  renamed.gridRows.forEach(row =>
    row.forEach(q => {
      if (q.categoryName === 'System tools') q.categoryName = 'Built-in tools'
    }),
  )
  h.breakdown = renamed as never
  await ui.press({ key: 'refresh' })
  await h.clock.settle()
  const after = await alts()
  expect(after.some(a => a.includes('Built-in tools 14k'))).toBe(true)
  expect(after.some(a => a.includes('System tools'))).toBe(false)
})

test('builds a memoized value once per key', () => {
  let built = 0
  const build = () => ({ n: ++built })
  const first = memoized('memo-a', build)
  expect(memoized('memo-a', build)).toBe(first)
  expect(built).toBe(1)
  expect(memoized('memo-b', build)).not.toBe(first)
  expect(built).toBe(2)
})

test('rounds token counts before choosing the unit', () => {
  expect(fmtTokens(999)).toBe('999')
  expect(fmtTokens(1_000)).toBe('1k')
  expect(fmtTokens(999_499)).toBe('999k')
  expect(fmtTokens(999_500)).toBe('1.0M')
  expect(fmtTokens(999_600)).toBe('1.0M')
  expect(fmtTokens(1_000_000)).toBe('1.0M')
  expect(fmtTokens1(999)).toBe('999')
  expect(fmtTokens1(1_000)).toBe('1.0k')
  expect(fmtTokens1(999_949)).toBe('999.9k')
  expect(fmtTokens1(999_950)).toBe('1.0M')
  expect(fmtTokens1(1_250_000)).toBe('1.3M')
})

for (const [requested, answered] of [
  ['claude-opus-5-5[1m]', 'claude-opus-5-5'],
  ['claude-opus-5-5', 'claude-opus-5-5-20260101'],
  ['claude-opus-5-5[1m]', 'claude-opus-5-5-20260101'],
] as const) {
  test(`does not call ${answered} a fallback from ${requested}`, async ($, on) => {
    const h = await startMeter($, on)
    h.usage = { ...USAGE, model: answered }
    await runStep($, { model: requested })
    const text = paint(await (await mountPane($, 'terminal', 72)).drawn(), 72).join('\n')
    expect(text).toContain('Opus 5.5 · high')
    expect(text).not.toContain('fallback')
  })
}

test('draws the build date of the engine when it parses', async ($, on) => {
  const h = await startMeter($, on)
  await runMeter($)
  await h.clock.settle()
  const text = paint(await (await mountPane($, 'terminal', 72)).drawn(), 72).join('\n')
  expect(text).toMatch(/Engine\s+2\.1\.286 \(built \w{3} \d{1,2}\)/)
})

test('leaves the build date out when the engine gives one that does not parse', async ($, on) => {
  const h = await startMeter($, on)
  h.info.builtAt = 'sometime last week'
  await runMeter($)
  await h.clock.settle()
  const text = paint(await (await mountPane($, 'terminal', 72)).drawn(), 72).join('\n')
  expect(text).toMatch(/Engine\s+2\.1\.286$/m)
  expect(text).not.toContain('built')
  expect(text).not.toContain('NaN')
  expect(text).not.toContain('undefined')
})
