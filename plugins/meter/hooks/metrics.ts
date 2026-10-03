import type { SessionContextBreakdown } from 'claude-code'

import type {
  AgentStats,
  BreakdownSnap,
  CompactionStats,
  LimitSample,
  RateLimit,
  RequestStats,
  ToolStat,
  Totals,
  Trends,
  TurnReason,
  TurnStats,
} from '../types'
import { clean, hitRate, pushCapped } from './format'

const HISTORY_MAX = 60
const TURNS_MAX = 30
const COST_MAX = 40
const LIMIT_SAMPLES_MAX = 24
const COMPACTIONS_MAX = 10
const TOOLS_MAX = 40
const AGENTS_MAX = 50
const MODELS_MAX = 8
const SNAP_MEMORY_MAX = 20
const SNAP_MCP_MAX = 20
const SNAP_SKILLS_MAX = 15
const SNAP_AGENTS_MAX = 15
const PACE_MIN_SPAN_MS = 60_000
const OTHER = '(other)'

export type StepUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  model: string
}

export type StepInput = {
  at: number
  ms: number
  usage: StepUsage | null
  requested: string
  effort: string | null
  messageCount: number
  isAgent: boolean
}

const ZERO: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 }

const addTotals = (t: Totals, u: StepUsage): Totals => ({
  input: t.input + u.input_tokens,
  output: t.output + u.output_tokens,
  cacheRead: t.cacheRead + u.cache_read_input_tokens,
  cacheWrite: t.cacheWrite + u.cache_creation_input_tokens,
  requests: t.requests + 1,
})

const addModel = (byModel: Record<string, Totals>, model: string, u: StepUsage) => {
  const key = model in byModel || Object.keys(byModel).length < MODELS_MAX ? model : OTHER

  return { ...byModel, [key]: addTotals(byModel[key] ?? ZERO, u) }
}

export const addStep = (r: RequestStats, s: StepInput): RequestStats => {
  if (!s.usage) return s.isAgent ? r : { ...r, noResponse: r.noResponse + 1 }
  const model = clean(s.usage.model)
  const byModel = addModel(r.byModel, model, s.usage)
  if (s.isAgent) return { ...r, agents: addTotals(r.agents, s.usage), byModel }

  return {
    ...r,
    main: addTotals(r.main, s.usage),
    byModel,
    lastModel: model,
    requestedModel: clean(s.requested),
    effort: s.effort,
    messageCount: s.messageCount,
    history: pushCapped(
      r.history,
      {
        at: s.at,
        ms: s.ms,
        hit: hitRate(s.usage.cache_read_input_tokens, s.usage.cache_creation_input_tokens, s.usage.input_tokens),
        output: s.usage.output_tokens,
      },
      HISTORY_MAX,
    ),
  }
}

export const addAgentStep = (a: AgentStats, agentId: string, u: StepUsage, at: number): AgentStats => {
  const id = clean(agentId)
  const prev = a.usage[id]
  const usage = {
    ...a.usage,
    [id]: { ...addTotals(prev ?? ZERO, u), model: clean(u.model), lastAt: at },
  }
  const ids = Object.keys(usage)
  if (ids.length > AGENTS_MAX) {
    const oldest = ids.reduce((m, k) => (usage[k]!.lastAt < usage[m]!.lastAt ? k : m))
    delete usage[oldest]
  }

  return { ...a, usage }
}

export const addTurn = (t: TurnStats, at: number, ms: number, reason: TurnReason): TurnStats => ({
  count: t.count + 1,
  totalMs: t.totalMs + ms,
  longestMs: Math.max(t.longestMs, ms),
  aborted: t.aborted + (reason === 'aborted' ? 1 : 0),
  errored: t.errored + (reason === 'error' ? 1 : 0),
  refused: t.refused + (reason === 'refusal' ? 1 : 0),
  recent: pushCapped(t.recent, { at, ms, reason }, TURNS_MAX),
})

export type ToolOutcome = { isDenied: boolean; isError: boolean; ms: number; isFromAgent: boolean }

export const addTool = (tools: Record<string, ToolStat>, tool: string, o: ToolOutcome): Record<string, ToolStat> => {
  const name = clean(tool)
  const key = name in tools || Object.keys(tools).length < TOOLS_MAX ? name : OTHER
  const prev = tools[key] ?? { calls: 0, errors: 0, denied: 0, totalMs: 0, fromAgents: 0 }

  return {
    ...tools,
    [key]: {
      calls: prev.calls + 1,
      errors: prev.errors + (o.isError ? 1 : 0),
      denied: prev.denied + (o.isDenied ? 1 : 0),
      totalMs: prev.totalMs + o.ms,
      fromAgents: prev.fromAgents + (o.isFromAgent ? 1 : 0),
    },
  }
}

export type CompactionInput = {
  at: number
  trigger: 'manual' | 'auto' | 'plugin'
  before?: number
  after?: number
  isSubagent: boolean
}

export const addCompaction = (c: CompactionStats, o: CompactionInput): CompactionStats =>
  o.isSubagent
    ? { ...c, subagentCount: c.subagentCount + 1 }
    : {
        ...c,
        count: c.count + 1,
        recent: pushCapped(c.recent, { at: o.at, trigger: o.trigger, before: o.before, after: o.after }, COMPACTIONS_MAX),
      }

export const addCost = (t: Trends, at: number, usd: number): Trends => ({
  ...t,
  cost: pushCapped(t.cost, { at, usd }, COST_MAX),
})

export const addLimitSamples = (t: Trends, at: number, limits: readonly RateLimit[]): Trends => {
  const next = { ...t.limits }
  for (const l of limits) {
    const kind = clean(l.kind)
    let samples = next[kind] ?? []
    const last = samples.at(-1)
    if (last && last.resetsAt !== l.resetsAt) samples = []
    if (samples.at(-1)?.pct === l.percentUsed) continue
    const sample: LimitSample = { at, pct: l.percentUsed, resetsAt: l.resetsAt }
    next[kind] = pushCapped(samples, sample, LIMIT_SAMPLES_MAX)
  }

  return { ...t, limits: next }
}

export const pace = (samples: readonly LimitSample[], now: number) => {
  const first = samples[0]
  const last = samples.at(-1)
  if (!first || !last || first === last) return null
  const span = last.at - first.at
  const gain = last.pct - first.pct
  if (span < PACE_MIN_SPAN_MS || gain <= 0) return null

  const elapsed = Math.max(now, last.at) - first.at

  return { msTo100: ((100 - last.pct) / gain) * elapsed }
}

const top = <T>(items: readonly T[], by: (item: T) => number, max: number) =>
  [...items].sort((a, b) => by(b) - by(a)).slice(0, max)

export const toSnap = (
  b: SessionContextBreakdown,
  contextTokens: number | undefined,
  at: number,
  detail: 'full' | 'summary',
): BreakdownSnap => {
  const kinds = new Map(b.categories.map(c => [c.name, c.kind]))
  const servers = new Map<string, { tools: number; loaded: number; tokens: number }>()
  for (const t of b.mcpTools) {
    const name = clean(t.serverName)
    const s = servers.get(name) ?? { tools: 0, loaded: 0, tokens: 0 }
    servers.set(name, { tools: s.tools + 1, loaded: s.loaded + (t.isLoaded ? 1 : 0), tokens: s.tokens + t.tokens })
  }

  return {
    at,
    detail,
    contextTokens,
    totalTokens: b.totalTokens,
    rawMaxTokens: b.rawMaxTokens,
    percentage: b.percentage,
    autocompactSource: clean(b.autocompactSource),
    autoCompactThreshold: b.autoCompactThreshold,
    isAutoCompactEnabled: b.isAutoCompactEnabled,
    model: clean(b.model),
    categories: b.categories.map(c => ({ name: clean(c.name), tokens: c.tokens, color: clean(c.color), kind: c.kind })),
    squares: b.gridRows.flat().map(q => ({
      category: clean(q.categoryName),
      color: clean(q.color),
      kind: kinds.get(q.categoryName) ?? 'used',
      fullness: q.squareFullness,
    })),
    memoryFiles: top(b.memoryFiles, f => f.tokens, SNAP_MEMORY_MAX).map(f => ({
      path: clean(f.path),
      type: clean(f.type),
      tokens: f.tokens,
    })),
    memoryTotal: { count: b.memoryFiles.length, tokens: b.memoryFiles.reduce((n, f) => n + f.tokens, 0) },
    mcpServers: top([...servers], ([, s]) => s.tokens, SNAP_MCP_MAX).map(([server, s]) => ({ server, ...s })),
    skills: b.skills && {
      total: b.skills.totalSkills,
      included: b.skills.includedSkills,
      tokens: b.skills.tokens,
      top: top(b.skills.skillFrontmatter, s => s.tokens, SNAP_SKILLS_MAX).map(s => ({ name: clean(s.name), tokens: s.tokens })),
    },
    agents: top(b.agents, a => a.tokens, SNAP_AGENTS_MAX).map(a => ({ agentType: clean(a.agentType), tokens: a.tokens })),
    slashCommands: b.slashCommands && {
      total: b.slashCommands.totalCommands,
      included: b.slashCommands.includedCommands,
      tokens: b.slashCommands.tokens,
    },
  }
}
