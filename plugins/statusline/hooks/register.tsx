import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { GitInfo, WorkspaceState } from '../types'
import { DEFAULT_COLUMNS, HOST_INSET, drawLine, fitLine } from './line'
import { EMPTY_MODEL, addAnswer, clean, keepSelection, resolveModel, selectModel } from './model'
import { parseGitStatus } from './workspace'

const modelAtom = atom({ plugin: 'statusline', key: 'model' } as const, EMPTY_MODEL)
const workspaceAtom = atom({ plugin: 'statusline', key: 'workspace' } as const, { cwd: null, home: null, git: null } as WorkspaceState)

const GIT_TIMEOUT_MS = 2000
const TOOL_DEBOUNCE_MS = 1000
const TREE_TOOLS = new Set(['Bash', 'Edit', 'Write', 'NotebookEdit'])

let modelTicket = 0
let workspaceTicket = 0
let toolTimer: Timer | null = null

async function refreshModel($: EngineInterface) {
  const ticket = ++modelTicket
  const at = await $.clock.now()
  const id = clean(await $.session.model())
  if (ticket !== modelTicket || id.trim() === '') return
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

const refresh = ($: EngineInterface) => {
  void refreshModel($).catch(() => {})
  void refreshWorkspace($).catch(() => {})
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    $.ui.status(undefined)
    refresh($)

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    void refreshModel($).catch(() => {})

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) void refreshWorkspace($).catch(() => {})

    return result
  })

  on('command.run', { command: 'model' }, async ($, e, next) => {
    try {
      return await next(e)
    } finally {
      void refreshModel($).catch(() => {})
    }
  })

  on('session.end', async ($, e, next) => {
    const isReset = e.reason === 'clear' || e.reason === 'resume'
    if (isReset) await update($, modelAtom, keepSelection)
    const result = await next(e)
    if (isReset) void refreshModel($).catch(() => {})

    return result
  })

  on('turn.step', async function* ($, e, next) {
    const requestedAt = await $.clock.now()
    const result = yield* next(e)
    const usage = result.usage
    if (e.agentId === undefined && usage) {
      await update($, modelAtom, m =>
        addAnswer(m, {
          answered: usage.model,
          requested: e.model,
          effort: e.effort === undefined ? null : String(e.effort),
          requestedAt,
        }),
      )
    }

    return result
  })

  on('tool.call', async ($, e, next) => {
    try {
      return await next(e)
    } finally {
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
    const line = fitLine(resolveModel(await read($, modelAtom)), await read($, workspaceAtom), columns)
    if (line.segments.length === 0) return engine
    const els = $.ui.resolve(e)
    const { Box } = els

    return (
      <Box key="statusline-hint" flexDirection="column">
        {drawLine(els, line)}
        {engine}
      </Box>
    )
  })
}
