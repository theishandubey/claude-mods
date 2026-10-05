import type { Activity } from '../types'

export type Price = { input: number; output: number; cacheRead: number; cacheWrite: number }

export type RequestUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  model: string
}

const FABLE_5: Price = { input: 10, output: 50, cacheRead: 1, cacheWrite: 20 }
const FABLE: Price = { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 20 }
const SONNET: Price = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 4 }

const MODELS: Record<string, { price: Price; window: number }> = {
  'claude-fable-5': { price: FABLE_5, window: 1_000_000 },
  'claude-fable-5-1': { price: FABLE, window: 1_000_000 },
  'claude-mythos-5-1': { price: FABLE, window: 1_000_000 },
  'claude-opus-5': { price: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 10 }, window: 1_000_000 },
  'claude-opus-5-5': { price: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 8 }, window: 1_000_000 },
  'claude-sonnet-5': { price: SONNET, window: 1_000_000 },
  'claude-sonnet-5-5': { price: SONNET, window: 1_000_000 },
  'claude-haiku-4-5': { price: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 2 }, window: 200_000 },
}

const SUFFIX = /(?:-\d{8})?(?:[@[].*)?$/s

export const baseId = (model: string) => model.replace(SUFFIX, '')

const entryFor = (model: string) => MODELS[baseId(model)]

export const priceFor = (model: string): Price | undefined => entryFor(model)?.price

export const windowFor = (model: string): number | undefined =>
  model.includes('[1m]') ? 1_000_000 : entryFor(model)?.window

export const requestCost = (u: RequestUsage): number | undefined => {
  const p = priceFor(u.model)
  if (!p) return undefined
  // The engine does not report the cache TTL of a write, so it is priced at the 1-hour rate.
  return (
    (u.input_tokens * p.input +
      u.output_tokens * p.output +
      u.cache_read_input_tokens * p.cacheRead +
      u.cache_creation_input_tokens * p.cacheWrite) /
    1e6
  )
}

export const withUsage = (a: Activity, u: RequestUsage): Activity => {
  const cost = requestCost(u)
  const prompt = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
  return {
    ...a,
    outputTokens: a.outputTokens + u.output_tokens,
    input: a.input + u.input_tokens,
    cacheRead: a.cacheRead + u.cache_read_input_tokens,
    cacheWrite: a.cacheWrite + u.cache_creation_input_tokens,
    lastContext: prompt,
    lastModel: u.model,
    lastCacheHit: prompt > 0 ? u.cache_read_input_tokens / prompt : undefined,
    costUsd: cost === undefined ? a.costUsd : (a.costUsd ?? 0) + cost,
    costPartial: cost === undefined ? true : a.costPartial,
  }
}
