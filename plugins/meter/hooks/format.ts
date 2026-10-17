export const SVG_COLORS: Record<'warning' | 'error', string> = { warning: '#c98a1b', error: '#d0544a' }

export const fmtTokens = (n: number) =>
  Math.round(n / 1000) >= 1000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`

export const fmtDuration = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
  return h % 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${Math.floor(h / 24)}d`
}

export const fmtCost = (usd: number) => `$${usd.toFixed(2)}`

export const fmtElapsed = (ms: number) => (ms < 60_000 ? '<1m' : fmtDuration(ms))

export type Tone = 'rest' | 'idle' | 'warning' | 'error'

export const loadTone = (pct: number): Tone => (pct >= 80 ? 'error' : pct >= 50 ? 'warning' : 'rest')
export const limitTone = (l: { percentUsed: number; resetsAt?: string }, now: number): Tone => {
  const resetIn = l.resetsAt ? Date.parse(l.resetsAt) - now : NaN

  return Number.isFinite(resetIn) && resetIn <= 0 ? 'idle' : loadTone(Math.round(l.percentUsed))
}

export const hitTone = (pct: number): Tone => (pct < 40 ? 'error' : pct < 80 ? 'warning' : 'rest')

const CACHE_TTL_MS = 60 * 60 * 1000
const CACHE_WARN_MS = 10 * 60000

export const cacheState = (lastAt: number, now: number, isWorking: boolean) => {
  const idle = Math.max(0, now - lastAt)
  const ttlLeft = CACHE_TTL_MS - idle
  const state = isWorking
    ? { dot: 'success', text: 'live', short: 'live' }
    : ttlLeft > 0
      ? { dot: ttlLeft < CACHE_WARN_MS ? 'warning' : 'success', text: `warm ${fmtDuration(ttlLeft)}`, short: fmtDuration(ttlLeft) }
      : { dot: 'error', text: 'cold', short: 'cold' }

  return { idle, ttlLeft, ...state }
}

export const hitRate = (read: number, write: number, uncached: number) => {
  const total = read + write + uncached
  return total === 0 ? null : Math.round((read / total) * 100)
}

export const limitLabel = (kind: string) =>
  kind === 'five_hour' ? '5h' : kind === 'seven_day' ? 'Week' : kind === 'spend_limit' ? 'Spend' : kind

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g

export const clean = (s: string) => {
  const cut = s.replace(CONTROL, ' ').slice(0, 200)
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}

export const shortId = (id: string) => (id.length > 20 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id)
