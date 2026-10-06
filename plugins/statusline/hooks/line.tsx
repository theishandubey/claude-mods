import type { Color, Elements, RenderElement } from 'claude-code'

import type { WorkspaceState } from '../types'
import type { ResolvedModel } from './model'
import { basename, shortenPath, splitPath } from './workspace'

export type Run = { text: string; color?: Color; dim?: boolean; bold?: boolean }
type Segment = { key: 'model' | 'path' | 'git'; runs: Run[] }
type Level = { gap: number; path: number | 'base' | null; effort: boolean; fallbackFrom: boolean; branchMax: number }

export const ROW_INDENT = 2
export const DEFAULT_COLUMNS = 80

const FULL: Level = { gap: 3, path: 48, effort: true, fallbackFrom: true, branchMax: 48 }

const STEPS: Partial<Level>[] = [
  {},
  { gap: 2 },
  { path: 28 },
  { path: 'base' },
  { effort: false, fallbackFrom: false },
  { branchMax: 24 },
  { path: null },
  { branchMax: 12 },
]

const LEVELS: Level[] = STEPS.reduce<Level[]>((levels, step) => [...levels, { ...(levels.at(-1) ?? FULL), ...step }], [])

const width = (s: string) => [...s].length

const cut = (s: string, max: number) => (width(s) <= max ? s : `${[...s].slice(0, max - 1).join('')}…`)

export const buildSegments = (model: ResolvedModel | null, ws: WorkspaceState, level: Level): Segment[] => {
  const segments: Segment[] = []

  if (model && model.name !== '') {
    const runs: Run[] = []
    if (model.fallbackFrom !== null) {
      runs.push({ text: model.name, bold: true, color: 'warning' })
      runs.push({ text: level.fallbackFrom ? ` fallback from ${model.fallbackFrom}` : ' fallback', dim: true })
    } else {
      runs.push({ text: model.name, bold: true })
      if (level.effort && model.effort !== null && model.effort !== '') runs.push({ text: ` ${model.effort}`, dim: true })
    }
    segments.push({ key: 'model', runs })
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

  return segments
}

const rowWidth = (segments: readonly Segment[], gap: number) =>
  segments.reduce((n, s) => n + s.runs.reduce((w, r) => w + width(r.text), 0), 0) + gap * Math.max(0, segments.length - 1)

export const fitLine = (model: ResolvedModel | null, ws: WorkspaceState, columns: number) => {
  for (const level of LEVELS) {
    const segments = buildSegments(model, ws, level)
    if (rowWidth(segments, level.gap) <= columns) return { segments, gap: level.gap }
  }
  const level = LEVELS.at(-1)!

  return { segments: buildSegments(model, ws, level), gap: level.gap }
}

export const drawLine = (els: Elements['terminal'], line: ReturnType<typeof fitLine>): RenderElement => {
  const { Box, Text } = els

  return (
    <Box key="statusline" marginTop={1} columnGap={line.gap} flexWrap="nowrap">
      {line.segments.map(s => (
        <Text key={s.key} wrap="truncate-end">
          {s.runs.map((r, i) => (
            <Text key={`r${i}`} color={r.color} dimColor={r.dim} bold={r.bold}>
              {r.text}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  )
}
