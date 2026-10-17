import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { GitInfo, Measure, WorkspaceState } from '../types'
import { EMPTY_SUBAGENTS, addAgentStep, addAgentTool, agentView, mergeAgentRows, toAgentRow } from './agents'
import { drawAgentLine } from './agentline'
import { drawBand } from './band'
import { clean } from './format'
import { EMPTY_MODEL, addAnswer, keepSelection, resolveModel, selectModel } from './model'
import { DEFAULT_COLUMNS, HOST_INSET, drawStatusLine } from './statusline'
import { parseGitStatus } from './workspace'

const cacheAtom = atom({ plugin: 'meter', key: 'cache' } as const, null)
const measureAtom = atom({ plugin: 'meter', key: 'measure' } as const, null)
const nowAtom = atom({ plugin: 'meter', key: 'now' } as const, 0)

const EMPTY_WORKSPACE: WorkspaceState = { cwd: null, home: null, git: null }

const subagentsAtom = atom({ plugin: 'meter', key: 'subagents' } as const, EMPTY_SUBAGENTS)
const modelAtom = atom({ plugin: 'meter', key: 'model' } as const, EMPTY_MODEL)
const workspaceAtom = atom({ plugin: 'meter', key: 'workspace' } as const, EMPTY_WORKSPACE)

const GIT_TIMEOUT_MS = 2000
const TOOL_DEBOUNCE_MS = 1000
const TREE_TOOLS = new Set(['Bash', 'Edit', 'Write', 'NotebookEdit'])

let modelTicket = 0
let resetCount = 0
let workspaceTicket = 0
let toolTimer: Timer | null = null
let tickTimer: Timer | null = null

const toMeasure = (m: Measure): Measure => ({
  context: { tokens: m.context.tokens, window: m.context.window, percent: m.context.percent },
  rateLimits: m.rateLimits.map(l => ({ kind: clean(l.kind), percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
  cost: m.cost && { usd: m.cost.usd },
})

async function refreshModel($: EngineInterface) {
  const ticket = ++modelTicket
  const at = await $.clock.now()
  const id = clean(await $.session.model())
  if (id.trim() === '' || ticket !== modelTicket) return
  await update($, modelAtom, m => selectModel(m, id, at))
}

async function readGit($: EngineInterface, cwd: string): Promise<GitInfo | null> {
  try {
    const run = await $.process.run(['git', '--no-optional-locks', 'status', '--porcelain=v2', '--branch'], {
      cwd,
      timeoutMs: GIT_TIMEOUT_MS,
    })

    return run.exitCode === 0 ? parseGitStatus(run.stdout) : null
  } catch {
    return null
  }
}

async function refreshWorkspace($: EngineInterface) {
  const ticket = ++workspaceTicket
  if (!(await $.session.surfaces()).includes('terminal')) return
  const cwd = clean(await $.session.cwd())
  const home = (await $.env.get('HOME')) ?? null
  const git = await readGit($, cwd)
  if (ticket !== workspaceTicket) return
  await update($, workspaceAtom, () => ({ cwd, home, git }))
}

async function refreshAgents($: EngineInterface, resetsAtStart: number) {
  try {
    const list = await $.agent.list()
    if (resetCount !== resetsAtStart) return
    await update($, subagentsAtom, s => ({ ...s, list: mergeAgentRows(s.list, list.map(toAgentRow)) }))
  } catch {}
}

async function recordAgentTool($: EngineInterface, agentId: string, tool: string, startedAt: number, resetsAtStart: number) {
  try {
    if (resetCount !== resetsAtStart) return
    const at = await $.clock.now()
    await update($, subagentsAtom, s => addAgentTool(s, agentId, tool, startedAt, at))
  } catch {}
}

async function resetSession($: EngineInterface) {
  resetCount++
  await update($, cacheAtom, () => null)
  await update($, measureAtom, () => null)
  await update($, subagentsAtom, () => EMPTY_SUBAGENTS)
  await update($, modelAtom, keepSelection)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      const usage = await $.session.usage()
      await update($, measureAtom, () => toMeasure(usage))
    } catch {}
    tickTimer?.cancel()
    tickTimer = $.clock.every(30_000, async () => {
      const t = await $.clock.now()
      await update($, nowAtom, () => t)
    })
    void refreshModel($).catch(() => {})
    void refreshWorkspace($).catch(() => {})

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    const isReset = e.reason === 'clear' || e.reason === 'resume'
    if (isReset) await resetSession($)
    const result = await next(e)
    if (isReset) void refreshModel($).catch(() => {})

    return result
  })

  on('turn.start', async ($, e, next) => {
    void refreshModel($).catch(() => {})

    return next(e)
  })

  on('command.run', { command: 'model' }, async ($, e, next) => {
    try {
      return await next(e)
    } finally {
      void refreshModel($).catch(() => {})
    }
  })

  on('session.measure', async ($, e, next) => {
    await update($, measureAtom, () => toMeasure(e))

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const agentId = e.agentId
    const resetsAtStart = resetCount
    const t0 = await $.clock.now()
    const result = yield* next(e)
    const usage = result.usage
    if (!usage) return result
    const t1 = await $.clock.now()
    const effort = e.effort === undefined ? null : String(e.effort)
    if (resetCount !== resetsAtStart) return result
    if (agentId === undefined) {
      await update($, cacheAtom, prev => ({
        lastRead: usage.cache_read_input_tokens,
        lastWrite: usage.cache_creation_input_tokens,
        lastUncached: usage.input_tokens,
        totalRead: (prev?.totalRead ?? 0) + usage.cache_read_input_tokens,
        totalWrite: (prev?.totalWrite ?? 0) + usage.cache_creation_input_tokens,
        totalUncached: (prev?.totalUncached ?? 0) + usage.input_tokens,
        lastAt: t1,
      }))
      await update($, modelAtom, m =>
        addAnswer(m, {
          answered: usage.model,
          requested: e.model,
          effort,
          requestedAt: t0,
        }),
      )

      return result
    }
    const id = clean(agentId)
    const seen = await read($, subagentsAtom)
    const isNew = (seen.activity[id]?.requests ?? 0) === 0 && !seen.list.some(row => row.id === id)
    await update($, subagentsAtom, s => addAgentStep(s, agentId, { usage, requested: e.model, effort, startedAt: t0, at: t1 }))
    if (isNew) void refreshAgents($, resetsAtStart)

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const resetsAtStart = resetCount
    const result = await next(e)
    if (e.agentId === undefined) void refreshWorkspace($).catch(() => {})
    else void refreshAgents($, resetsAtStart)

    return result
  })

  on('tool.call', async ($, e, next) => {
    const t0 = await $.clock.now()
    const resetsAtStart = resetCount
    try {
      return await next(e)
    } finally {
      if (e.agentId !== undefined) await recordAgentTool($, e.agentId, e.tool, t0, resetsAtStart)
      if (e.tool === 'Agent') void refreshAgents($, resetsAtStart)
      if (TREE_TOOLS.has(e.tool)) {
        toolTimer?.cancel()
        toolTimer = $.clock.after(TOOL_DEBOUNCE_MS, () => {
          toolTimer = null
          void refreshWorkspace($).catch(() => {})
        })
      }
    }
  })

  on('classic.CwdChanged', async ($, e, next) => {
    const result = await next(e)
    void refreshWorkspace($).catch(() => {})

    return result
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const engine = await next(e)
    if (e.surface !== 'terminal') return engine
    const columns = (e.viewport?.columns ?? DEFAULT_COLUMNS) - 2 * HOST_INSET
    const els = $.ui.resolve(e)
    const model = resolveModel(await read($, modelAtom))
    const workspace = await read($, workspaceAtom)
    const measure = await read($, measureAtom)
    await read($, nowAtom)
    const now = await $.clock.now()
    const line = drawStatusLine(els, { model, workspace, measure, now }, columns)
    if (!line) return engine
    const { Box } = els

    return (
      <Box key="statusline-hint" flexDirection="column">
        {line}
        {engine}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'desktop' && e.surface !== 'terminal') return next(e)
    if (e.props.hasSurvey) return next(e)
    const agentId = e.props.view?.agentId
    if (agentId !== undefined) {
      const stats = await read($, subagentsAtom)
      await read($, nowAtom)
      const live = await $.agent.list().catch(() => null)
      const now = await $.clock.now()

      return drawAgentLine($.ui.resolve(e), e.surface, agentView(agentId, live, stats), { bodyColumns: e.props.bodyColumns, now })
    }
    if (e.surface !== 'desktop') return next(e)

    const measure = await read($, measureAtom)
    const cache = await read($, cacheAtom)
    const model = await read($, modelAtom)
    await read($, nowAtom)
    const now = await $.clock.now()
    const tree = drawBand(
      $.ui.resolve(e),
      { measure, cache, model: resolveModel(model) },
      { bodyColumns: e.props.bodyColumns, now, isWorking: e.props.isWorking },
    )

    return tree ?? next(e)
  })
}
