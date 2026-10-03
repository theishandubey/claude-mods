export type CacheStats = {
  lastRead: number
  lastWrite: number
  lastUncached: number
  totalRead: number
  totalWrite: number
  totalUncached: number
  lastAt: number
  model: string
}

export type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }

export type Measure = {
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: RateLimit[]
  cost?: { usd: number }
}

export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }
export type Totals = Tokens & { requests: number }
export type RequestSample = { at: number; ms: number; hit: number | null; output: number }
export type RequestStats = {
  trackedSince: number
  main: Totals
  agents: Totals
  byModel: Record<string, Totals>
  noResponse: number
  history: RequestSample[]
  lastModel: string | null
  requestedModel: string | null
  effort: string | null
  messageCount: number
}
export type TurnReason = 'answer' | 'aborted' | 'refusal' | 'error'
export type TurnStats = {
  count: number
  totalMs: number
  longestMs: number
  aborted: number
  errored: number
  refused: number
  recent: { at: number; ms: number; reason: TurnReason }[]
}
export type ToolStat = { calls: number; errors: number; denied: number; totalMs: number; fromAgents: number }
export type AgentUsage = Totals & { model: string; lastAt: number }
export type AgentRow = { id: string; type: string; description: string; status: string; name?: string }
export type AgentStats = { usage: Record<string, AgentUsage>; list: AgentRow[] }
export type Compaction = { at: number; trigger: 'manual' | 'auto' | 'plugin'; before?: number; after?: number }
export type CompactionStats = { count: number; subagentCount: number; recent: Compaction[] }
export type LimitSample = { at: number; pct: number; resetsAt?: string }
export type Trends = { cost: { at: number; usd: number }[]; limits: Record<string, LimitSample[]> }
export type SnapCategory = { name: string; tokens: number; color: string; kind: 'used' | 'free' | 'buffer' | 'deferred' }
export type SnapSquare = { category: string; color: string; kind: SnapCategory['kind']; fullness: number }
export type BreakdownSnap = {
  at: number
  detail: 'full' | 'summary'
  contextTokens?: number
  totalTokens: number
  rawMaxTokens: number
  percentage: number
  autocompactSource: string
  autoCompactThreshold?: number
  isAutoCompactEnabled: boolean
  model: string
  categories: SnapCategory[]
  squares: SnapSquare[]
  memoryFiles: { path: string; type: string; tokens: number }[]
  memoryTotal: { count: number; tokens: number }
  mcpServers: { server: string; tools: number; loaded: number; tokens: number }[]
  skills?: { total: number; included: number; tokens: number; top: { name: string; tokens: number }[] }
  agents: { agentType: string; tokens: number }[]
  slashCommands?: { total: number; included: number; tokens: number }
}
export type BreakdownStatus = { state: 'idle' } | { state: 'loading'; since: number } | { state: 'error' }
export type BreakdownState = { snap: BreakdownSnap | null; status: BreakdownStatus }
export type SessionInfo = {
  id: string
  version: string
  builtAt?: string
  model: string
  startedAt: number
  prompts: number
  cwd: string
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'meter': {
      cache: CacheStats | null
      measure: Measure | null
      now: number
      requests: RequestStats
      turns: TurnStats
      tools: Record<string, ToolStat>
      agents: AgentStats
      compactions: CompactionStats
      trends: Trends
      breakdown: BreakdownState
      info: SessionInfo | null
      expanded: string[]
      epoch: number
    }
  }
}
