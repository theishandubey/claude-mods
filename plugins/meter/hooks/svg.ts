import type { SnapCategory, SnapSquare } from '../types'
import { SVG_COLORS, type Tone } from './format'

export type SvgDoc = { source: string; width: number; height: number; alt: string }

const LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948']
const DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767']
const NEUTRAL = 'rgba(128,128,128,0.28)'
const IDLE_FILL = 'rgba(128,128,128,0.6)'
const SQUARE = 10
const GAP = 3
const BAR = 4
const BAR_GAP = 2
const BAR_HEIGHT = 20

const PALETTE_SLOTS = LIGHT.length

const PALETTE_STYLE = `<style>${LIGHT.map((c, i) => `.s${i + 1}{fill:${c}}`).join('')}@media (prefers-color-scheme: dark){${DARK.map((c, i) => `.s${i + 1}{fill:${c}}`).join('')}}</style>`

let memo: { key: string; value: unknown } | undefined

export const memoized = <T>(key: string, build: () => T): T => {
  if (memo?.key === key) return memo.value as T
  const value = build()
  memo = { key, value }

  return value
}

const wrap = (width: number, height: number, body: string, hasPalette: boolean): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${hasPalette ? PALETTE_STYLE : ''}${body}</svg>`

export const slotMap = (categories: readonly SnapCategory[]) => {
  const slots: Record<string, number> = {}
  let next = 1
  for (const c of categories) {
    if (c.kind !== 'used') continue
    slots[c.name] = next <= PALETTE_SLOTS ? next++ : 0
  }

  return slots
}

const toneFill = (tone: Tone) =>
  tone === 'rest' ? ' class="s1"' : tone === 'idle' ? ` fill="${IDLE_FILL}"` : ` fill="${SVG_COLORS[tone]}"`

export const gaugeSvg = (pct: number, tone: Tone, alt: string, width = 160, height = 6): SvgDoc => {
  const ratio = Math.min(Math.max(pct, 0), 100) / 100
  const fill = ratio === 0 ? 0 : Math.max(3, Math.round(ratio * width))
  const rx = height / 2
  const body = `<rect width="${width}" height="${height}" rx="${rx}" fill="${NEUTRAL}"/><rect width="${fill}" height="${height}" rx="${rx}"${toneFill(tone)}/>`

  return { source: wrap(width, height, body, tone === 'rest'), width, height, alt }
}

const squareClass = (slot: number | undefined) => (slot ? ` class="s${slot}"` : ` fill="${NEUTRAL}"`)

export const gridSvg = (
  squares: readonly SnapSquare[],
  perRow: number,
  slots: Record<string, number>,
  alt: string,
): SvgDoc => {
  const rows = Math.ceil(squares.length / perRow)
  const width = perRow * (SQUARE + GAP) - GAP
  const height = rows * (SQUARE + GAP) - GAP
  const body = squares
    .map((q, i) => {
      const x = (i % perRow) * (SQUARE + GAP)
      const y = Math.floor(i / perRow) * (SQUARE + GAP)
      const slot = q.kind === 'used' ? slots[q.category] : undefined
      const opacity = q.kind === 'used' && q.fullness < 0.7 ? ' fill-opacity="0.45"' : ''

      return `<rect x="${x}" y="${y}" width="${SQUARE}" height="${SQUARE}" rx="2"${squareClass(slot)}${opacity}/>`
    })
    .join('')

  return { source: wrap(width, height, body, true), width, height, alt }
}

export const swatchSvg = (slot: number | undefined, alt: string): SvgDoc => {
  const body = `<rect width="${SQUARE}" height="${SQUARE}" rx="2"${squareClass(slot)}/>`

  return { source: wrap(SQUARE, SQUARE, body, Boolean(slot)), width: SQUARE, height: SQUARE, alt }
}

export const barsSvg = (
  values: readonly number[],
  max: number,
  tones: readonly (Tone | undefined)[] | undefined,
  alt: string,
): SvgDoc => {
  const width = Math.max(1, values.length * (BAR + BAR_GAP) - BAR_GAP)
  const toneAt = (i: number): Tone => tones?.[i] ?? 'rest'
  const body = values
    .map((v, i) => {
      const h = max <= 0 ? 2 : Math.min(BAR_HEIGHT, Math.max(2, Math.round((v / max) * BAR_HEIGHT)))

      return `<rect x="${i * (BAR + BAR_GAP)}" y="${BAR_HEIGHT - h}" width="${BAR}" height="${h}" rx="1"${toneFill(toneAt(i))}/>`
    })
    .join('')

  return { source: wrap(width, BAR_HEIGHT, body, values.some((_, i) => toneAt(i) === 'rest')), width, height: BAR_HEIGHT, alt }
}
