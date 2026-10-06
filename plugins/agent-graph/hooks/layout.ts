import type { Activity, AgentRow } from '../types'
import { modelLabel } from './model'
import { windowFor } from './pricing'

export const MAIN = 'main'
export const RECENT_MS = 2 * 60 * 1000

export type Tone = 'ok' | 'warn' | 'hot'

export type NodeParts = {
  elapsed?: string
  steps?: number
  tokens?: string
  ctxTokens?: string
  cacheHit?: string
  cost?: string
}

export type GraphNode = {
  id: string
  title: string
  status: 'running' | 'done' | 'failed' | 'idle'
  description: string
  activity: string
  meta: string
  ctx: string
  ctxPct?: number
  ctxTone: Tone
  model?: string
  extras: string[]
  parts: NodeParts
  depth: number
  slot: number
  children: GraphNode[]
}

export const blankActivity = (now: number): Activity => ({
  steps: 0,
  outputTokens: 0,
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  firstSeen: now,
  lastSeen: now,
})

export const statusOf = (s: string): GraphNode['status'] =>
  s === 'running' || s === 'pending' ? 'running' : s === 'completed' ? 'done' : s === 'failed' ? 'failed' : 'idle'

export const fmtElapsed = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

export const sanitize = (s: string) =>
  s
    .replace(/[\t\n\r]+/g, ' ')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '')

const basename = (p: string) => p.split('/').filter(Boolean).pop() ?? p

export const summarizeTool = (e: Record<string, unknown>) => {
  const str = (k: string) => (typeof e[k] === 'string' ? (e[k] as string) : '')
  const tool = str('tool')
  const arg =
    tool === 'Agent' || tool === 'Task'
      ? str('subagent_type') || str('description')
      : str('file_path')
        ? basename(str('file_path'))
        : str('command').split('\n')[0] || str('pattern') || str('url') || str('query') || str('description')
  return arg ? `${tool} ${arg}` : tool
}

const fmtTokens = (n: number) => {
  if (n < 1000) return `${n}`
  if (Math.round(n / 100) < 100) return `${(n / 1000).toFixed(1)}k`
  const k = Math.round(n / 1000)

  return k < 1000 ? `${k}k` : `${(n / 1_000_000).toFixed(1)}M`
}

const partsOf = (status: GraphNode['status'], act: Activity | undefined, now: number, withElapsed: boolean): NodeParts => {
  const start = act?.runStart ?? act?.firstSeen ?? now
  const end = status === 'running' ? now : (act?.endedAt ?? now)
  const replied = act?.lastContext === undefined ? undefined : act
  return {
    elapsed: withElapsed ? fmtElapsed(end - start) : undefined,
    steps: act?.steps ? act.steps : undefined,
    tokens: act?.outputTokens ? fmtTokens(act.outputTokens) : undefined,
    ctxTokens: replied ? fmtTokens(replied.lastContext ?? 0) : undefined,
    cacheHit: replied?.lastCacheHit === undefined ? undefined : `${Math.round(replied.lastCacheHit * 100)}%`,
    cost: replied?.costUsd === undefined ? undefined : fmtCost(replied.costUsd, replied.costPartial === true),
  }
}

const metaOf = (p: NodeParts) =>
  sanitize(
    [p.elapsed ?? '', p.steps ? `${p.steps} ${p.steps === 1 ? 'step' : 'steps'}` : '', p.tokens ? `${p.tokens} tok` : '']
      .filter(Boolean)
      .join(' · '),
  )

export const toneOf = (pct: number): Tone => (pct >= 80 ? 'hot' : pct >= 50 ? 'warn' : 'ok')

const fmtCost = (usd: number, isPartial: boolean) =>
  `${usd > 0 && usd < 0.01 ? '<$0.01' : `~$${usd.toFixed(2)}`}${isPartial ? '+' : ''}`

const metricsOf = (act: Activity | undefined, p: NodeParts) => {
  if (p.ctxTokens === undefined) return { ctx: 'waiting for first reply', ctxPct: undefined, ctxTone: 'ok' as Tone, extras: [] }
  const window = act?.lastModel === undefined ? undefined : windowFor(act.lastModel)
  const ctxPct = window ? Math.min(100, Math.max(0, ((act?.lastContext ?? 0) / window) * 100)) : undefined
  const ctx = `ctx ${p.ctxTokens}${ctxPct === undefined ? '' : ` · ${Math.round(ctxPct)}%`}`
  const extras = [p.cacheHit === undefined ? '' : `cache ${p.cacheHit}`, p.cost ?? ''].filter(Boolean)
  return { ctx: sanitize(ctx), ctxPct, ctxTone: toneOf(ctxPct ?? 0), extras: extras.map(sanitize) }
}

export const visibleAgents = (agents: AgentRow[], activity: Record<string, Activity>, now: number) => {
  const byId = new Map(agents.map(a => [a.id, a]))
  const keep = new Set<string>()
  for (const a of agents) {
    const ended = activity[a.id]?.endedAt
    const isLive = statusOf(a.status) === 'running'
    const isRecent = ended !== undefined && now - ended < RECENT_MS
    if (!isLive && !isRecent) continue
    let cur: AgentRow | undefined = a
    while (cur && !keep.has(cur.id)) {
      keep.add(cur.id)
      cur = cur.parentId ? byId.get(cur.parentId) : undefined
    }
  }
  return agents.filter(a => keep.has(a.id))
}

export const capAgents = (shown: AgentRow[], activity: Record<string, Activity>, max: number) => {
  if (shown.length <= max) return { agents: shown, hidden: 0 }
  const isLive = (a: AgentRow) => statusOf(a.status) === 'running'
  const endedAt = (a: AgentRow) => activity[a.id]?.endedAt ?? 0
  const byId = new Map(shown.map(a => [a.id, a]))
  const keep = new Set<string>()
  const ranked = [...shown].sort((a, b) => Number(isLive(b)) - Number(isLive(a)) || endedAt(b) - endedAt(a))
  for (const a of ranked) {
    const chain: string[] = []
    let cur: AgentRow | undefined = a
    while (cur && !keep.has(cur.id) && !chain.includes(cur.id)) {
      chain.push(cur.id)
      cur = cur.parentId ? byId.get(cur.parentId) : undefined
    }
    if (keep.size + chain.length <= max) for (const id of chain) keep.add(id)
  }

  return { agents: shown.filter(a => keep.has(a.id)), hidden: shown.length - keep.size }
}

export const buildGraph = (
  agents: AgentRow[],
  activity: Record<string, Activity>,
  now: number,
  isMainWorking: boolean,
): { root: GraphNode; slots: number; depth: number } => {
  const known = new Set(agents.map(a => a.id))
  const childrenOf = new Map<string, AgentRow[]>()
  for (const a of agents) {
    const parent = a.parentId && known.has(a.parentId) ? a.parentId : MAIN
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), a])
  }

  let nextSlot = 0
  let maxDepth = 0
  const make = (row: AgentRow | null, depth: number): GraphNode => {
    const id = row?.id ?? MAIN
    const act = activity[id]
    maxDepth = Math.max(maxDepth, depth)
    const kids = childrenOf.get(id) ?? []
    const slot = nextSlot
    const children = kids.map(k => make(k, depth + 1))
    if (children.length === 0) nextSlot += 1
    const status = row ? statusOf(row.status) : isMainWorking ? 'running' : 'idle'
    const parts = partsOf(status, act, now, row !== null)
    return {
      id,
      title: row ? sanitize(row.name ?? row.type) : 'Main',
      status,
      description: row ? sanitize(row.description) : '',
      activity: sanitize(act?.tool ?? ''),
      meta: metaOf(parts),
      model: modelLabel(act?.lastModel === undefined ? undefined : sanitize(act.lastModel)),
      parts,
      ...metricsOf(act, parts),
      depth,
      slot,
      children,
    }
  }
  const root = make(null, 0)
  return { root, slots: Math.max(1, nextSlot), depth: maxDepth }
}

export const walk = (n: GraphNode, fn: (n: GraphNode, parent?: GraphNode) => void, parent?: GraphNode) => {
  fn(n, parent)
  for (const c of n.children) walk(c, fn, n)
}

export const truncate = (s: string, max: number) => {
  const chars = [...s]
  if (chars.length <= max) return s
  return max <= 1 ? chars.slice(0, max).join('') : `${chars.slice(0, max - 1).join('')}…`
}
