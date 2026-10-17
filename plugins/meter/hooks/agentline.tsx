import type { RenderElement } from 'claude-code'

import { ENDED, type AgentView } from './agents'
import { type Els, type Run, type Surface, dimRun } from './draw'
import { fmtSpan, fmtTokens, shortId } from './format'
import { resolveAnswer } from './model'
import { type Segment, cut, drawRow, fitRow, levelsFrom, modelRuns } from './row'

type AgentLevel = {
  gap: number
  description: number | null
  lastTool: boolean
  effort: boolean
  fallbackFrom: boolean
  elapsed: boolean
  statusWord: boolean
  tools: boolean
}

const FULL: AgentLevel = {
  gap: 3,
  description: 40,
  lastTool: true,
  effort: true,
  fallbackFrom: true,
  elapsed: true,
  statusWord: true,
  tools: true,
}

const LEVELS = levelsFrom(FULL, [
  {},
  { gap: 2 },
  { description: 20 },
  { lastTool: false },
  { description: null },
  { effort: false, fallbackFrom: false },
  { elapsed: false },
  { statusWord: false },
  { tools: false },
])

const TERMINAL_INSET = 2
const LAST_TOOL_MAX = 24

const IDLE_LOOK: { dot: Partial<Run>; word: Partial<Run> } = { dot: { dim: true }, word: { dim: true } }
const LOOKS: Record<string, { dot: Partial<Run>; word: Partial<Run> }> = {
  running: { dot: { color: 'success' }, word: {} },
  waiting: { dot: { color: 'warning' }, word: {} },
  failed: { dot: { color: 'error' }, word: { color: 'error' } },
  killed: { dot: { color: 'warning' }, word: { dim: true } },
}

export const agentSegments = (v: AgentView, level: AgentLevel, now: number): Segment[] => {
  const segments: Segment[] = []
  const { row, activity } = v

  const label = row ? row.name || row.type : ''
  if (row && label !== '') {
    const runs: Run[] = [{ text: label, bold: true }]
    if (level.description !== null && row.description !== '') runs.push({ text: ` ${cut(row.description, level.description)}`, dim: true })
    segments.push({ key: 'who', runs })
  } else {
    segments.push({ key: 'who', runs: [dimRun('Agent '), { text: shortId(v.id) }] })
  }

  if (row) {
    const look = Object.hasOwn(LOOKS, row.status) ? LOOKS[row.status]! : IDLE_LOOK
    const runs: Run[] = [{ text: '●', ...look.dot }]
    if (level.statusWord) runs.push({ text: ` ${row.status}`, ...look.word })
    segments.push({ key: 'status', runs })
  }

  if (activity?.model) {
    segments.push({
      key: 'model',
      runs: modelRuns(resolveAnswer(activity.model), { isBold: false, effort: level.effort, fallbackFrom: level.fallbackFrom }),
    })
  }

  if (activity && typeof activity.context === 'number') {
    segments.push({ key: 'ctx', runs: [dimRun('Ctx '), { text: fmtTokens(activity.context) }] })
  }

  if (level.tools && activity && activity.tools > 0) {
    const n = activity.tools
    const runs: Run[] = [{ text: `${n} tool${n === 1 ? '' : 's'}` }]
    if (level.lastTool && activity.lastTool !== null) runs.push({ text: ` · ${cut(activity.lastTool, LAST_TOOL_MAX)}`, dim: true })
    segments.push({ key: 'tools', runs })
  }

  if (level.elapsed && activity) {
    const end = row && ENDED.has(row.status) ? activity.lastAt : now
    segments.push({ key: 'elapsed', runs: [{ text: fmtSpan(Math.max(0, end - activity.firstAt)), dim: true }] })
  }

  return segments
}

export const drawAgentLine = (els: Els, surface: Surface, v: AgentView, opts: { bodyColumns: number; now: number }): RenderElement => {
  const build = (level: AgentLevel) => agentSegments(v, level, opts.now)
  if (surface === 'desktop') return drawRow(els, 'meter-agent', { segments: build(FULL), gap: FULL.gap }, 'wrap')

  return drawRow(els, 'meter-agent', fitRow(LEVELS, build, opts.bodyColumns - TERMINAL_INSET), 'nowrap', { marginTop: 1, paddingLeft: TERMINAL_INSET })
}
