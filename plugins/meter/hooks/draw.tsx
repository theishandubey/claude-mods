import type { Color, Elements, RenderChildren } from 'claude-code'

import type { Tone } from './format'
import { gaugeSvg } from './svg'

export type Els = Elements['terminal'] | Elements['desktop']
export type Surface = 'terminal' | 'desktop'
export type Run = { text: string; color?: Color; dim?: boolean; bold?: boolean }

export const textWidth = (s: string) => [...s].length
export const runsWidth = (runs: readonly Run[]) => runs.reduce((n, r) => n + textWidth(r.text), 0)
export const dimRun = (text: string): Run => ({ text, dim: true })
export const toneRun = (text: string, tone: Tone): Run =>
  tone === 'rest' ? { text, bold: false } : tone === 'idle' ? { text, dim: true, bold: false } : { text, color: tone, bold: true }

export const filledCells = (pct: number, cells: number) => {
  const ratio = Math.min(Math.max(pct, 0), 100) / 100

  return ratio === 0 ? 0 : Math.max(1, Math.round(ratio * cells))
}

export const gaugeRuns = (pct: number, tone: Tone, cells: number): Run[] => {
  const filled = filledCells(pct, cells)
  const runs: Run[] = []
  if (filled > 0) runs.push(toneRun('━'.repeat(filled), tone))
  if (cells - filled > 0) runs.push(dimRun('─'.repeat(cells - filled)))

  return runs
}

export const runText = (Text: Els['Text'], key: string, r: Run) => (
  <Text key={key} color={r.color} dimColor={r.dim} bold={r.bold}>
    {r.text}
  </Text>
)

export const runsText = (Text: Els['Text'], key: string, runs: readonly Run[]) =>
  runs.length === 1 ? runText(Text, key, runs[0]!) : <Text key={key}>{runs.map((r, i) => runText(Text, `r${i}`, r))}</Text>

export const drawGauge = (
  els: Els,
  surface: Surface,
  key: string,
  pct: number,
  tone: Tone,
  size: { cells: number; px: number; height?: number },
  alt: string,
): RenderChildren => {
  if (surface === 'terminal') return runsText(els.Text, key, gaugeRuns(pct, tone, size.cells))
  const { Svg } = els as Elements['desktop']
  const doc = gaugeSvg(pct, tone, alt, size.px, size.height ?? 6)

  return <Svg key={key} source={doc.source} width={doc.width} height={doc.height} alt={doc.alt} />
}
