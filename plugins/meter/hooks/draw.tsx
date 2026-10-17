import type { Color, Elements } from 'claude-code'

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

export const runText = (Text: Els['Text'], key: string, r: Run) => (
  <Text key={key} color={r.color} dimColor={r.dim} bold={r.bold}>
    {r.text}
  </Text>
)

export const runsText = (Text: Els['Text'], key: string, runs: readonly Run[]) =>
  runs.length === 1 ? runText(Text, key, runs[0]!) : <Text key={key}>{runs.map((r, i) => runText(Text, `r${i}`, r))}</Text>

export const drawGauge = (Svg: Elements['desktop']['Svg'], key: string, pct: number, tone: Tone, px: number, alt: string, height = 6) => {
  const doc = gaugeSvg(pct, tone, alt, px, height)

  return <Svg key={key} source={doc.source} width={doc.width} height={doc.height} alt={doc.alt} />
}
