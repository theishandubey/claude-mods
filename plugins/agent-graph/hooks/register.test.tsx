import { expect, mock, test } from 'claude-code/testing'

import { fitMetrics } from './draw-svg'
import { capAgents, RECENT_MS } from './layout'
import { priceFor, requestCost, windowFor } from './pricing'

const NOW = Date.parse('2026-10-04T12:00:00Z')

const AGENTS = [
  { id: 'a1', type: 'explorer', description: 'Map the auth module', status: 'running' },
  { id: 'a2', type: 'architect', description: 'Plan the session store refactor', status: 'running' },
  { id: 'a3', type: 'web-researcher', description: 'Look up OAuth PKCE docs', status: 'completed', parentId: 'a2' },
  { id: 'a4', type: 'explorer', description: 'Find every caller of getSession', status: 'running', parentId: 'a2' },
  { id: 'a5', type: 'code-reviewer', description: 'Old review from an hour ago', status: 'completed' },
]

type Node = { type: string; props?: Record<string, unknown>; children?: unknown[] }

const textOf = (node: unknown): string => {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  const el = node as Node
  if (el.type === 'Svg') return `[svg]${String(el.props?.source)}[/svg]`
  const inner = (el.children ?? []).map(textOf).join(el.props?.flexDirection === 'column' ? '\n' : '')
  return inner
}

type Row = { id: string; type: string; description: string; status: string; parentId?: string }
type Body = Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>
type Ctx = Parameters<Body>

const opens = { count: 0, calls: [] as { id: string; title?: string }[] }
const probes = { agentList: 0, commands: 0, surfaces: 0, isPlaced: true, reason: '', registerFails: false, surfacesFail: false }

type StepUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  model: string
}

const DEFAULT_USAGE: StepUsage = { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm' }
const stepUsages = new Map<string, StepUsage[]>()

const queueUsage = (agentId: string, ...usages: StepUsage[]) => stepUsages.set(agentId, usages)

const usage = (model: string, input: number, output: number, cacheRead: number, cacheWrite: number): StepUsage => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
  model,
})

const step = async ($: Ctx[0], agentId: string | undefined, index = 0) => {
  for await (const _ of $.turn.step({ turnId: 't1', index, model: 'm', messageCount: 1, ...(agentId ? { agentId } : {}) } as never)) {
  }
}

const SPAWN = { tool: 'Agent', description: 'spawn', prompt: 'go', subagent_type: 'explorer' } as never

const boot = async (
  [$, on]: Ctx,
  get: () => Row[] | Promise<Row[]>,
  start: number,
  spawn: () => unknown = () => ({ result: 'ok' }),
  spawnAtStart = true,
  surfaces: string[] = ['desktop'],
  registerFails = false,
) => {
  opens.calls = []
  probes.agentList = 0
  probes.commands = 0
  probes.surfaces = 0
  probes.isPlaced = true
  probes.reason = ''
  probes.registerFails = registerFails
  probes.surfacesFail = false
  stepUsages.clear()
  const clock = mock.clock(on, { now: start })
  on('agent.list', async () => {
    probes.agentList += 1
    return { value: await get() } as never
  })
  on('session.start', (_, e) => e as never)
  on('session.surfaces', () => {
    probes.surfaces += 1
    if (probes.surfacesFail) throw new Error('surfaces refused')
    return { value: surfaces } as never
  })
  on('command.register', () => {
    probes.commands += 1
    if (probes.registerFails) throw new Error('register refused')
    return { value: undefined } as never
  })
  on('ui.open', (_, e) => {
    opens.count += 1
    opens.calls.push(e as never)
    return { value: probes.isPlaced ? { isPlaced: true } : { isPlaced: false, reason: probes.reason } } as never
  })
  on('tool.call', { tool: 'Agent' }, async () => (await spawn()) as never)
  on('tool.call', { tool: 'Read' }, () => ({ result: 'ok' }) as never)
  on('turn.start', (_, e) => e as never)
  on('turn.step', async function* (_, e) {
    const step = e as { turnId: string; index: number; agentId?: string }
    return {
      turnId: step.turnId,
      index: step.index,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn',
      usage: stepUsages.get(step.agentId ?? 'main')?.shift() ?? DEFAULT_USAGE,
    } as never
  })
  on('turn.complete', () => ({ text: '' }) as never)
  on('session.end', (_, e) => e as never)
  on('session.attach', (_, e) => ({ clientId: (e as { clientId: string }).clientId }) as never)
  on('ui.render', () => ({ type: 'engine', ref: 7 }) as never)
  await $.session.start({ source: 'startup', cwd: '/tmp', surface: surfaces[0] ?? null, isInteractive: true } as never)
  if (spawnAtStart) await $.tool.call(SPAWN)
  return clock
}

const mountPane = async ($: Ctx[0], surface: 'terminal' | 'desktop' = 'desktop', columns = 140) => {
  return $.ui.mount({ plugin: 'agent-graph', surface, component: 'Pane', props: props(columns), requestId: 'agent-graph' } as never)
}

const TURN_DONE = (agentId: string) =>
  ({ answer: '', durationMs: 1, isAborted: false, turnId: `t-${agentId}`, agentId, reason: 'answer' }) as never

const props = (bodyColumns: number) =>
  ({ title: 'Agents', isFocused: false, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }) as never

test('draws the agent tree on desktop', async (...ctx) => {
  const [$] = ctx
  let list: Row[] = AGENTS.map(a => ({ ...a, status: a.id === 'a5' ? 'running' : a.status === 'completed' ? 'running' : a.status }))
  const clock = await boot(ctx, () => list, NOW - 90_000)
  await clock.advance(1000)
  list = AGENTS.map(a => (a.id === 'a3' ? { ...a, status: 'running' } : a))
  await clock.advance(1000)
  await clock.advance(RECENT_MS * 1.5 - 2000)
  list = AGENTS
  await clock.advance(1000)
  const text = textOf(await (await mountPane($)).drawn())
  expect(text).toContain('3 running')
  expect(text).toContain('explorer')
  expect(text).toContain('web-researcher')
  expect(text).not.toContain('code-reviewer')
})

test('follows the app light and dark mode rather than the cli theme', async (...ctx) => {
  const [$] = ctx
  await boot(ctx, () => [{ id: 'a1', type: 'explorer', description: 'Map the auth module', status: 'running' }], NOW)
  const text = textOf(await (await mountPane($)).drawn())
  expect(text).toContain('.card{fill:#faf9f7')
  expect(text).toContain('@media (prefers-color-scheme: dark){')
  expect(text).toContain('.card{fill:#242423')
  expect(text.indexOf('.card{fill:#faf9f7')).toBeLessThan(text.indexOf('@media (prefers-color-scheme: dark)'))
  expect(text.indexOf('@media (prefers-color-scheme: dark)')).toBeLessThan(text.indexOf('.card{fill:#242423'))
})

test('clears finished agents once the recent window passes with nothing else happening', async (...ctx) => {
  const [$] = ctx
  let list: Row[] = [{ id: 'a1', type: 'explorer', description: 'Map the auth module', status: 'running' }]
  const clock = await boot(ctx, () => list, NOW)
  const ui = await mountPane($)
  expect(textOf(await ui.drawn())).toContain('1 running')
  list = [{ id: 'a1', type: 'explorer', description: 'Map the auth module', status: 'completed' }]
  await clock.advance(1000)
  expect(textOf(await ui.drawn())).toContain('explorer')
  await clock.advance(RECENT_MS + 2000)
  const text = textOf(await ui.drawn())
  expect(text).not.toContain('explorer')
  expect(text).toContain('No subagents running')
})

test('shows a resumed agent again for the recent window after it finishes a second time', async (...ctx) => {
  const [$] = ctx
  const row = (status: string): Row[] => [{ id: 'a1', type: 'explorer', description: 'Map the auth module', status }]
  let list = row('running')
  const clock = await boot(ctx, () => list, NOW)
  const ui = await mountPane($)
  list = row('completed')
  await clock.advance(1000)
  await clock.advance(RECENT_MS - 2000)
  list = row('running')
  await clock.advance(1000)
  expect(textOf(await ui.drawn())).toContain('1 running')
  list = row('completed')
  await clock.advance(1000)
  await clock.advance(RECENT_MS / 2)
  const text = textOf(await ui.drawn())
  expect(text).toContain('explorer')
  expect(text).toContain('0 running')
  expect(text).toContain('1 finished this session')
  expect(text).toContain('<g class="done">')
  expect(text).toContain('>1s</text>')
})

test('hides agents first seen already finished and leaves them out of the finished count', async (...ctx) => {
  const [$] = ctx
  const list: Row[] = [
    { id: 'a1', type: 'explorer', description: 'Map the auth module', status: 'running' },
    { id: 'a5', type: 'code-reviewer', description: 'Old review from an hour ago', status: 'completed' },
  ]
  await boot(ctx, () => list, NOW)
  const text = textOf(await (await mountPane($)).drawn())
  expect(text).toContain('1 running')
  expect(text).toContain('explorer')
  expect(text).not.toContain('code-reviewer')
  expect(text).not.toContain('finished this session')
})

test('stops polling once nothing is running and the recent window has passed', async (...ctx) => {
  let list: Row[] = [{ id: 'a1', type: 'explorer', description: 'Map the auth module', status: 'running' }]
  let calls = 0
  const clock = await boot(ctx, () => (calls += 1, list), NOW)
  await clock.advance(1000)
  list = [{ id: 'a1', type: 'explorer', description: 'Map the auth module', status: 'completed' }]
  await clock.advance(1000)
  await clock.advance(RECENT_MS + 2000)
  const settled = calls
  await clock.advance(10_000)
  expect(calls).toBe(settled)
})

test('keeps polling while a spawn is in flight and the agent is not listed yet', async (...ctx) => {
  const [$] = ctx
  let release = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  let calls = 0
  const clock = await boot(ctx, () => (calls += 1, []), NOW, async () => {
    await gate
    return { result: 'ok' }
  }, false)
  const spawned = $.tool.call(SPAWN)
  await clock.advance(1000)
  const before = calls
  await clock.advance(3000)
  expect(calls).toBe(before + 3)
  release()
  await spawned
  await clock.settle()
  const after = calls
  await clock.advance(10_000)
  expect(calls).toBe(after)
})

test('a spawn whose surfaces lookup rejects leaves no spawn in flight and no timer polling', async (...ctx) => {
  const [$] = ctx
  let calls = 0
  const clock = await boot(ctx, () => (calls += 1, []), NOW, undefined, false)
  probes.surfacesFail = true
  await $.tool.call(SPAWN)
  probes.surfacesFail = false
  await $.turn.complete(TURN_DONE('zz'))
  await clock.settle()
  const settled = calls
  await clock.advance(10_000)
  expect(calls).toBe(settled)
})

test('serializes refreshes so a slow older list never overwrites a newer one', async (...ctx) => {
  const [$] = ctx
  const lists: Row[][] = [
    [{ id: 'a1', type: 'explorer', description: 'Map the auth module', status: 'running' }],
    [{ id: 'a1', type: 'explorer', description: 'Map the auth module', status: 'completed' }],
  ]
  const gates: (() => void)[] = []
  let active = 0
  let maxActive = 0
  let calls = 0
  const clock = await boot(
    ctx,
    async () => {
      const mine = lists[calls] ?? []
      calls += 1
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise<void>(resolve => gates.push(resolve))
      active -= 1
      return mine
    },
    NOW,
    undefined,
    false,
  )
  const first = $.turn.complete(TURN_DONE('a1'))
  const second = $.turn.complete(TURN_DONE('a1'))
  await clock.settle()
  expect(gates.length).toBe(1)
  gates[0]?.()
  await clock.settle()
  expect(gates.length).toBe(2)
  gates[1]?.()
  await Promise.all([first, second])
  expect(maxActive).toBe(1)
  const text = textOf(await (await mountPane($)).drawn())
  expect(text).toContain('0 running')
  expect(text).toContain('1 finished this session')
})

test('does not queue timer refreshes behind a slow one', async (...ctx) => {
  let slow = false
  let calls = 0
  const gates: (() => void)[] = []
  const clock = await boot(
    ctx,
    async () => {
      calls += 1
      if (slow) await new Promise<void>(resolve => gates.push(resolve))
      return [{ id: 'a1', type: 'explorer', description: 'Map the auth module', status: 'running' }]
    },
    NOW,
  )
  slow = true
  const before = calls
  await clock.advance(5000)
  for (const release of gates) release()
  await clock.settle()
  expect(calls).toBe(before + 1)
})

test('strips C1 controls and bidi overrides from descriptions', async (...ctx) => {
  const [$] = ctx
  const list: Row[] = [{ id: 'a1', type: 'explorer', description: 'ev\u202eil\u0085\u2067ok', status: 'running' }]
  await boot(ctx, () => list, NOW)
  const text = textOf(await (await mountPane($)).drawn())
  expect(text).toContain('evilok')
  expect(text).not.toMatch(/[\u0085\u202e\u2067]/u)
})

test('keeps what a subagent did before it was listed and drops it when it never is', async (...ctx) => {
  const [$] = ctx
  let list: Row[] = []
  const clock = await boot(ctx, () => list, NOW, undefined, false)
  await $.tool.call({ tool: 'Read', file_path: '/x/foo.ts', agentId: 'a1' } as never)
  await clock.advance(3000)
  list = [{ id: 'a1', type: 'explorer', description: 'Map the auth module', status: 'running' }]
  await $.turn.complete(TURN_DONE('zz'))
  await clock.advance(1000)
  const ui = await mountPane($)
  const seen = textOf(await ui.drawn())
  expect(seen).toContain('Read foo.ts')
  expect(seen).toContain('>4s</text>')

  list = []
  await $.tool.call({ tool: 'Read', file_path: '/x/bar.ts', agentId: 'a2' } as never)
  await clock.advance(6000)
  await $.turn.complete(TURN_DONE('zz'))
  list = [{ id: 'a2', type: 'explorer', description: 'Second agent', status: 'running' }]
  await $.turn.complete(TURN_DONE('zz'))
  const text = textOf(await ui.drawn())
  expect(text).toContain('Second agent')
  expect(text).not.toContain('Read bar.ts')
})

test('opens the pane again for a new conversation after clear', async (...ctx) => {
  const [$] = ctx
  await boot(ctx, () => [], NOW)
  const first = opens.count
  await $.tool.call(SPAWN)
  expect(opens.count).toBe(first)
  await $.session.end({ reason: 'clear', sessionId: 's1' } as never)
  await $.tool.call(SPAWN)
  expect(opens.count).toBe(first + 1)
})

const MIXED: Row[] = [
  { id: 'a1', type: 'code-reviewer', description: 'Review the diff', status: 'running' },
  { id: 'a2', type: 'fixer', name: 'fix-it', description: 'Apply the fixes', status: 'completed' } as Row,
  { id: 'a3', type: 'x', description: 'Broken', status: 'failed' },
  { id: 'a4', type: 'y', description: 'Stopped by the user', status: 'killed' },
]

const MIXED_LIVE = (): Row[] => MIXED.map(a => ({ ...a, status: 'running' }))

const bootMixed = async (ctx: Ctx, surfaces?: string[]) => {
  let list = MIXED_LIVE()
  const clock = await boot(ctx, () => list, NOW, undefined, false, surfaces)
  await ctx[0].turn.complete(TURN_DONE('a1'))
  list = MIXED
  await clock.advance(1000)
  return clock
}

test('draws a killed agent as idle and only a failed one as failed', async (...ctx) => {
  const [$] = ctx
  await bootMixed(ctx)
  const text = textOf(await (await mountPane($)).drawn())
  expect(text).toContain('<g class="idle">')
  expect(text).toContain('<g class="failed">')
  expect(text.match(/<g class="failed">/g)).toHaveLength(1)
  expect(text.match(/<g class="idle">/g)).toHaveLength(2)
})

test('the pane draws nothing of its own on the terminal', async (...ctx) => {
  const [$] = ctx
  await bootMixed(ctx, ['terminal', 'desktop'])
  const ui = await mountPane($, 'terminal')
  expect(await ui.drawn()).toMatchObject({ type: 'engine', ref: 7 })
})

test('opens no pane, registers no command and polls nothing when the session never draws on desktop', async (...ctx) => {
  const [$] = ctx
  const clock = await boot(ctx, () => [{ id: 'a1', type: 'explorer', description: 'Map', status: 'running' }], NOW, undefined, true, ['terminal'])
  await $.turn.complete(TURN_DONE('a1'))
  await clock.advance(5000)
  expect(opens.calls).toEqual([])
  expect(probes.commands).toBe(0)
  expect(probes.agentList).toBe(0)
})

test('registers the command when a desktop attaches to a terminal-only session, once', async (...ctx) => {
  const [$] = ctx
  const surfaces = ['terminal']
  await boot(ctx, () => [], NOW, undefined, false, surfaces)
  expect(probes.commands).toBe(0)
  surfaces.push('desktop')
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' } as never)
  expect(probes.commands).toBe(1)
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:other' } as never)
  expect(probes.commands).toBe(1)
})

test('registers the command once when a desktop session starts and then attaches', async (...ctx) => {
  const [$] = ctx
  await boot(ctx, () => [], NOW, undefined, false)
  expect(probes.commands).toBe(1)
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' } as never)
  expect(probes.commands).toBe(1)
})

test('the command opens no pane while the session has no desktop', async (...ctx) => {
  const [$] = ctx
  await boot(ctx, () => [], NOW, undefined, false, ['terminal'])
  const reply = await $.command.run({ command: 'agent-graph' } as never)
  expect(opens.calls).toEqual([])
  expect(reply).toMatchObject({ text: 'The Agents graph draws only in the desktop app.' })
})

test('the command says the graph opened when a desktop draws it', async (...ctx) => {
  const [$] = ctx
  await boot(ctx, () => [], NOW, undefined, false)
  const reply = await $.command.run({ command: 'agent-graph' } as never)
  expect(opens.calls).toMatchObject([{ id: 'agent-graph' }])
  expect(reply).toMatchObject({ text: 'Agents graph opened.' })
})

test('the command says why the pane is not placed', async (...ctx) => {
  const [$] = ctx
  await boot(ctx, () => [], NOW, undefined, false)
  probes.isPlaced = false
  probes.reason = 'widen the terminal\u202e to 144 columns'
  const reply = await $.command.run({ command: 'agent-graph' } as never)
  expect(reply).toMatchObject({ text: 'The Agents graph could not be opened: widen the terminal to 144 columns' })
})

test('the command does not claim the graph opened when the pane is not placed and gives no reason', async (...ctx) => {
  const [$] = ctx
  await boot(ctx, () => [], NOW, undefined, false)
  probes.isPlaced = false
  const reply = await $.command.run({ command: 'agent-graph' } as never)
  expect(reply).toMatchObject({ text: 'The Agents graph could not be opened' })
})

test('keeps no activity bookkeeping while the session has no desktop', async (...ctx) => {
  const [$] = ctx
  const surfaces = ['terminal']
  const clock = await boot(ctx, () => [{ id: 'a1', type: 'explorer', description: 'Map', status: 'running' }], NOW, undefined, false, surfaces)
  await $.tool.call({ tool: 'Read', file_path: '/x/foo.ts', agentId: 'a1' } as never)
  await $.tool.call({ tool: 'Read', file_path: '/x/bar.ts' } as never)
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1, agentId: 'a1' } as never)) {
  }
  surfaces.push('desktop')
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' } as never)
  await $.turn.complete(TURN_DONE('a1'))
  await clock.advance(1000)
  const text = textOf(await (await mountPane($)).drawn())
  expect(text).toContain('1 running')
  expect(text).not.toContain('Read foo.ts')
  expect(text).not.toContain('Read bar.ts')
  expect(text).not.toContain('steps')
})

test('asks the session for its surfaces once, not on every tool call or step, when it has no desktop', async (...ctx) => {
  const [$] = ctx
  await boot(ctx, () => [], NOW, undefined, false, ['terminal'])
  const settled = probes.surfaces
  for (let i = 0; i < 5; i += 1) {
    await $.tool.call({ tool: 'Read', file_path: `/x/${i}.ts` } as never)
    for await (const _ of $.turn.step({ turnId: 't1', index: i, model: 'm', messageCount: 1 } as never)) {
    }
  }
  expect(probes.surfaces).toBe(settled)
})

test('asks again after a clear in case a desktop is now attached', async (...ctx) => {
  const [$] = ctx
  const surfaces = ['terminal']
  await boot(ctx, () => [{ id: 'a1', type: 'explorer', description: 'Map', status: 'running' }], NOW, undefined, false, surfaces)
  await $.session.end({ reason: 'clear', sessionId: 's1' } as never)
  surfaces.push('desktop')
  await $.tool.call({ tool: 'Read', file_path: '/x/foo.ts', agentId: 'a1' } as never)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  expect(probes.commands).toBe(1)
  await $.turn.complete(TURN_DONE('a1'))
  const text = textOf(await (await mountPane($)).drawn())
  expect(text).toContain('Read foo.ts')
})

test('finishes session start when the command cannot be registered', async (...ctx) => {
  const [$] = ctx
  await boot(ctx, () => [], NOW, undefined, false, ['desktop'], true)
  expect(probes.commands).toBe(1)
  await $.tool.call({ tool: 'Read', file_path: '/x/foo.ts' } as never)
  const reply = await $.command.run({ command: 'agent-graph' } as never)
  expect(reply).toMatchObject({ text: 'Agents graph opened.' })
})

test('registers the command again on the first turn after a clear', async (...ctx) => {
  const [$] = ctx
  await boot(ctx, () => [], NOW, undefined, false)
  expect(probes.commands).toBe(1)
  await $.session.end({ reason: 'clear', sessionId: 's1' } as never)
  expect(probes.commands).toBe(1)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  expect(probes.commands).toBe(2)
  await $.turn.start({ text: 'again', turnId: 't2' })
  expect(probes.commands).toBe(2)
})

test('registers the command again on the first turn after a resume', async (...ctx) => {
  const [$] = ctx
  await boot(ctx, () => [], NOW, undefined, false)
  await $.session.end({ reason: 'resume', sessionId: 's1' } as never)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  expect(probes.commands).toBe(2)
})

test('registers no command after a clear when the session has no desktop', async (...ctx) => {
  const [$] = ctx
  await boot(ctx, () => [], NOW, undefined, false, ['terminal'])
  await $.session.end({ reason: 'clear', sessionId: 's1' } as never)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  expect(probes.commands).toBe(0)
})

test('auto-opens the graph on the first spawn once a desktop has attached', async (...ctx) => {
  const [$] = ctx
  const surfaces = ['terminal']
  await boot(ctx, () => [], NOW, undefined, false, surfaces)
  await $.tool.call(SPAWN)
  expect(opens.calls).toEqual([])
  surfaces.push('desktop')
  await $.tool.call(SPAWN)
  expect(opens.calls).toMatchObject([{ id: 'agent-graph' }])
})

test('priceFor and windowFor know the exact ids', () => {
  expect(priceFor('claude-opus-5-5')).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 8 })
  expect(priceFor('claude-sonnet-5')).toEqual({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 4 })
  expect(priceFor('claude-fable-5')).toEqual({ input: 10, output: 50, cacheRead: 1, cacheWrite: 20 })
  expect(priceFor('claude-fable-5-1')).toEqual({ input: 10, output: 50, cacheRead: 0.25, cacheWrite: 20 })
  expect(priceFor('claude-mythos-5-1')).toEqual(priceFor('claude-fable-5-1'))
  expect(priceFor('claude-haiku-4-5')).toEqual({ input: 1, output: 5, cacheRead: 0.1, cacheWrite: 2 })
  expect(windowFor('claude-opus-5-5')).toBe(1_000_000)
  expect(windowFor('claude-haiku-4-5')).toBe(200_000)
})

test('priceFor and windowFor take the longest matching id', () => {
  expect(priceFor('claude-opus-5-5')?.input).toBe(4)
  expect(priceFor('claude-opus-5')?.input).toBe(5)
  expect(priceFor('claude-opus-5-20260101')?.input).toBe(5)
})

test('priceFor and windowFor ignore a bracketed suffix and a trailing date', () => {
  expect(priceFor('claude-opus-5-5[1m]')).toEqual(priceFor('claude-opus-5-5'))
  expect(priceFor('claude-haiku-4-5-20260101')).toEqual(priceFor('claude-haiku-4-5'))
  expect(priceFor('claude-sonnet-5-5-20260301[1m]')).toEqual(priceFor('claude-sonnet-5-5'))
  expect(priceFor('claude-opus-5-5@20260101')).toEqual(priceFor('claude-opus-5-5'))
  expect(windowFor('claude-opus-5-5-20260101')).toBe(1_000_000)
  expect(windowFor('claude-haiku-4-5[1m]')).toBe(1_000_000)
  expect(windowFor('claude-haiku-4-5-20260101')).toBe(200_000)
})

test('priceFor and windowFor give nothing for an unknown model', () => {
  expect(priceFor('gpt-9')).toBeUndefined()
  expect(priceFor('m')).toBeUndefined()
  expect(windowFor('gpt-9')).toBeUndefined()
  for (const model of ['claude-sonnet-5-6', 'claude-opus-5-6', 'claude-opus-5-5x', 'claude-opus-5-5-2026', 'claude-fable-5-2', 'claude-opus-5-5 ']) {
    expect(priceFor(model)).toBeUndefined()
    expect(windowFor(model)).toBeUndefined()
  }
  expect(requestCost(usage('claude-sonnet-5-6', 1000, 1000, 1000, 1000))).toBeUndefined()
  expect(requestCost(usage('gpt-9', 1000, 1000, 1000, 1000))).toBeUndefined()
})

test('requestCost prices Fable 5 cache reads at one dollar a million, apart from Fable 5.1', () => {
  expect(requestCost(usage('claude-fable-5', 0, 0, 1_000_000, 0))).toBe(1)
  expect(requestCost(usage('claude-fable-5-1', 0, 0, 1_000_000, 0))).toBe(0.25)
})

test('requestCost sums the four token kinds at the model prices', () => {
  const cost = requestCost(usage('claude-opus-5-5', 100_000, 20_000, 500_000, 50_000))
  expect(Math.abs((cost ?? 0) - 1.3)).toBeLessThan(1e-9)
})

const GRAPH_AGENTS: Row[] = [
  { id: 'a1', type: 'explorer', description: 'Map the auth module', status: 'running' },
  { id: 'a2', type: 'architect', description: 'Plan the refactor', status: 'running' },
  { id: 'a3', type: 'fixer', description: 'Apply the fixes', status: 'running' },
]

const bootGraph = async (ctx: Ctx, list: Row[] = GRAPH_AGENTS) => {
  const clock = await boot(ctx, () => list, NOW, undefined, false)
  await ctx[0].turn.complete(TURN_DONE('zz'))
  return clock
}

const cardsOf = (text: string) => text.split('<g class=').slice(1)

test('an agent card shows context, window fill, latest cache hit and summed cost', async (...ctx) => {
  const [$] = ctx
  await bootGraph(ctx)
  queueUsage(
    'a1',
    usage('claude-sonnet-5-5', 1000, 500, 0, 9000),
    usage('claude-sonnet-5-5', 10_000, 1000, 230_000, 10_000),
  )
  await step($, 'a1', 0)
  await step($, 'a1', 1)
  const text = textOf(await (await mountPane($)).drawn())
  const card = cardsOf(text).find(c => c.includes('explorer')) ?? ''
  expect(card).toContain('ctx 250k · 25%')
  expect(card).toContain('cache 92%')
  expect(card).toContain('~$0.16')
})

test('an agent card draws the context gauge at the window fill and none for an unknown model', async (...ctx) => {
  const [$] = ctx
  await bootGraph(ctx)
  queueUsage('a1', usage('claude-sonnet-5-5', 10_000, 1000, 230_000, 10_000))
  queueUsage('a2', usage('m', 5000, 100, 0, 0))
  await step($, 'a1')
  await step($, 'a2')
  const text = textOf(await (await mountPane($)).drawn())
  const known = cardsOf(text).find(c => c.includes('explorer')) ?? ''
  const unknown = cardsOf(text).find(c => c.includes('architect')) ?? ''
  expect(known).toContain('<rect class="track" x="')
  expect(known).toContain('<rect class="bar ok" x="')
  expect(known).toMatch(/class="bar ok"[^>]* width="60"/)
  expect(known).toMatch(/class="track"[^>]* width="240"/)
  expect(unknown).not.toContain('class="track"')
  expect(unknown).not.toContain('class="bar')
  expect(text.match(/class="track"/g)).toHaveLength(1)
})

test('the gauge and the context text turn amber from half the window and red from four fifths', async (...ctx) => {
  const [$] = ctx
  await bootGraph(ctx)
  queueUsage('a1', usage('claude-opus-5-5', 500_000, 10, 0, 0))
  queueUsage('a2', usage('claude-opus-5-5', 850_000, 10, 0, 0))
  queueUsage('a3', usage('claude-opus-5-5', 2_000_000, 10, 0, 0))
  await step($, 'a1')
  await step($, 'a2')
  await step($, 'a3')
  const text = textOf(await (await mountPane($)).drawn())
  const amber = cardsOf(text).find(c => c.includes('explorer')) ?? ''
  const red = cardsOf(text).find(c => c.includes('architect')) ?? ''
  const full = cardsOf(text).find(c => c.includes('fixer')) ?? ''
  expect(amber).toContain('class="bar warn"')
  expect(amber).toContain('class="ctx warn"')
  expect(red).toContain('class="bar hot"')
  expect(red).toContain('class="ctx hot"')
  expect(red).toMatch(/class="bar hot"[^>]* width="204"/)
  expect(full).toMatch(/class="bar hot"[^>]* width="240"/)
})

test('a card draws its gauge muted by class unless the agent is running', async (...ctx) => {
  const [$] = ctx
  const rows = (statuses: string[]): Row[] => statuses.map((status, i) => ({ id: `a${i + 1}`, type: `kind${i + 1}`, description: 'Work', status }))
  let list = rows(['running', 'running', 'running', 'running'])
  const clock = await boot(ctx, () => list, NOW, undefined, false)
  await $.turn.complete(TURN_DONE('zz'))
  for (const id of ['a1', 'a2', 'a3', 'a4']) queueUsage(id, usage('claude-sonnet-5-5', 10_000, 1000, 230_000, 10_000))
  for (const id of ['a1', 'a2', 'a3', 'a4']) await step($, id)
  list = rows(['running', 'completed', 'failed', 'killed'])
  await clock.advance(1000)
  const text = textOf(await (await mountPane($)).drawn())
  const muted = (/([^{}\n]*)\{fill-opacity:\.5\}/.exec(text)?.[1] ?? '').split(',').map(sel => sel.trim())
  for (const [kind, status] of [['kind1', 'running'], ['kind2', 'done'], ['kind3', 'failed'], ['kind4', 'idle']] as const) {
    const card = cardsOf(text).find(c => c.includes(kind)) ?? ''
    expect(card.startsWith(`"${status}">`)).toBe(true)
    expect(card).toContain('class="bar ok"')
    expect(muted.includes(`.${status} .bar`)).toBe(status !== 'running')
  }
})

test('an unknown-model request leaves the cost a lower bound', async (...ctx) => {
  const [$] = ctx
  await bootGraph(ctx)
  queueUsage('a2', usage('claude-sonnet-5-5', 1000, 500, 0, 9000), usage('m', 5000, 100, 0, 0))
  await step($, 'a2', 0)
  await step($, 'a2', 1)
  const text = textOf(await (await mountPane($)).drawn())
  const card = cardsOf(text).find(c => c.includes('architect')) ?? ''
  expect(card).toContain('ctx 5.0k')
  expect(card).not.toContain('ctx 5.0k ·')
  expect(card).toContain('~$0.04+')
})

test('a tiny cost reads as under a cent', async (...ctx) => {
  const [$] = ctx
  await bootGraph(ctx)
  queueUsage('a1', usage('claude-sonnet-5-5', 100, 10, 0, 0))
  await step($, 'a1')
  const text = textOf(await (await mountPane($)).drawn())
  expect(cardsOf(text).find(c => c.includes('explorer')) ?? '').toContain('&lt;$0.01')
})

test('an agent with no reply yet waits for its first one', async (...ctx) => {
  const [$] = ctx
  await bootGraph(ctx)
  queueUsage('a1', usage('claude-sonnet-5-5', 10_000, 1000, 230_000, 10_000))
  await step($, 'a1')
  const text = textOf(await (await mountPane($)).drawn())
  const idle = cardsOf(text).find(c => c.includes('architect')) ?? ''
  expect(idle).toContain('waiting for first reply')
  expect(idle).not.toContain('class="track"')
  expect(cardsOf(text).find(c => c.includes('explorer')) ?? '').not.toContain('waiting for first reply')
})

test('the main card shows its own metrics from the main loop', async (...ctx) => {
  const [$] = ctx
  await bootGraph(ctx)
  queueUsage('main', usage('claude-opus-5-5', 100_000, 20_000, 500_000, 50_000))
  await step($, undefined)
  const text = textOf(await (await mountPane($)).drawn())
  const main = cardsOf(text).find(c => c.includes('>Main<')) ?? ''
  expect(main).toContain('ctx 650k · 65%')
  expect(main).toContain('cache 77%')
  expect(main).toContain('~$1.30')
  expect(main).toContain('class="bar warn"')
  expect(cardsOf(text).find(c => c.includes('explorer')) ?? '').toContain('waiting for first reply')
})

test('keeps no usage bookkeeping while the session has no desktop', async (...ctx) => {
  const [$] = ctx
  const surfaces = ['terminal']
  await boot(ctx, () => [{ id: 'a1', type: 'explorer', description: 'Map', status: 'running' }], NOW, undefined, false, surfaces)
  queueUsage('a1', usage('claude-sonnet-5-5', 10_000, 1000, 230_000, 10_000))
  await step($, 'a1')
  surfaces.push('desktop')
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' } as never)
  await $.turn.complete(TURN_DONE('a1'))
  const text = textOf(await (await mountPane($)).drawn())
  expect(text).toContain('waiting for first reply')
  expect(text).not.toContain('250k')
})

test('token counts drop the decimal from 10k up and keep one below it', async (...ctx) => {
  const [$] = ctx
  await bootGraph(ctx)
  queueUsage('a1', usage('claude-opus-5-5', 4200, 12_300, 0, 0))
  queueUsage('a2', usage('claude-opus-5-5', 10_000, 1000, 390_000, 10_000))
  queueUsage('a3', usage('claude-opus-5-5', 999_600, 1, 0, 0))
  await step($, 'a1')
  await step($, 'a2')
  await step($, 'a3')
  const text = textOf(await (await mountPane($)).drawn())
  const small = cardsOf(text).find(c => c.includes('explorer')) ?? ''
  const mid = cardsOf(text).find(c => c.includes('architect')) ?? ''
  const big = cardsOf(text).find(c => c.includes('fixer')) ?? ''
  expect(small).toContain('ctx 4.2k')
  expect(small).toContain('12k tok')
  expect(mid).toContain('ctx 410k · 41%')
  expect(mid).toContain('1.0k tok')
  expect(big).toContain('ctx 1.0M · 100%')
  expect(text).not.toMatch(/\d{2,3}\.0k/)
})

test('token counts round before they pick the unit', async (...ctx) => {
  const [$] = ctx
  await bootGraph(ctx)
  queueUsage('a1', usage('claude-opus-5-5', 9949, 9950, 0, 0))
  queueUsage('a2', usage('claude-opus-5-5', 9950, 9949, 0, 0))
  await step($, 'a1')
  await step($, 'a2')
  const text = textOf(await (await mountPane($)).drawn())
  const first = cardsOf(text).find(c => c.includes('explorer')) ?? ''
  const second = cardsOf(text).find(c => c.includes('architect')) ?? ''
  expect(first).toContain('ctx 9.9k')
  expect(first).toContain('10k tok')
  expect(second).toContain('ctx 10k')
  expect(second).toContain('9.9k tok')
})

const metricsLine = (card: string) => {
  const text = /<text class="meta" x="\d+" y="\d+"><tspan class="ctx[\s\S]*?<\/text>/.exec(card)?.[0] ?? ''
  return { plain: text.replace(/<[^>]*>/g, ''), tspans: text.split('<tspan').length - 1 }
}

test('a metrics line wider than the card is cut with an ellipsis, and a fitting one is left whole', async (...ctx) => {
  const [$] = ctx
  await bootGraph(ctx)
  queueUsage('a1', usage('claude-fable-5-1', 0, 250_000_000, 1_000_000, 0))
  queueUsage('a2', usage('claude-sonnet-5-5', 10_000, 1000, 230_000, 10_000))
  await step($, 'a1')
  await step($, 'a2')
  const text = textOf(await (await mountPane($)).drawn())
  const wide = metricsLine(cardsOf(text).find(c => c.includes('explorer')) ?? '')
  const normal = metricsLine(cardsOf(text).find(c => c.includes('architect')) ?? '')
  expect(wide.plain).toMatch(/^ctx 1\.0M · 100% cache 100% ~\$\d+…$/)
  expect(wide.plain.length * 6.6 + 8 * (wide.tspans - 1)).toBeLessThanOrEqual(240)
  expect(normal.plain).toBe('ctx 250k · 25% cache 92% ~$0.12')
})

test('fitMetrics keeps what fits, cuts the part that does not, and says so', () => {
  expect(fitMetrics('ctx 5k', ['cache 92%', '~$0.16'])).toEqual({ ctx: 'ctx 5k', extras: ['cache 92%', '~$0.16'] })
  const lead = 'c'.repeat(29)
  expect(fitMetrics(lead, ['abcde'])).toEqual({ ctx: lead, extras: ['abcde'] })
  expect(fitMetrics(lead, ['abcdef'])).toEqual({ ctx: lead, extras: ['abcd…'] })
  expect(fitMetrics(lead, ['abcdef', 'more'])).toEqual({ ctx: lead, extras: ['abcd…'] })
  expect(fitMetrics('c'.repeat(32), ['long-extra'])).toEqual({ ctx: 'c'.repeat(32), extras: ['l…'] })
  expect(fitMetrics('c'.repeat(33), ['long'])).toEqual({ ctx: 'c'.repeat(33), extras: ['…'] })
  expect(fitMetrics('c'.repeat(35), ['long'])).toEqual({ ctx: `${'c'.repeat(34)}…`, extras: [] })
})

const jobs = (count: number, finished: number): Row[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `j${i}`,
    type: 'explorer',
    description: `job ${String(i).padStart(2, '0')}`,
    status: i < finished ? 'completed' : 'running',
  }))

test('draws at most 34 agent cards, as tall as the engine allows, and counts the rest under the graph', async (...ctx) => {
  const [$] = ctx
  await bootGraph(ctx, jobs(45, 0))
  const text = textOf(await (await mountPane($)).drawn())
  expect(cardsOf(text)).toHaveLength(35)
  expect(text).toContain('45 running')
  expect(text).toContain('+11 more agents')
  expect(Number(/<svg [^>]*height="(\d+)"/.exec(text)?.[1])).toBeLessThanOrEqual(4096)
})

test('says +1 more agent in the singular', async (...ctx) => {
  const [$] = ctx
  await bootGraph(ctx, jobs(35, 0))
  const text = textOf(await (await mountPane($)).drawn())
  expect(cardsOf(text)).toHaveLength(35)
  expect(text).toContain('+1 more agent')
  expect(text).not.toContain('+1 more agents')
})

test('draws no more-agents line while 34 or fewer agents fit', async (...ctx) => {
  const [$] = ctx
  await bootGraph(ctx, jobs(34, 0))
  const text = textOf(await (await mountPane($)).drawn())
  expect(cardsOf(text)).toHaveLength(35)
  expect(text).not.toContain('more agent')
})

test('over the cap, keeps the ancestors of a kept agent so no card is drawn under the wrong parent', () => {
  const chain = [
    { id: 'root', type: 'architect', description: 'root', status: 'completed' },
    { id: 'child', type: 'architect', description: 'child', status: 'completed', parentId: 'root' },
    { id: 'grand', type: 'explorer', description: 'grand', status: 'running', parentId: 'child' },
  ]
  const shown = [...chain, ...jobs(34, 0)]
  const { agents, hidden } = capAgents(shown, {}, 34)
  const ids = new Set(agents.map(a => a.id))
  expect(agents).toHaveLength(34)
  expect(hidden).toBe(3)
  for (const id of ['root', 'child', 'grand']) expect(ids.has(id)).toBe(true)
  for (const a of agents) if (a.parentId) expect(ids.has(a.parentId)).toBe(true)
})

const guarded = (row: Row): Row => {
  let reads = 0
  const { parentId } = row
  return Object.defineProperty({ ...row, parentId: undefined }, 'parentId', {
    enumerable: true,
    get() {
      reads += 1
      if (reads > 1000) throw new Error('capAgents did not terminate')
      return parentId
    },
  })
}

test('over the cap, terminates on a parent cycle and counts the hidden agents', () => {
  const cycle = [
    guarded({ id: 'c1', type: 'architect', description: 'c1', status: 'running', parentId: 'c2' }),
    guarded({ id: 'c2', type: 'architect', description: 'c2', status: 'running', parentId: 'c1' }),
  ]
  const { agents, hidden } = capAgents([...cycle, ...jobs(34, 0)], {}, 34)
  const ids = new Set(agents.map(a => a.id))
  expect(agents).toHaveLength(34)
  expect(hidden).toBe(2)
  expect(ids.has('c1') && ids.has('c2')).toBe(true)
})

test('over the cap, keeps an agent whose parent is not among the shown agents', () => {
  const orphan = guarded({ id: 'orphan', type: 'explorer', description: 'orphan', status: 'running', parentId: 'ghost' })
  const { agents, hidden } = capAgents([orphan, ...jobs(34, 0)], {}, 34)
  expect(agents).toHaveLength(34)
  expect(hidden).toBe(1)
  expect(agents.some(a => a.id === 'orphan')).toBe(true)
})

test('over the cap, keeps every running agent and the agents that finished last', async (...ctx) => {
  const [$] = ctx
  let list = jobs(42, 0)
  const clock = await boot(ctx, () => list, NOW, undefined, false)
  await $.turn.complete(TURN_DONE('zz'))
  for (let i = 1; i <= 12; i += 1) {
    list = jobs(42, i)
    await clock.advance(1000)
  }
  const text = textOf(await (await mountPane($)).drawn())
  expect(text).toContain('30 running')
  expect(text).toContain('+8 more agents')
  expect(cardsOf(text)).toHaveLength(35)
  for (let i = 8; i < 42; i += 1) expect(text).toContain(`job ${String(i).padStart(2, '0')}`)
  for (let i = 0; i < 8; i += 1) expect(text).not.toContain(`job ${String(i).padStart(2, '0')}`)
})

test('a subagent card shows its model name right-aligned on the title row', async (...ctx) => {
  const [$] = ctx
  await bootGraph(ctx)
  queueUsage('a1', usage('claude-sonnet-5-5', 10_000, 1000, 0, 0))
  await step($, 'a1')
  const text = textOf(await (await mountPane($)).drawn())
  const card = cardsOf(text).find(c => c.includes('explorer')) ?? ''
  expect(card).toMatch(/<text class="model" x="\d+(\.\d+)?" y="\d+(\.\d+)?" text-anchor="end">Sonnet 5\.5<\/text>/)
})

const MODEL_RE = /<text class="model"[^>]*>([^<]*)<\/text>/

test('the main card shows its own model name', async (...ctx) => {
  const [$] = ctx
  await bootGraph(ctx)
  queueUsage('main', usage('claude-opus-5-5', 100_000, 20_000, 0, 0))
  await step($, undefined)
  const text = textOf(await (await mountPane($)).drawn())
  const main = cardsOf(text).find(c => c.includes('>Main<')) ?? ''
  expect(main).toContain('<text class="model" x="260" y="31" text-anchor="end">Opus 5.5</text>')
  expect(MODEL_RE.exec(cardsOf(text).find(c => c.includes('explorer')) ?? '')).toBeNull()
})

test('a card draws no model name before its first step', async (...ctx) => {
  const [$] = ctx
  await bootGraph(ctx)
  queueUsage('a1', usage('claude-sonnet-5-5', 10_000, 1000, 0, 0))
  await step($, 'a1')
  const text = textOf(await (await mountPane($)).drawn())
  expect(cardsOf(text).find(c => c.includes('explorer')) ?? '').toContain('class="model"')
  for (const kind of ['>Main<', 'architect', 'fixer']) {
    expect(cardsOf(text).find(c => c.includes(kind)) ?? '').not.toContain('class="model"')
  }
})

test('a model id reads as a family name and version, with date, 1m and platform suffixes dropped', async (...ctx) => {
  const [$] = ctx
  await bootGraph(ctx, [
    ...GRAPH_AGENTS,
    { id: 'a4', type: 'tester', description: 'Run the tests', status: 'running' },
    { id: 'a5', type: 'scout', description: 'Scout ahead', status: 'running' },
  ])
  queueUsage('a1', usage('claude-haiku-4-5-20251001', 100, 10, 0, 0))
  queueUsage('a2', usage('claude-fable-5-1[1m]', 100, 10, 0, 0))
  queueUsage('a3', usage('claude-opus-5', 100, 10, 0, 0))
  queueUsage('a4', usage('claude-experimental-x', 100, 10, 0, 0))
  queueUsage('a5', usage('claude-sonnet-5-5@20251001', 100, 10, 0, 0))
  for (const id of ['a1', 'a2', 'a3', 'a4', 'a5']) await step($, id)
  const text = textOf(await (await mountPane($)).drawn())
  const modelOf = (kind: string) => MODEL_RE.exec(cardsOf(text).find(c => c.includes(kind)) ?? '')?.[1]
  expect(modelOf('explorer')).toBe('Haiku 4.5')
  expect(modelOf('architect')).toBe('Fable 5.1')
  expect(modelOf('fixer')).toBe('Opus 5')
  expect(modelOf('tester')).toBe('experimental-x')
  expect(modelOf('scout')).toBe('Sonnet 5.5')
})

test('a model id with a bracket suffix followed by a platform suffix reads as a family name and version', async (...ctx) => {
  const [$] = ctx
  await bootGraph(ctx)
  queueUsage('a1', usage('claude-sonnet-5-5[1m]@x', 100, 10, 0, 0))
  await step($, 'a1')
  const text = textOf(await (await mountPane($)).drawn())
  expect(MODEL_RE.exec(cardsOf(text).find(c => c.includes('explorer')) ?? '')?.[1]).toBe('Sonnet 5.5')
})

test('an id that is not exactly a family and version is shown as given minus the claude- prefix', async (...ctx) => {
  const [$] = ctx
  await bootGraph(ctx, [
    ...GRAPH_AGENTS,
    { id: 'a4', type: 'tester', description: 'Run the tests', status: 'running' },
  ])
  queueUsage('a1', usage('claude-sonnet-5-5-v2', 100, 10, 0, 0))
  queueUsage('a2', usage('claude-opus-5-100', 100, 10, 0, 0))
  queueUsage('a3', usage('claude-my-opus-5', 100, 10, 0, 0))
  queueUsage('a4', usage('claude-', 100, 10, 0, 0))
  for (const id of ['a1', 'a2', 'a3', 'a4']) await step($, id)
  const text = textOf(await (await mountPane($)).drawn())
  const card = (kind: string) => cardsOf(text).find(c => c.includes(kind)) ?? ''
  expect(MODEL_RE.exec(card('explorer'))?.[1]).toBe('sonnet-5-5-v2')
  expect(MODEL_RE.exec(card('architect'))?.[1]).toBe('opus-5-100')
  expect(MODEL_RE.exec(card('fixer'))?.[1]).toBe('my-opus-5')
  expect(card('tester')).not.toContain('class="model"')
})

test('a missing model and an empty model both draw no model name', async (...ctx) => {
  const [$] = ctx
  await bootGraph(ctx)
  queueUsage('a1', usage('', 100, 10, 0, 0))
  await step($, 'a1')
  const text = textOf(await (await mountPane($)).drawn())
  expect(cardsOf(text).find(c => c.includes('explorer')) ?? '').not.toContain('class="model"')
  expect(cardsOf(text).find(c => c.includes('architect')) ?? '').not.toContain('class="model"')
  expect(cardsOf(text).find(c => c.includes('explorer')) ?? '').toContain('ctx 100')
})

test('a model id is escaped and stripped of control characters before it is drawn', async (...ctx) => {
  const [$] = ctx
  await bootGraph(ctx, [
    ...GRAPH_AGENTS,
    { id: 'a4', type: 'tester', description: 'Run the tests', status: 'running' },
  ])
  queueUsage('a1', usage('claude-a&b<c>"d', 100, 10, 0, 0))
  queueUsage('a4', usage('claude-x\u0001y\tz', 100, 10, 0, 0))
  await step($, 'a1')
  await step($, 'a4')
  const text = textOf(await (await mountPane($)).drawn())
  const card = (kind: string) => cardsOf(text).find(c => c.includes(kind)) ?? ''
  expect(card('explorer')).toContain('>a&amp;b&lt;c&gt;&quot;d</text>')
  expect(card('tester')).toContain('>xy z</text>')
})

test('the model name has a style rule in both the light and the dark stylesheet', async (...ctx) => {
  const [$] = ctx
  await bootGraph(ctx)
  const text = textOf(await (await mountPane($)).drawn())
  const dark = text.indexOf('@media (prefers-color-scheme: dark)')
  const light = ".meta,.act,.model{font:11px ui-monospace,SFMono-Regular,Menlo,monospace;fill:#8a877f}"
  const darkRule = '.title{fill:#edede9}.desc{fill:#c9c7c0}.meta,.act,.model{fill:#8f8d87}'
  expect(text.indexOf(light)).toBeGreaterThan(-1)
  expect(text.indexOf(light)).toBeLessThan(dark)
  expect(text.indexOf(darkRule)).toBeGreaterThan(dark)
})

test('a long model id is cut to 18 characters with an ellipsis', async (...ctx) => {
  const [$] = ctx
  await bootGraph(ctx)
  queueUsage('a1', usage('claude-an-experimental-model-name', 100, 10, 0, 0))
  await step($, 'a1')
  const text = textOf(await (await mountPane($)).drawn())
  const label = MODEL_RE.exec(cardsOf(text).find(c => c.includes('explorer')) ?? '')?.[1] ?? ''
  expect([...label]).toHaveLength(18)
  expect(label.endsWith('…')).toBe(true)
})

test('a long title is cut shorter when the card also shows a model name', async (...ctx) => {
  const [$] = ctx
  const long = 'an-extraordinarily-long-agent-type-name'
  const rows: Row[] = [
    { id: 'a1', type: long, description: 'With a model', status: 'running' },
    { id: 'a2', type: long, description: 'Without a model', status: 'running' },
  ]
  await bootGraph(ctx, rows)
  queueUsage('a1', usage('claude-sonnet-5-5', 100, 10, 0, 0))
  await step($, 'a1')
  const text = textOf(await (await mountPane($)).drawn())
  const titleOf = (desc: string) => /class="title"[^>]*>([^<]*)</.exec(cardsOf(text).find(c => c.includes(desc)) ?? '')?.[1] ?? ''
  const withModel = titleOf('With a model')
  const without = titleOf('Without a model')
  expect([...without]).toHaveLength(26)
  expect(withModel).toBe(`${long.slice(0, 18)}…`)
})

test('the room kept for a model name counts code points, not UTF-16 units', async (...ctx) => {
  const [$] = ctx
  const long = 'an-extraordinarily-long-agent-type-name'
  await bootGraph(ctx, [{ id: 'a1', type: long, description: 'With a model', status: 'running' }])
  queueUsage('a1', usage(`claude-${'😀'.repeat(9)}`, 100, 10, 0, 0))
  await step($, 'a1')
  const text = textOf(await (await mountPane($)).drawn())
  const card = cardsOf(text).find(c => c.includes('With a model')) ?? ''
  expect(/class="title"[^>]*>([^<]*)</.exec(card)?.[1]).toBe(`${long.slice(0, 19)}…`)
})
