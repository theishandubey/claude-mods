export type AgentRow = {
  id: string
  type: string
  description: string
  status: string
  parentId?: string
  name?: string
}

export type Activity = {
  tool?: string
  steps: number
  outputTokens: number
  input: number
  cacheRead: number
  cacheWrite: number
  lastContext?: number
  lastModel?: string
  lastCacheHit?: number
  costUsd?: number
  costPartial?: boolean
  firstSeen: number
  lastSeen: number
  runStart?: number
  endedAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    'agent-graph': {
      agents: AgentRow[]
      activity: Record<string, Activity>
      now: number
      autoOpened: boolean
      mainWorking: boolean
    }
  }
}
