import { SVG_COLORS, type Tone } from './format'

export type SvgDoc = { source: string; width: number; height: number; alt: string }

const NEUTRAL = 'rgba(128,128,128,0.28)'
const IDLE_FILL = 'rgba(128,128,128,0.6)'
const PALETTE_STYLE = '<style>.s1{fill:#2a78d6}@media (prefers-color-scheme: dark){.s1{fill:#3987e5}}</style>'

const wrap = (width: number, height: number, body: string, hasPalette: boolean): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${hasPalette ? PALETTE_STYLE : ''}${body}</svg>`

const toneFill = (tone: Tone) =>
  tone === 'rest' ? ' class="s1"' : tone === 'idle' ? ` fill="${IDLE_FILL}"` : ` fill="${SVG_COLORS[tone]}"`

export const gaugeSvg = (pct: number, tone: Tone, alt: string, width = 160, height = 6): SvgDoc => {
  const ratio = Math.min(Math.max(pct, 0), 100) / 100
  const fill = ratio === 0 ? 0 : Math.max(3, Math.round(ratio * width))
  const rx = height / 2
  const body = `<rect width="${width}" height="${height}" rx="${rx}" fill="${NEUTRAL}"/><rect width="${fill}" height="${height}" rx="${rx}"${toneFill(tone)}/>`

  return { source: wrap(width, height, body, tone === 'rest'), width, height, alt }
}
