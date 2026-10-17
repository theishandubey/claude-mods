export type CacheStats = {
  lastRead: number
  lastWrite: number
  lastUncached: number
  totalRead: number
  totalWrite: number
  totalUncached: number
  lastAt: number
}

export type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }

export type Measure = {
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: RateLimit[]
  cost?: { usd: number }
}

export type ModelState = { selected: string | null; selectedAt: number; answered: string | null; requested: string | null; effort: string | null; answeredRequestedAt: number }
export type ResolvedModel = { name: string; id: string; fallbackFrom: string | null; effort: string | null }
export type AgentRow = { id: string; type: string; description: string; status: string; name?: string }
export type AgentModel = { answered: string; requested: string; effort: string | null }
export type AgentActivity = {
  firstAt: number
  lastAt: number
  model: AgentModel | null
  context: number | null
  output: number
  requests: number
  tools: number
  lastTool: string | null
}
export type SubagentStats = { activity: Record<string, AgentActivity>; list: AgentRow[] }
export type GitInfo = { head: string; isDetached: boolean; isDirty: boolean; ahead: number; behind: number }
export type WorkspaceState = { cwd: string | null; home: string | null; git: GitInfo | null }

declare module 'claude-code' {
  interface PluginState {
    'meter': {
      cache: CacheStats | null
      measure: Measure | null
      now: number
      model: ModelState
      workspace: WorkspaceState
      subagents: SubagentStats
    }
  }
}
