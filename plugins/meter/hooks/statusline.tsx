import type { RenderElement } from 'claude-code'

import type { Measure, ResolvedModel, WorkspaceState } from '../types'
import { type Els, type Run, dimRun, toneRun } from './draw'
import { fmtCost, limitLabel, limitTone, loadTone } from './format'
import { type Segment, cut, drawRow, fitRow, levelsFrom, modelRuns } from './row'
import { basename, shortenPath, splitPath } from './workspace'

type StatusLevel = {
  gap: number
  path: number | 'base' | null
  effort: boolean
  fallbackFrom: boolean
  branchMax: number
  cost: boolean
  limits: 'all' | 'hot' | 'none'
  ctx: boolean
}
export type StatusData = { model: ResolvedModel | null; workspace: WorkspaceState; measure: Measure | null; now: number }

export const HOST_INSET = 2
export const DEFAULT_COLUMNS = 80

const FULL: StatusLevel = { gap: 3, path: 48, effort: true, fallbackFrom: true, branchMax: 48, cost: true, limits: 'all', ctx: true }

const STEPS: Partial<StatusLevel>[] = [
  {},
  { gap: 2 },
  { cost: false },
  { path: 28 },
  { limits: 'hot' },
  { path: 'base' },
  { effort: false, fallbackFrom: false },
  { branchMax: 24 },
  { path: null },
  { limits: 'none' },
  { branchMax: 12 },
  { ctx: false },
]

const LEVELS = levelsFrom(FULL, STEPS)

const statusSegments = (d: StatusData, level: StatusLevel): Segment[] => {
  const { model, workspace: ws } = d
  const segments: Segment[] = []

  if (model && model.name !== '') {
    segments.push({ key: 'model', runs: modelRuns(model, { isBold: true, effort: level.effort, fallbackFrom: level.fallbackFrom }) })
  }

  if (ws.cwd !== null && ws.cwd !== '' && level.path !== null) {
    const shown =
      level.path === 'base' ? basename(shortenPath(ws.cwd, ws.home, Infinity)) : shortenPath(ws.cwd, ws.home, level.path)
    const { parent, base } = splitPath(shown)
    const runs: Run[] = []
    if (parent !== '') runs.push({ text: parent, dim: true })
    runs.push({ text: base })
    segments.push({ key: 'path', runs })
  }

  if (ws.git !== null) {
    const g = ws.git
    const runs: Run[] = [{ text: cut(g.head, level.branchMax), color: g.isDetached ? 'warning' : undefined }]
    if (g.isDirty) runs.push({ text: ' ' }, { text: '●' })
    if (g.ahead > 0 || g.behind > 0) {
      runs.push({ text: ' ' })
      if (g.ahead > 0) runs.push({ text: `↑${g.ahead}` })
      if (g.behind > 0) runs.push({ text: `↓${g.behind}`, color: 'warning' })
    }
    segments.push({ key: 'git', runs })
  }

  const pct = d.measure?.context.percent
  if (level.ctx && pct !== undefined) segments.push({ key: 'ctx', runs: [dimRun('Ctx '), toneRun(`${pct}%`, loadTone(pct))] })

  for (const l of d.measure?.rateLimits ?? []) {
    const tone = limitTone(l, d.now)
    if (level.limits === 'none' || (level.limits === 'hot' && tone !== 'warning' && tone !== 'error')) continue
    segments.push({ key: `limit-${l.kind}`, runs: [dimRun(`${limitLabel(l.kind)} `), toneRun(`${Math.round(l.percentUsed)}%`, tone)] })
  }

  if (level.cost && d.measure?.cost) segments.push({ key: 'cost', runs: [{ text: fmtCost(d.measure.cost.usd) }] })

  return segments
}

export const drawStatusLine = (els: Els, d: StatusData, columns: number): RenderElement | null => {
  const row = fitRow(LEVELS, level => statusSegments(d, level), columns)

  return row.segments.length === 0 ? null : drawRow(els, 'statusline', row, 'nowrap', { marginTop: 1 })
}
