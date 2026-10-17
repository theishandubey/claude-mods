import type { AgentInfo } from 'claude-code'

import type { AgentActivity, AgentRow, SubagentStats } from '../types'
import { clean } from './format'

export type StepUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  model: string
}
export type AgentStep = { usage: StepUsage; requested: string; effort: string | null; startedAt: number; at: number }
export type AgentView = { id: string; row: AgentRow | null; activity: AgentActivity | null }

const ACTIVITY_MAX = 50
const LIST_MAX = 50

export const EMPTY_SUBAGENTS: SubagentStats = { activity: {}, list: [] }

const blank = (at: number): AgentActivity => ({
  firstAt: at,
  lastAt: at,
  model: null,
  context: null,
  output: 0,
  requests: 0,
  tools: 0,
  lastTool: null,
})

const touch = (
  s: SubagentStats,
  agentId: string,
  startedAt: number,
  at: number,
  fn: (a: AgentActivity) => AgentActivity,
): SubagentStats => {
  const id = clean(agentId)
  const activity = { ...s.activity, [id]: { ...fn(s.activity[id] ?? blank(startedAt)), lastAt: at } }
  const ids = Object.keys(activity)
  if (ids.length > ACTIVITY_MAX) {
    const oldest = ids.reduce((m, k) => (activity[k]!.lastAt < activity[m]!.lastAt ? k : m))
    delete activity[oldest]
  }

  return { ...s, activity }
}

export const addAgentStep = (s: SubagentStats, agentId: string, step: AgentStep): SubagentStats =>
  touch(s, agentId, step.startedAt, step.at, a => ({
    ...a,
    model: { answered: clean(step.usage.model), requested: clean(step.requested), effort: step.effort === null ? null : clean(step.effort) },
    context: step.usage.input_tokens + step.usage.cache_read_input_tokens + step.usage.cache_creation_input_tokens,
    output: a.output + step.usage.output_tokens,
    requests: a.requests + 1,
  }))

export const addAgentTool = (s: SubagentStats, agentId: string, tool: string, startedAt: number, at: number): SubagentStats =>
  touch(s, agentId, startedAt, at, a => ({ ...a, tools: a.tools + 1, lastTool: clean(tool) }))

export const toAgentRow = (row: AgentInfo): AgentRow => ({
  id: clean(row.id),
  type: clean(row.type),
  description: clean(row.description),
  status: clean(row.status),
  ...(row.name !== undefined && { name: clean(row.name) }),
})

export const mergeAgentRows = (prev: readonly AgentRow[], fresh: readonly AgentRow[]): AgentRow[] => {
  const ids = new Set(fresh.map(r => r.id))

  return [...prev.filter(r => !ids.has(r.id)), ...fresh].slice(-LIST_MAX)
}

export const ENDED = new Set(['completed', 'failed', 'killed'])

export const agentView = (agentId: string, live: readonly AgentInfo[] | null, s: SubagentStats): AgentView => {
  const id = clean(agentId)
  const fromLive = live?.find(r => clean(r.id) === id)
  const stored = s.list.find(r => r.id === id)
  const row = fromLive
    ? toAgentRow(fromLive)
    : stored && live !== null && !ENDED.has(stored.status)
      ? { ...stored, status: 'completed' }
      : (stored ?? null)

  return { id, row, activity: s.activity[id] ?? null }
}
