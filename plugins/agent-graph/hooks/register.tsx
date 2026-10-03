import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Activity, AgentRow } from '../types'
import { drawSvg } from './draw-svg'
import {
  MAIN,
  RECENT_MS,
  blankActivity,
  buildGraph,
  capAgents,
  sanitize,
  summarizeTool,
  visibleAgents,
} from './layout'
import { withUsage } from './pricing'

const PANE = 'agent-graph'
const TITLE = 'Agents'

const agentsAtom = atom({ plugin: 'agent-graph', key: 'agents' } as const, [])
const activityAtom = atom({ plugin: 'agent-graph', key: 'activity' } as const, {})
const nowAtom = atom({ plugin: 'agent-graph', key: 'now' } as const, 0)
const autoOpenedAtom = atom({ plugin: 'agent-graph', key: 'autoOpened' } as const, false)
const mainWorkingAtom = atom({ plugin: 'agent-graph', key: 'mainWorking' } as const, false)

const PENDING_MS = 5000
// The engine refuses an Svg over 4096px tall; 34 rows of cards is the most that fit.
const MAX_AGENT_CARDS = 34

const isRunning = (status: string) => status === 'running' || status === 'pending'

let timer: Timer | undefined
let wasLive = false
let isSetUp = false
let hasDesktop: boolean | undefined
let spawnsInFlight = 0
let needsRegister = false
let refreshChain: Promise<void> = Promise.resolve()
let outstandingRefreshes = 0

async function onDesktop($: EngineInterface) {
  return (await $.session.surfaces()).includes('desktop')
}

async function setUp($: EngineInterface, surface: string | null) {
  if (isSetUp) return
  const desktop = surface === 'desktop' || (await onDesktop($))
  hasDesktop = desktop
  if (isSetUp || !desktop) return
  isSetUp = true
  void $.command.register({ name: 'agent-graph', description: 'Show running subagents as a graph' }).catch(() => {})
}

async function ensureTimer($: EngineInterface) {
  if (timer || !(await onDesktop($))) return
  timer ??= $.clock.every(1000, () => {
    if (outstandingRefreshes === 0) void refresh($)
  })
}

function stopTimer() {
  timer?.cancel()
  timer = undefined
}

function refresh($: EngineInterface) {
  outstandingRefreshes += 1
  refreshChain = refreshChain
    .then(() => syncAgents($))
    .catch(() => {})
    .finally(() => {
      outstandingRefreshes -= 1
    })
  return refreshChain
}

async function syncAgents($: EngineInterface) {
  if (!(await onDesktop($))) {
    stopTimer()
    return
  }
  const now = await $.clock.now()
  const list = await $.agent.list()
  const rows: AgentRow[] = list.map(a => ({
    id: a.id,
    type: a.type,
    description: a.description,
    status: a.status,
    parentId: a.parentId,
    name: a.name,
  }))
  const prev = await read($, agentsAtom)
  const prevStatus = new Map(prev.map(a => [a.id, a.status]))
  if (JSON.stringify(prev) !== JSON.stringify(rows)) {
    await update($, agentsAtom, () => rows)
    await update($, activityAtom, act => {
      const next: Record<string, Activity> = { ...act }
      for (const r of rows) {
        const cur = next[r.id] ?? blankActivity(now)
        if (isRunning(r.status)) {
          const { endedAt: _, ...running } = cur
          const started = !isRunning(prevStatus.get(r.id) ?? '')
          next[r.id] = started ? { ...running, runStart: prevStatus.has(r.id) ? now : cur.firstSeen } : running
        } else if (isRunning(prevStatus.get(r.id) ?? '')) {
          next[r.id] = { ...cur, endedAt: now, tool: undefined }
        } else {
          next[r.id] = cur
        }
      }
      return next
    })
  }
  const listed = new Set(rows.map(r => r.id))
  await update($, activityAtom, act => {
    const stale = Object.keys(act).filter(id => id !== MAIN && !listed.has(id) && now - (act[id]?.lastSeen ?? 0) >= PENDING_MS)
    if (stale.length === 0) return act
    const next = { ...act }
    for (const id of stale) delete next[id]
    return next
  })
  const activity = await read($, activityAtom)
  const isLive = rows.some(r => isRunning(r.status) || now - (activity[r.id]?.endedAt ?? -Infinity) < RECENT_MS)
  if (isLive || wasLive) await update($, nowAtom, () => now)
  wasLive = isLive
  if (isLive || spawnsInFlight > 0) await ensureTimer($)
  else stopTimer()
}

async function noteActivity($: EngineInterface, id: string, fn: (a: Activity) => Activity) {
  if (!isSetUp && (hasDesktop === false || !(await onDesktop($)))) return
  const now = await $.clock.now()
  await update($, activityAtom, act => ({
    ...act,
    [id]: { ...fn(act[id] ?? blankActivity(now)), lastSeen: now },
  }))
}

async function openPane($: EngineInterface) {
  if (!(await onDesktop($))) return undefined
  return $.ui.open({ id: PANE, title: TITLE })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await setUp($, e.surface)
    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    await setUp($, e.surface)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await update($, mainWorkingAtom, () => false)
    if (e.reason === 'clear' || e.reason === 'resume') {
      needsRegister = true
      stopTimer()
      wasLive = false
      isSetUp = false
      hasDesktop = undefined
      await update($, agentsAtom, () => [])
      await update($, activityAtom, () => ({}))
      await update($, autoOpenedAtom, () => false)
    }

    return next(e)
  })

  on('command.run', { command: 'agent-graph' }, async $ => {
    await ensureTimer($)
    const opened = await openPane($)
    if (!opened) return { text: 'The Agents graph draws only in the desktop app.' }
    if (opened.isPlaced) return { text: 'Agents graph opened.' }
    const reason = sanitize(opened.reason)

    return { text: reason ? `The Agents graph could not be opened: ${reason}` : 'The Agents graph could not be opened' }
  })

  on('turn.start', async ($, e, next) => {
    if (needsRegister) {
      needsRegister = false
      await setUp($, null)
    }
    await update($, mainWorkingAtom, () => true)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) await update($, mainWorkingAtom, () => false)
    else await refresh($)

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const isSpawn = e.tool === 'Agent' || (e.tool as string) === 'Task'
    try {
      if (isSpawn) {
        spawnsInFlight += 1
        await ensureTimer($)
      }
      const summary = summarizeTool(e as unknown as Record<string, unknown>)
      await noteActivity($, e.agentId ?? MAIN, a => ({ ...a, tool: summary }))
      if (!isSpawn) return await next(e)

      if (!(await read($, autoOpenedAtom)) && (await onDesktop($))) {
        await update($, autoOpenedAtom, () => true)
        void openPane($).catch(() => {})
      }
      void $.clock.sleep(300).then(() => refresh($)).catch(() => {})
      return await next(e)
    } finally {
      if (isSpawn) {
        spawnsInFlight -= 1
        await refresh($)
      }
    }
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const { usage } = result
    await noteActivity($, e.agentId ?? MAIN, a => {
      const stepped = { ...a, steps: a.steps + 1 }
      return usage ? withUsage(stepped, usage) : stepped
    })

    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface !== 'desktop') return next(e)
    const { Box, Text, Svg } = $.ui.resolve(e)
    const agents = await read($, agentsAtom)
    const activity = await read($, activityAtom)
    const mainWorking = await read($, mainWorkingAtom)
    await read($, nowAtom)
    const now = await $.clock.now()

    const visible = visibleAgents(agents, activity, now)
    const { agents: shown, hidden } = capAgents(visible, activity, MAX_AGENT_CARDS)
    const running = visible.filter(a => isRunning(a.status)).length
    const finished = agents.filter(a => !isRunning(a.status) && activity[a.id]?.endedAt !== undefined).length

    const header = (
      <Text key="header">
        <Text bold>{running}</Text>
        <Text dimColor> running</Text>
        {finished > 0 ? <Text dimColor>{`  ·  ${finished} finished this session`}</Text> : null}
      </Text>
    )

    if (shown.length === 0) {
      return (
        <Box flexDirection="column" rowGap={1}>
          {header}
          <Text dimColor>No subagents running. The graph appears here when the session spawns one.</Text>
        </Box>
      )
    }

    const { root, slots, depth } = buildGraph(shown, activity, now, mainWorking)
    const { svg, width, height } = drawSvg(root, slots, depth)
    const alt = shown.map(a => sanitize(`${a.name ?? a.type} (${a.status}): ${a.description}`)).join('; ')

    return (
      <Box flexDirection="column" rowGap={1}>
        {header}
        <Svg key="graph" source={svg} alt={alt} width={width} height={height} />
        {hidden > 0 ? <Text key="more" dimColor>{`+${hidden} more ${hidden === 1 ? 'agent' : 'agents'}`}</Text> : null}
      </Box>
    )
  })
}
