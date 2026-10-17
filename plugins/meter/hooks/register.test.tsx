import { expect, mock, test } from 'claude-code/testing'

import { SVG_COLORS, fmtTokens } from './format'
import { modelName } from './model'

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

type BandOptions = { effort?: string; requested?: string; answered?: string; limits?: unknown[] }

const drawBand = async ($: any, on: any, surface: Surface, bodyColumns: number, options: BandOptions = {}) => {
  const clock = mock.clock(on, { now: NOW - 8 * 60000 })
  on('turn.step', async function* (_: unknown, e: { turnId: string; index: number }) {
    return {
      turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn',
      usage: { input_tokens: 40, output_tokens: 10, cache_read_input_tokens: 88_000, cache_creation_input_tokens: 2_100, model: options.answered ?? 'claude-opus-5-5' },
    }
  })
  on('session.measure', (_: unknown, e: { changed: unknown }) => ({ changed: e.changed }))
  await $.session.measure({
    context: { tokens: 91_234, window: 200_000, percent: 46 },
    rateLimits: options.limits ?? [
      { kind: 'five_hour', percentUsed: 23.5, resetsAt: new Date(NOW + 130 * 60000).toISOString() },
      { kind: 'seven_day', percentUsed: 88, resetsAt: new Date(NOW + 76 * 3600000).toISOString() },
    ],
    cost: { usd: 1.8432 },
    changed: ['context', 'rateLimits', 'cost'],
  })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: options.requested ?? 'claude-opus-5-5', messageCount: 1, effort: options.effort })) {
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

const splitCard = (text: string) => ({ text, row: text.slice(text.indexOf('[/card]') + 8).replace(/^\n/, '') })

const findNode = (node: unknown, pred: (n: Node) => boolean): Node | undefined => {
  if (node === null || typeof node !== 'object') return undefined
  if (Array.isArray(node)) return node.map(n => findNode(n, pred)).find(Boolean)
  const el = node as Node
  if (pred(el)) return el
  return (el.children ?? []).map(n => findNode(n, pred)).find(Boolean)
}

for (const bodyColumns of [140, 100, 60]) {
  test(`draws on desktop at ${bodyColumns} columns`, async ($, on) => {
    const { text, row } = splitCard(flatten(await drawBand($, on, 'desktop', bodyColumns)))
    expect(text).toContain('~52m left (idle 8m, assumes 1h)')
    expect(text).toContain('Opus 5.5')
    expect(row).not.toContain('Opus 5.5')
    expect(row).toContain('Context')
    expect(row).toContain('46%')
    expect(row).toContain('Cache 98%')
    expect(row).toContain('$1.84')
    expect(row).toContain('[bar Context 46%]')
    expect(row).toContain('↻ 2h 10m')
    if (bodyColumns >= 80) expect(row).toContain('[bar Week limit 88%]')
  })
}

test('leaves the desktop band without a top margin', async ($, on) => {
  const tree = await drawBand($, on, 'desktop', 140)
  expect(findNode(tree, n => n.type === 'Box' && n.props?.key === 'meter')?.props?.marginTop).toBeUndefined()
  expect(findNode(tree, n => n.type === 'Box' && n.props?.key === 'meter')?.props?.paddingLeft).toBeUndefined()
})

test('draws the desktop gauges from the palette at rest and from the alert colours otherwise', async ($, on) => {
  const limits = [
    { kind: 'five_hour', percentUsed: 60, resetsAt: new Date(NOW + 130 * 60000).toISOString() },
    { kind: 'seven_day', percentUsed: 88, resetsAt: new Date(NOW + 76 * 3600000).toISOString() },
  ]
  const tree = await drawBand($, on, 'desktop', 140, { limits })
  const source = (alt: string) => String(findNode(tree, n => n.type === 'Svg' && n.props?.alt === alt)?.props?.source)
  expect(source('Context 46%')).toContain('class="s1"')
  expect(source('5h limit 60%')).toContain(SVG_COLORS.warning)
  expect(source('5h limit 60%')).not.toContain('class="s1"')
  expect(source('Week limit 88%')).toContain(SVG_COLORS.error)
})

test('names the fallback model in the hover card and never in the band', async ($, on) => {
  const tree = await drawBand($, on, 'desktop', 150, { effort: 'high', requested: 'claude-opus-5-5', answered: 'claude-sonnet-5-5' })
  const { text, row } = splitCard(flatten(tree))
  expect(text).toContain('Sonnet 5.5 · fallback from Opus 5.5 · high effort · claude-sonnet-5-5')
  expect(row).not.toContain('Sonnet')
  expect(row).not.toContain('fallback')
})

test('never puts the model in the band row on the desktop', async ($, on) => {
  const h = await startMeter($, on, { model: 'claude-opus-5-5' })
  h.usage = { ...USAGE, model: 'claude-sonnet-5-5' }
  await runStep($, { model: 'claude-opus-5-5' })
  for (const cols of [140, 100, 60]) {
    const { text, row } = await bandOf($, 'desktop', cols)
    expect(text).toContain('Model')
    expect(row).toContain('Context')
    for (const word of ['Opus', 'Sonnet', 'claude', 'fallback', 'high']) expect(row).not.toContain(word)
  }
})

const mountProps = (surface: string = 'desktop', bodyColumns = 140, hasSurvey = false, view: { agentId?: string } = {}) => ({
  plugin: 'meter',
  surface,
  component: 'AbovePrompt',
  props: { hasSurvey, isWorking: false, maxRows: 10, bodyColumns, scroll: { offset: 0, bodyRows: 10 }, view },
}) as never

test('clears the band on /clear on the desktop', async ($, on) => {
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
  const before = flatten(await (await $.ui.mount(mountProps('desktop'))).drawn())
  expect(before).toContain('$1.84')
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
  const after = flatten(await (await $.ui.mount(mountProps('desktop'))).drawn())
  expect(after).toContain('engine band')
  expect(after).not.toContain('$1.84')
})

test('drops the countdown once a limit has reset on the desktop', async ($, on) => {
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
  const tree = await (await $.ui.mount(mountProps('desktop'))).drawn()
  const text = flatten(tree)
  const row = text.slice(text.indexOf('[/card]') + 8)
  const card = text.slice(0, text.indexOf('[/card]'))
  const stale = findNode(tree, n => n.type === 'Text' && flatten(n) === '24%')
  const live = findNode(tree, n => n.type === 'Text' && flatten(n) === '88%')
  expect(stale?.props).toMatchObject({ dimColor: true, bold: false })
  expect(stale?.props?.color).toBeUndefined()
  expect(live?.props).toMatchObject({ color: 'error', bold: true })
  expect(row).toContain('5h')
  expect(row).toContain('24%')
  expect(row).not.toContain('↻ 0m')
  expect(row).toContain('↻ 3d 4h')
  expect(card).not.toContain('5h limit')
  expect(card).toContain('Week limit')
})

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
  test(`starts the clock once and registers no command on the ${surface}`, async ($, on) => {
    const calls = await startSession($, on, surface)
    expect(calls.every).toBe(1)
    expect(calls.commands).toEqual([])
  })
}

const harness = async ($: any, on: any) => {
  const clock = mock.clock(on, { now: NOW })
  const h = {
    clock,
    registers: [] as Record<string, unknown>[],
    agentLists: 0,
    sets: [] as string[],
    agentGate: null as Promise<void> | null,
    agentListFails: false,
    toolGate: null as Promise<void> | null,
    stepGate: null as Promise<void> | null,
    modelGates: [] as Promise<void>[],
    completing: null as (() => void) | null,
    calling: null as (() => void) | null,
    agents: [] as Record<string, unknown>[],
    info: { model: 'claude-opus-5-5' },
    state: {} as Record<string, any>,
    usage: null as Record<string, unknown> | null,
    stepMs: 0,
    toolMode: 'ok' as 'ok' | 'error' | 'deny' | 'throw',
    measure: { context: { tokens: 91_234, window: 200_000, percent: 46 }, rateLimits: [] as unknown[], cost: undefined as unknown },
  }
  on('state.set', (_: unknown, e: { plugin: string; key: string; value: unknown }, next: any) => {
    if (e.plugin === 'meter') {
      h.state[e.key] = e.value
      h.sets.push(e.key)
    }
    return next(e)
  })
  on('session.usage', () => ({
    value: {
      startedAt: NOW - (2 * 60 + 14) * 60000,
      context: h.measure.context,
      rateLimits: h.measure.rateLimits,
      cost: h.measure.cost,
    },
  }))
  on('session.model', async () => {
    const value = h.info.model
    const gate = h.modelGates.shift()
    if (gate) await gate
    return { value }
  })
  on('agent.list', async () => {
    h.agentLists++
    if (h.agentGate) await h.agentGate
    if (h.agentListFails) return { deny: 'refused' }
    return { value: h.agents }
  })
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('command.register', (_: unknown, e: { name: string }) => {
    h.registers.push(e)
    return { value: { command: e.name } }
  })
  on('session.start', (_: unknown, e: unknown) => e as never)
  on('session.end', (_: unknown, e: { sessionId: string }) => ({ sessionId: e.sessionId }) as never)
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }) as never)
  on('session.measure', (_: unknown, e: { changed: unknown }) => ({ changed: e.changed }))
  on('turn.step', async function* (_: unknown, e: { turnId: string; index: number }) {
    if (h.stepMs) await clock.advance(h.stepMs)
    if (h.stepGate) await h.stepGate
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: h.usage }
  })
  on('turn.complete', (_: unknown, e: { answer: string }) => {
    h.completing?.()
    return { text: e.answer }
  })
  on('tool.call', async () => {
    h.calling?.()
    if (h.toolGate) await h.toolGate
    if (h.toolMode === 'throw') throw new Error('tool crashed')
    if (h.toolMode === 'deny') return { deny: 'not allowed' }
    if (h.toolMode === 'error') return { result: 'bad', isError: true }
    return { result: 'fine' }
  })
  on('command.run', { command: 'model' }, () => ({ text: 'ok' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine draw'] }) as never)
  return h
}

const startMeter = async ($: any, on: any, options?: { isFresh?: boolean; model?: string }) => {
  const h = await harness($, on)
  if (options?.isFresh) h.measure.context = { window: 200_000 } as never
  if (options?.model) h.info.model = options.model
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await h.clock.settle()
  return h
}

const USAGE = { input_tokens: 40, output_tokens: 10, cache_read_input_tokens: 88_000, cache_creation_input_tokens: 2_100, model: 'claude-opus-5-5' }

const runStep = async ($: any, input: Record<string, unknown> = {}) => {
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3, effort: 'high', ...input })) {
  }
}

const complete = ($: any, input: Record<string, unknown> = {}) =>
  $.turn.complete({ answer: 'done', durationMs: 4000, isAborted: false, turnId: 't1', reason: 'answer', ...input })

const callTool = ($: any, input: Record<string, unknown> = {}) => $.tool.call({ tool: 'Bash', command: 'ls', ...input })

const hintLine = async ($: any, columns = 140) =>
  flatten(await (await $.ui.mount({ plugin: 'meter', surface: 'terminal', component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' }, viewport: { columns, rows: 40, isFullscreen: false } } as never)).drawn()).split('\n')[0]

const clearSession = ($: any) => $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)

type Paint = { type: string; props?: Record<string, any>; children?: unknown[] }

test('draws a 1% context gauge with a visible fill', async ($, on) => {
  const h = await startMeter($, on)
  h.measure.context = { tokens: 2_000, window: 200_000, percent: 1 }
  await $.session.measure({ ...h.measure, changed: ['context'] } as never)
  const tree = await (await $.ui.mount(mountProps('desktop'))).drawn()
  const gauge = findNode(tree, n => n.type === 'Svg' && n.props?.alt === 'Context 1%')
  expect(String(gauge?.props?.source)).toContain('<rect width="3"')
})

const subagentRow = (status: string, id = 'a1') => ({ id, description: 'Review', type: 'code-reviewer', status })

test('reads the agent list when a step comes from a subagent seen nowhere yet', async ($, on) => {
  const h = await startMeter($, on)
  h.usage = USAGE
  h.agents = [subagentRow('running')]
  await runStep($, { agentId: 'a1' })
  await h.clock.settle()
  expect(h.agentLists).toBe(1)
  expect(h.state.subagents.list).toHaveLength(1)
  await runStep($, { agentId: 'a1', index: 1 })
  await h.clock.settle()
  expect(h.agentLists).toBe(1)
})

test("reads the agent list on a subagent's first step even when a tool call was recorded during it", async ($, on) => {
  const h = await startMeter($, on)
  h.usage = USAGE
  h.agents = [subagentRow('running')]
  let release = () => {}
  h.stepGate = new Promise<void>(resolve => (release = resolve))
  const step = runStep($, { agentId: 'a1' })
  await h.clock.settle()
  await callTool($, { agentId: 'a1', tool: 'Read' })
  release()
  await step
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

test('after the last subagent turn ends the stored row says completed', async ($, on) => {
  const h = await startMeter($, on)
  h.usage = USAGE
  h.agents = [subagentRow('running')]
  await runStep($, { agentId: 'a1' })
  await h.clock.settle()
  expect(h.state.subagents.list[0].status).toBe('running')
  h.completing = () => {
    h.agents = [subagentRow('completed')]
  }
  await complete($, { agentId: 'a1' })
  await h.clock.settle()
  expect(h.state.subagents.list[0].status).toBe('completed')
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
    expect(h.state.subagents).toEqual({ activity: {}, list: [] })
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
    expect(h.state.subagents.list).toHaveLength(1)
  })
}

test('strips control characters from the band strings', async ($, on) => {
  const h = await startMeter($, on)
  h.measure.rateLimits = [{ kind: 'five\u0007_hour', percentUsed: 40, resetsAt: new Date(NOW + 3_600_000).toISOString() }]
  await $.session.measure({ ...h.measure, changed: ['rateLimits'] } as never)
  h.usage = { ...USAGE, model: 'claude-\u0007opus-5-5' }
  await runStep($)
  const hasControl = /[\u0000-\u001f\u007f-\u009f]/
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
  walk(await (await $.ui.mount(mountProps('desktop'))).drawn())
  expect(strings.length).toBeGreaterThan(10)
  expect(strings.filter(v => hasControl.test(v))).toEqual([])
  const text = strings.join(' ')
  expect(text).toContain('five _hour')
  expect(text).toContain('claude- opus-5-5')
})

test('a main-thread step and a subagent step without usage leave the subagent usage empty', async ($, on) => {
  const h = await startMeter($, on)
  h.usage = USAGE
  await runStep($)
  expect(h.state.subagents).toBeUndefined()
  h.usage = null
  h.sets = []
  await runStep($, { agentId: 'a1' })
  await h.clock.settle()
  expect(h.sets).toEqual([])
  expect(h.state.subagents).toBeUndefined()
  expect(h.agentLists).toBe(0)
})

test('a main-thread step writes the cache and the model once each, and a subagent step the subagents', async ($, on) => {
  const h = await startMeter($, on)
  h.usage = USAGE
  h.sets = []
  await runStep($)
  expect([...h.sets].sort()).toEqual(['cache', 'model'])
  await runStep($, { agentId: 'a1' })
  await h.clock.settle()
  h.sets = []
  await runStep($, { agentId: 'a1', index: 1 })
  await h.clock.settle()
  expect([...h.sets].sort()).toEqual(['subagents'])
})

test('keeps activity for 50 subagents and drops the one idle the longest', async ($, on) => {
  const h = await startMeter($, on)
  h.usage = USAGE
  h.stepMs = 5
  for (let i = 0; i < 50; i++) await runStep($, { agentId: `a${i}`, index: i })
  await runStep($, { agentId: 'a0', index: 50 })
  await runStep($, { agentId: 'a50', index: 51 })
  await h.clock.settle()
  const ids = Object.keys(h.state.subagents.activity)
  expect(ids).toHaveLength(50)
  expect(ids).not.toContain('a1')
  expect(ids).toContain('a0')
  expect(ids).toContain('a50')
})

test('rounds token counts before choosing the unit', () => {
  expect(fmtTokens(999)).toBe('999')
  expect(fmtTokens(1_000)).toBe('1k')
  expect(fmtTokens(999_499)).toBe('999k')
  expect(fmtTokens(999_500)).toBe('1.0M')
  expect(fmtTokens(999_600)).toBe('1.0M')
  expect(fmtTokens(1_000_000)).toBe('1.0M')
})

for (const [requested, answered, shown] of [
  ['claude-opus-5-5[1m]', 'claude-opus-5-5', 'Opus 5.5'],
  ['claude-opus-5-5', 'claude-opus-5-5-20260101', 'Opus 5.5'],
  ['claude-opus-5-5[1m]', 'claude-opus-5-5-20260101', 'Opus 5.5'],
  ['us.anthropic.claude-opus-5-5-v1:0', 'claude-opus-5-5', 'Opus 5.5'],
  ['claude-sonnet-4-20250514[1m]', 'claude-sonnet-4-20250514', 'Sonnet 4'],
  ['claude-sonnet-4', 'claude-sonnet-4-20250514', 'Sonnet 4'],
] as const) {
  test(`does not call ${answered} a fallback from ${requested}`, async ($, on) => {
    const h = await startMeter($, on)
    h.usage = { ...USAGE, model: answered }
    await runStep($, { model: requested })
    const { text } = await bandOf($, 'desktop')
    expect(text).toContain(`${shown} · high effort`)
    expect(text).not.toContain('fallback')
  })
}

const bandOf = async ($: any, surface: Surface = 'desktop', bodyColumns = 140) =>
  splitCard(flatten(await (await $.ui.mount(mountProps(surface, bodyColumns))).drawn()))

const modelRow = async ($: any) =>
  flatten(findNode(await (await $.ui.mount(mountProps('desktop'))).drawn(), n => n.type === 'Box' && n.props?.key === 'Model'))

test('shows the selected model in the hover card before any answer', async ($, on) => {
  await startMeter($, on, { model: 'claude-opus-5-5[1m]' })
  expect(await modelRow($)).toMatch(/^Model\s+Opus 5\.5 · claude-opus-5-5\[1m\]$/)
})

test('a /model switch shows the selected model in the hover card until the new one answers', async ($, on) => {
  const h = await startMeter($, on)
  h.usage = USAGE
  await runStep($)
  expect(await modelRow($)).toMatch(/^Model\s+Opus 5\.5 · high effort · claude-opus-5-5$/)
  await h.clock.advance(60_000)
  h.info.model = 'claude-sonnet-5-5'
  const result = await $.command.run({ command: 'model' } as never)
  await h.clock.settle()
  expect(result.text).toBe('ok')
  expect(h.state.model.selected).toBe('claude-sonnet-5-5')
  expect(await modelRow($)).toMatch(/^Model\s+Sonnet 5\.5 · claude-sonnet-5-5$/)
  h.usage = { ...USAGE, model: 'claude-sonnet-5-5' }
  await runStep($, { model: 'claude-sonnet-5-5' })
  expect(await modelRow($)).toMatch(/^Model\s+Sonnet 5\.5 · high effort · claude-sonnet-5-5$/)
})

test('an answer still streaming when /model switched keeps the selection until the new model answers', async ($, on) => {
  const h = await startMeter($, on, { model: 'claude-opus-5-5' })
  h.usage = USAGE
  h.stepMs = 6000
  const step = runStep($, { model: 'claude-opus-5-5' })
  await h.clock.advance(5000)
  h.info.model = 'claude-sonnet-5-5'
  await $.command.run({ command: 'model' } as never)
  await step
  await h.clock.settle()
  expect(h.state.model).toMatchObject({ selected: 'claude-sonnet-5-5', answered: 'claude-opus-5-5' })
  expect(await modelRow($)).toMatch(/^Model\s+Sonnet 5\.5 · claude-sonnet-5-5$/)
  expect((await bandOf($)).text).toContain('Sonnet 5.5 · claude-sonnet-5-5')
  expect((await bandOf($)).text).not.toContain('Opus')
})

test('an answer requested after the /model switch wins over the selection', async ($, on) => {
  const h = await startMeter($, on, { model: 'claude-opus-5-5' })
  await h.clock.advance(1000)
  h.info.model = 'claude-sonnet-5-5'
  await $.command.run({ command: 'model' } as never)
  await h.clock.settle()
  h.stepMs = 500
  h.usage = { ...USAGE, model: 'claude-sonnet-5-5' }
  await runStep($, { model: 'claude-sonnet-5-5' })
  expect(await modelRow($)).toMatch(/^Model\s+Sonnet 5\.5 · high effort · claude-sonnet-5-5$/)
})

test('an answer for the selected model wins even when it was requested before the switch', async ($, on) => {
  const h = await startMeter($, on, { model: 'opus' })
  h.usage = USAGE
  h.stepMs = 3000
  const step = runStep($, { model: 'claude-opus-5-5' })
  await h.clock.advance(1000)
  h.info.model = 'claude-opus-5-5[1m]'
  await $.command.run({ command: 'model' } as never)
  await step
  await h.clock.settle()
  expect(h.state.model.selectedAt).toBeGreaterThan(h.state.model.answeredRequestedAt)
  expect(await modelRow($)).toMatch(/^Model\s+Opus 5\.5 · high effort · claude-opus-5-5$/)
})

test('a model switch that bypasses /model shows at the next turn start', async ($, on) => {
  const h = await startMeter($, on)
  h.usage = USAGE
  await runStep($)
  await h.clock.advance(60_000)
  h.info.model = 'claude-sonnet-5-5'
  expect(await modelRow($)).toMatch(/^Model\s+Opus 5\.5 · high effort/)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await h.clock.settle()
  expect(await modelRow($)).toMatch(/^Model\s+Sonnet 5\.5 · claude-sonnet-5-5$/)
  h.usage = { ...USAGE, model: 'claude-sonnet-5-5' }
  await runStep($, { model: 'claude-sonnet-5-5' })
  expect(await modelRow($)).toMatch(/^Model\s+Sonnet 5\.5 · high effort · claude-sonnet-5-5$/)
})

test('reading the same selected model again keeps the precise name of the model that answered', async ($, on) => {
  const h = await startMeter($, on, { model: 'opus' })
  h.usage = USAGE
  await runStep($)
  await h.clock.advance(60_000)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await h.clock.settle()
  expect(await modelRow($)).toMatch(/^Model\s+Opus 5\.5 · high effort/)
  expect(h.state.model.selectedAt).toBe(NOW)
})

test('keeps the model in the desktop hover card and out of the desktop band', async ($, on) => {
  const h = await startMeter($, on, { model: 'claude-opus-5-5' })
  h.usage = USAGE
  await runStep($)
  const { text, row } = await bandOf($, 'desktop')
  expect(row).not.toContain('Opus 5.5')
  expect(text).toContain('Opus 5.5 · high effort · claude-opus-5-5')
})

test('/clear keeps the selected model, drops the answer and leaves the band to the engine', async ($, on) => {
  const h = await startMeter($, on, { model: 'claude-opus-5-5' })
  h.usage = USAGE
  await runStep($)
  await clearSession($)
  await h.clock.settle()
  expect(h.state.model).toMatchObject({ selected: 'claude-opus-5-5', answered: null, effort: null })
  expect(flatten(await (await $.ui.mount(mountProps('terminal'))).drawn())).toBe('engine draw')
  expect(flatten(await (await $.ui.mount(mountProps('desktop'))).drawn())).toBe('engine draw')
})

test('a slower older model read cannot overwrite a newer one', async ($, on) => {
  const h = await startMeter($, on, { model: 'claude-opus-5-5' })
  let release = () => {}
  h.modelGates.push(new Promise<void>(resolve => (release = resolve)))
  await $.turn.start({ text: 'hi', turnId: 't1' })
  h.info.model = 'claude-sonnet-5-5'
  await $.turn.start({ text: 'hi', turnId: 't2' })
  await h.clock.settle()
  expect(h.state.model.selected).toBe('claude-sonnet-5-5')
  release()
  await h.clock.settle()
  expect(h.state.model.selected).toBe('claude-sonnet-5-5')
})

for (const empty of ['', '   ', '\u0007\n']) {
  test(`keeps the selected model when the engine reports ${JSON.stringify(empty)}`, async ($, on) => {
    const h = await startMeter($, on, { model: 'claude-opus-5-5' })
    h.sets = []
    h.info.model = empty
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await h.clock.settle()
    expect(h.sets).not.toContain('model')
    expect(h.state.model.selected).toBe('claude-opus-5-5')
  })
}

for (const reason of ['clear', 'resume'] as const) {
  test(`reads the selected model again after a ${reason} when it changed`, async ($, on) => {
    const h = await startMeter($, on, { model: 'claude-opus-5-5' })
    h.usage = USAGE
    await runStep($)
    await h.clock.advance(60_000)
    h.info.model = 'claude-sonnet-5-5'
    await $.session.end({ reason, sessionId: 's1', resume: { id: 's1' } } as never)
    await h.clock.settle()
    expect(h.state.model).toMatchObject({ selected: 'claude-sonnet-5-5', answered: null })
    expect(await hintLine($)).toBe('Sonnet 5.5')
  })
}

test('names an unknown model in full in the hover card and not in the band', async ($, on) => {
  const id = `custom-model-${'x'.repeat(27)}`
  await startMeter($, on, { model: id })
  const { text, row } = await bandOf($)
  expect(id).toHaveLength(40)
  expect(row).not.toContain('custom-model')
  expect(text).toContain(id)
})

for (const [id, name] of [
  ['us.anthropic.claude-opus-5-5-v1:0', 'Opus 5.5'],
  ['anthropic.claude-sonnet-4-5-20250929-v1:0', 'Sonnet 4.5'],
  ['claude-opus-4-1-20250805', 'Opus 4.1'],
  ['claude-opus-5-5', 'Opus 5.5'],
  ['claude-opus-5-5[1m]', 'Opus 5.5'],
  ['claude-opus-4-20250514', 'Opus 4'],
  ['claude-sonnet-4', 'Sonnet 4'],
  ['claude-sonnet-4[1m]', 'Sonnet 4'],
  ['claude-sonnet-4-20250514[1m]', 'Sonnet 4'],
  ['anthropic.claude-sonnet-4-20250514-v1:0', 'Sonnet 4'],
  ['opus', 'Opus'],
  ['SONNET[1m]', 'Sonnet'],
  ['sonnet', 'Sonnet'],
  ['opus[1m]', 'Opus'],
  ['default', 'default'],
  ['custom-model[beta]', 'custom-model'],
  ['custom-model-20250514', 'custom-model'],
  ['claude-opus-5-512', 'claude-opus-5-512'],
] as const) {
  test(`names the model ${JSON.stringify(id)} as ${JSON.stringify(name)}`, () => {
    expect(modelName(id)).toBe(name)
  })
}

test('leaves out the band segment of whatever is missing on the desktop', async ($, on) => {
  const h = await startMeter($, on)
  const bare = (await bandOf($, 'desktop')).row
  expect(bare).toContain('Context')
  expect(bare).not.toContain('Cache')
  expect(bare).not.toContain('5h')
  expect(bare).not.toContain('Week')
  expect(bare).not.toContain('$')
  h.measure.rateLimits = [{ kind: 'five_hour', percentUsed: 24, resetsAt: new Date(NOW + 3_600_000).toISOString() }]
  h.measure.cost = { usd: 2 }
  await $.session.measure({ ...h.measure, changed: ['rateLimits', 'cost'] } as never)
  h.usage = USAGE
  await runStep($)
  const full = (await bandOf($, 'desktop')).row
  expect(full).toContain('Cache')
  expect(full).toContain('5h')
  expect(full).toContain('$2.00')
})

test('says the window size of a context with no fill yet on the desktop', async ($, on) => {
  await startMeter($, on, { isFresh: true })
  expect((await bandOf($, 'desktop')).row).toContain('Context 200k window')
})

for (const surface of ['terminal', 'desktop'] as const) {
  for (const view of [{}, { agentId: 'a1' }]) {
    test(`${surface}: yields to a survey in ${view.agentId ? 'a subagent' : 'the main'} view`, async ($, on) => {
      await startMeter($, on)
      expect(flatten(await (await $.ui.mount(mountProps(surface, 140, true, view))).drawn())).toBe('engine draw')
    })
  }
}

test('leaves the terminal AbovePrompt to the engine in the main view', async ($, on) => {
  const h = await startMeter($, on)
  h.usage = USAGE
  await runStep($)
  expect(flatten(await (await $.ui.mount(mountProps('terminal', 140, false, {}))).drawn())).toBe('engine draw')
})

test('draws the band on desktop in the main view', async ($, on) => {
  await startMeter($, on)
  expect(flatten(await (await $.ui.mount(mountProps('desktop', 140, false, {}))).drawn())).toContain('Context')
})

const REVIEWER = { id: 'a1', type: 'code-reviewer', description: 'Review the auth flow end to end', status: 'running' }

const inSubagent = async ($: any, on: any) => {
  const h = await startMeter($, on)
  h.agents = [REVIEWER]
  h.usage = { ...USAGE, model: 'claude-sonnet-5-5' }
  await runStep($, { agentId: 'a1', model: 'claude-sonnet-5-5' })
  await callTool($, { agentId: 'a1', tool: 'Read' })
  await callTool($, { agentId: 'a1', tool: 'Bash' })
  await h.clock.settle()
  await h.clock.advance(3 * 60_000)
  return h
}

const agentTree = async ($: any, surface: Surface, bodyColumns = 140, agentId = 'a1') =>
  (await $.ui.mount(mountProps(surface, bodyColumns, false, { agentId }))).drawn()

const agentBox = (tree: unknown) => findNode(tree, n => n.type === 'Box' && n.props?.key === 'meter-agent')

const textRun = (tree: unknown, text: string) =>
  findNode(tree, n => n.type === 'Text' && n.children?.length === 1 && n.children[0] === text)?.props

const WIDE_AGENT_LINE = 'code-reviewer Review the auth flow end to end   ● running   Sonnet 5.5 high   Ctx 90k   2 tools · Bash   3m'

for (const [bodyColumns, expected] of [
  [109, WIDE_AGENT_LINE],
  [104, 'code-reviewer Review the auth flow end to end  ● running  Sonnet 5.5 high  Ctx 90k  2 tools · Bash  3m'],
  [93, 'code-reviewer Review the auth flo…  ● running  Sonnet 5.5 high  Ctx 90k  2 tools · Bash  3m'],
  [86, 'code-reviewer Review the auth flo…  ● running  Sonnet 5.5 high  Ctx 90k  2 tools  3m'],
  [65, 'code-reviewer  ● running  Sonnet 5.5 high  Ctx 90k  2 tools  3m'],
  [60, 'code-reviewer  ● running  Sonnet 5.5  Ctx 90k  2 tools  3m'],
  [56, 'code-reviewer  ● running  Sonnet 5.5  Ctx 90k  2 tools'],
  [48, 'code-reviewer  ●  Sonnet 5.5  Ctx 90k  2 tools'],
  [39, 'code-reviewer  ●  Sonnet 5.5  Ctx 90k'],
  [20, 'code-reviewer  ●  Sonnet 5.5  Ctx 90k'],
] as const) {
  test(`draws the subagent line on the terminal at ${bodyColumns} body columns`, async ($, on) => {
    await inSubagent($, on)
    const tree = await agentTree($, 'terminal', bodyColumns)
    expect(flatten(tree)).toBe(expected)
    expect(agentBox(tree)?.props).toMatchObject({ marginTop: 1, paddingLeft: 2 })
    if (bodyColumns === 20) expect(agentBox(tree)?.props?.flexWrap).toBe('nowrap')
  })
}

for (const bodyColumns of [140, 60]) {
  test(`draws the whole subagent line on desktop at ${bodyColumns} body columns and lets it wrap`, async ($, on) => {
    await inSubagent($, on)
    const tree = await agentTree($, 'desktop', bodyColumns)
    expect(flatten(tree)).toBe(WIDE_AGENT_LINE)
    expect(agentBox(tree)?.props?.flexWrap).toBe('wrap')
    expect(agentBox(tree)?.props?.marginTop).toBeUndefined()
    expect(agentBox(tree)?.props?.paddingLeft).toBeUndefined()
    expect(findNode(tree, n => n.type === 'Svg')).toBeUndefined()
    expect(findNode(tree, n => n.type === 'Box' && n.props?.display === 'none')).toBeUndefined()
  })
}

test('draws the band again on desktop once the main conversation is back in view', async ($, on) => {
  await inSubagent($, on)
  expect(flatten(await agentTree($, 'desktop'))).toContain('code-reviewer')
  const text = flatten(await (await $.ui.mount(mountProps('desktop', 140, false, {}))).drawn())
  expect(text).toContain('Context')
  expect(text).not.toContain('code-reviewer')
})

test('leaves the terminal band to the engine once the main conversation is back in view', async ($, on) => {
  await inSubagent($, on)
  expect(flatten(await agentTree($, 'terminal'))).toContain('code-reviewer')
  expect(flatten(await (await $.ui.mount(mountProps('terminal', 140, false, {}))).drawn())).toBe('engine draw')
})

test('reads the agent list while drawing, so a killed agent shows as killed', async ($, on) => {
  const h = await inSubagent($, on)
  await callTool($, { agentId: 'a1', tool: 'Read' })
  h.agents = [{ ...REVIEWER, status: 'killed' }]
  const tree = await agentTree($, 'terminal')
  expect(flatten(tree)).toContain('● killed')
  expect(flatten(tree)).toContain('3m')
  expect(textRun(tree, '●')?.color).toBe('warning')
  await h.clock.advance(10 * 60_000)
  expect(flatten(await agentTree($, 'terminal'))).toContain('3m')
  expect(flatten(await agentTree($, 'terminal'))).not.toContain('13m')
})

for (const [status, dot, word] of [
  ['running', { color: 'success' }, {}],
  ['waiting', { color: 'warning' }, {}],
  ['pending', { dimColor: true }, { dimColor: true }],
  ['idle', { dimColor: true }, { dimColor: true }],
  ['completed', { dimColor: true }, { dimColor: true }],
  ['failed', { color: 'error' }, { color: 'error' }],
  ['killed', { color: 'warning' }, { dimColor: true }],
  ['something-else', { dimColor: true }, { dimColor: true }],
] as const) {
  test(`shows the ${status} status with its colour`, async ($, on) => {
    const h = await inSubagent($, on)
    h.agents = [{ ...REVIEWER, status }]
    const tree = await agentTree($, 'desktop')
    const dotProps = textRun(tree, '●')
    const wordProps = textRun(tree, ` ${status}`)
    expect(dotProps?.color).toBe((dot as { color?: string }).color)
    expect(dotProps?.dimColor).toBe((dot as { dimColor?: boolean }).dimColor)
    expect(wordProps?.color).toBe((word as { color?: string }).color)
    expect(wordProps?.dimColor).toBe((word as { dimColor?: boolean }).dimColor)
  })
}

test('keeps naming an agent the engine has dropped from its list and shows it completed', async ($, on) => {
  const h = await inSubagent($, on)
  h.agents = []
  const text = flatten(await agentTree($, 'terminal'))
  expect(text.startsWith('code-reviewer Review the auth flow end to end')).toBe(true)
  expect(text).toContain('● completed')
  expect(text).not.toContain('running')
  await h.clock.advance(10 * 60_000)
  expect(flatten(await agentTree($, 'terminal'))).toContain('<1m')
})

test('falls back to the stored list when the live list fails', async ($, on) => {
  const h = await inSubagent($, on)
  h.agentListFails = true
  h.agents = [{ ...REVIEWER, status: 'failed' }]
  const text = flatten(await agentTree($, 'terminal'))
  expect(text).toContain('● running')
  expect(text).not.toContain('failed')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`names an agent nobody listed by a short id on the ${surface}`, async ($, on) => {
    await startMeter($, on)
    expect(flatten(await agentTree($, surface, 140, 'abcdef1234567890abcdef'))).toBe('Agent abcdef12…abcdef')
  })
}

test('shows the name and status before the first answer', async ($, on) => {
  const h = await startMeter($, on)
  h.agents = [REVIEWER]
  await callTool($, { tool: 'Agent' })
  await h.clock.settle()
  expect(flatten(await agentTree($, 'desktop'))).toBe('code-reviewer Review the auth flow end to end   ● running')
})

test("counts a subagent's tool calls, the one that throws too, and remembers the last", async ($, on) => {
  const h = await startMeter($, on)
  await callTool($, { agentId: 'a1', tool: 'Read' })
  h.toolMode = 'throw'
  await expect(callTool($, { agentId: 'a1', tool: 'Grep' })).rejects.toThrow()
  expect(h.state.subagents.activity.a1).toMatchObject({ tools: 2, lastTool: 'Grep' })
  h.toolMode = 'ok'
  await callTool($)
  expect(Object.keys(h.state.subagents.activity)).toEqual(['a1'])
})

test('records a subagent step: context, output, model and effort, and leaves the main model and cache alone', async ($, on) => {
  const h = await startMeter($, on)
  h.usage = USAGE
  await runStep($)
  const cacheBefore = h.state.cache
  h.usage = { ...USAGE, output_tokens: 7, model: 'claude-sonnet-5-5' }
  await runStep($, { agentId: 'a1', model: 'claude-sonnet-5-5' })
  expect(h.state.subagents.activity.a1).toMatchObject({
    context: 90_140,
    output: 7,
    requests: 1,
    firstAt: NOW,
    lastAt: NOW,
    model: { answered: 'claude-sonnet-5-5', requested: 'claude-sonnet-5-5', effort: 'high' },
  })
  expect(h.state.model.answered).toBe('claude-opus-5-5')
  expect(h.state.cache).toEqual(cacheBefore)
})

test('a subagent tool call in flight across /clear writes nothing', async ($, on) => {
  const h = await startMeter($, on)
  let release = () => {}
  h.toolGate = new Promise<void>(resolve => (release = resolve))
  const call = callTool($, { agentId: 'a1' })
  await h.clock.settle()
  await clearSession($)
  release()
  await call
  await h.clock.settle()
  expect(h.state.subagents).toEqual({ activity: {}, list: [] })
})

test('a subagent step in flight across /clear writes nothing', async ($, on) => {
  const h = await startMeter($, on)
  h.usage = USAGE
  let release = () => {}
  h.stepGate = new Promise<void>(resolve => (release = resolve))
  const step = runStep($, { agentId: 'a1' })
  await h.clock.settle()
  await clearSession($)
  release()
  await step
  await h.clock.settle()
  expect(h.state.subagents).toEqual({ activity: {}, list: [] })
  expect(h.agentLists).toBe(0)
})

test('a main step in flight across /clear writes nothing', async ($, on) => {
  const h = await startMeter($, on)
  h.usage = USAGE
  let release = () => {}
  h.stepGate = new Promise<void>(resolve => (release = resolve))
  const step = runStep($)
  await h.clock.settle()
  await clearSession($)
  h.sets = []
  release()
  await step
  await h.clock.settle()
  expect(h.sets).not.toContain('cache')
  expect(h.state.cache).toBeNull()
  expect(h.state.model.answered).toBeNull()
})

test('keeps one clock interval live across /clear and a second start', async ($, on) => {
  const h = await startMeter($, on)
  await clearSession($)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await h.clock.settle()
  h.sets = []
  await h.clock.advance(30_000)
  await h.clock.settle()
  expect(h.sets.filter(k => k === 'now')).toHaveLength(1)
})

test('/clear resets the measure, the cache and the subagents', async ($, on) => {
  const h = await startMeter($, on)
  h.usage = USAGE
  h.agents = [subagentRow('running')]
  await runStep($)
  await runStep($, { agentId: 'a1' })
  await h.clock.settle()
  expect(h.state.cache).not.toBeNull()
  expect(h.state.measure).not.toBeNull()
  expect(h.state.subagents.list).toHaveLength(1)
  await clearSession($)
  await h.clock.settle()
  expect(h.state.cache).toBeNull()
  expect(h.state.measure).toBeNull()
  expect(h.state.subagents).toEqual({ activity: {}, list: [] })
})

test('names the agent by its name when it has one', async ($, on) => {
  const h = await inSubagent($, on)
  h.agents = [{ ...REVIEWER, name: 'reviewer-2' }]
  expect(flatten(await agentTree($, 'terminal'))).toMatch(/^reviewer-2 Review the auth flow end to end/)
})

test('counts elapsed time while the agent runs', async ($, on) => {
  const h = await inSubagent($, on)
  await h.clock.advance(10 * 60_000)
  expect(flatten(await agentTree($, 'terminal'))).toContain('13m')
})

test('shows an agent that has been active for under a minute as <1m', async ($, on) => {
  const h = await startMeter($, on)
  h.agents = [REVIEWER]
  h.usage = { ...USAGE, model: 'claude-sonnet-5-5' }
  await runStep($, { agentId: 'a1', model: 'claude-sonnet-5-5' })
  await h.clock.settle()
  expect(flatten(await agentTree($, 'terminal'))).toContain('<1m')
})

test('draws a fallback model in the warning colour', async ($, on) => {
  const h = await startMeter($, on)
  h.agents = [REVIEWER]
  h.usage = { ...USAGE, model: 'claude-sonnet-5-5' }
  await runStep($, { agentId: 'a1', model: 'claude-opus-5-5' })
  await h.clock.settle()
  const tree = await agentTree($, 'desktop')
  expect(flatten(tree)).toContain('Sonnet 5.5 fallback from Opus 5.5')
  expect(textRun(tree, 'Sonnet 5.5')?.color).toBe('warning')
  expect(textRun(tree, 'Sonnet 5.5')?.bold).toBeUndefined()
})

test('strips control characters from the agent strings', async ($, on) => {
  const h = await startMeter($, on)
  h.agents = [{ ...REVIEWER, description: 'Review\u0007 auth' }]
  await callTool($, { agentId: 'a1', tool: 'Ba\u0007sh' })
  await callTool($, { tool: 'Agent' })
  await h.clock.settle()
  const hasControl = /[\u0000-\u001f\u007f-\u009f]/
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
  walk(await agentTree($, 'terminal'))
  expect(strings.length).toBeGreaterThan(5)
  expect(strings.filter(v => hasControl.test(v))).toEqual([])
  const text = strings.join(' ')
  expect(text).toContain('Review  auth')
  expect(text).toContain('Ba sh')
})
