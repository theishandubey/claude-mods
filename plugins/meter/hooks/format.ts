export const SVG_COLORS: Record<string, string> = { success: '#409524', warning: '#c98a1b', error: '#d0544a' }

export const fmtTokens = (n: number) =>
  Math.round(n / 1000) >= 1000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`

export const fmtTokens1 = (n: number) =>
  Math.round(n / 100) >= 10_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`

export const fmtDuration = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
  return h % 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${Math.floor(h / 24)}d`
}

export const loadColor = (pct: number) => (pct >= 80 ? 'error' : pct >= 50 ? 'warning' : 'success')
export const hitColor = (pct: number) => (pct >= 80 ? 'success' : pct >= 40 ? 'warning' : 'error')

export const hitRate = (read: number, write: number, uncached: number) => {
  const total = read + write + uncached
  return total === 0 ? null : Math.round((read / total) * 100)
}

export const limitLabel = (kind: string) =>
  kind === 'five_hour' ? '5h' : kind === 'seven_day' ? 'Week' : kind === 'spend_limit' ? 'Spend' : kind

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g
const SPARK = '▁▂▃▄▅▆▇█'
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export const clean = (s: string) => {
  const cut = s.replace(CONTROL, ' ').slice(0, 200)
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}

export const pushCapped = <T>(arr: readonly T[], item: T, max: number): T[] => [...arr, item].slice(-max)

export const sparkGlyphs = (values: readonly number[], max: number) =>
  values.map(v => (max <= 0 ? SPARK[0]! : SPARK[Math.min(7, Math.max(0, Math.round((v / max) * 7)))]!))

const pad2 = (n: number) => String(n).padStart(2, '0')

export const fmtClock = (ms: number, withDay = false) => {
  const d = new Date(ms)
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  return withDay ? `${DAYS[d.getDay()]} ${time}` : time
}

export const fmtDate = (ms: number) => {
  const d = new Date(ms)
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`
}

export const fmtMs = (ms: number) => {
  if (ms < 100) return `${Math.round(ms)}ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return s % 60 ? `${m}m ${s % 60}s` : `${m}m`
}

export const fmtAgo = (ms: number) => (ms < 60_000 ? 'just now' : `${fmtDuration(ms)} ago`)

export const modelName = (id: string) => {
  const m = /^(?:claude-)?(opus|sonnet|haiku|fable)-(\d+)-(\d+)/.exec(id)
  return m ? `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]}.${m[3]}` : id
}

export const modelId = (id: string) => id.replace(/^claude-/, '')

export const baseModel = (id: string) => id.replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '')

export const shortId = (id: string) => (id.length > 20 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id)
