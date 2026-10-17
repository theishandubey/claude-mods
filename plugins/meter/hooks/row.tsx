import type { RenderElement } from 'claude-code'

import type { ResolvedModel } from '../types'
import { type Els, type Run, runText, runsWidth, textWidth } from './draw'

export type Segment = { key: string; runs: Run[] }
export type Row = { segments: Segment[]; gap: number }

export const cut = (s: string, max: number) => (textWidth(s) <= max ? s : `${[...s].slice(0, max - 1).join('')}…`)

export const levelsFrom = <L,>(full: L, steps: readonly Partial<L>[]): L[] =>
  steps.reduce<L[]>((levels, step) => [...levels, { ...(levels.at(-1) ?? full), ...step }], [])

const rowWidth = (segments: readonly Segment[], gap: number) =>
  segments.reduce((n, s) => n + runsWidth(s.runs), 0) + gap * Math.max(0, segments.length - 1)

export const fitRow = <L extends { gap: number }>(levels: readonly L[], build: (level: L) => Segment[], columns: number): Row => {
  for (const level of levels) {
    const segments = build(level)
    if (rowWidth(segments, level.gap) <= columns) return { segments, gap: level.gap }
  }
  const floor = levels.at(-1)!

  return { segments: build(floor), gap: floor.gap }
}

export const modelRuns = (model: ResolvedModel, o: { isBold: boolean; effort: boolean; fallbackFrom: boolean }): Run[] => {
  const bold = o.isBold ? { bold: true } : {}
  if (model.fallbackFrom !== null) {
    return [
      { text: model.name, color: 'warning', ...bold },
      { text: o.fallbackFrom ? ` fallback from ${model.fallbackFrom}` : ' fallback', dim: true },
    ]
  }
  const runs: Run[] = [{ text: model.name, ...bold }]
  if (o.effort && model.effort !== null && model.effort !== '') runs.push({ text: ` ${model.effort}`, dim: true })

  return runs
}

export const drawRow = (els: Els, key: string, row: Row, flexWrap: 'wrap' | 'nowrap', box: { marginTop?: number; paddingLeft?: number } = {}): RenderElement => {
  const { Box, Text } = els

  return (
    <Box key={key} marginTop={box.marginTop} paddingLeft={box.paddingLeft} columnGap={row.gap} flexWrap={flexWrap}>
      {row.segments.map(s => (
        <Text key={s.key} wrap="truncate-end">
          {s.runs.map((r, i) => runText(Text, `r${i}`, r))}
        </Text>
      ))}
    </Box>
  )
}
