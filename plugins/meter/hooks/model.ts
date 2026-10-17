import type { ModelState, ResolvedModel } from '../types'
import { clean } from './format'

const capitalize = (s: string) => `${s[0]!.toUpperCase()}${s.slice(1).toLowerCase()}`

export const modelName = (id: string) => {
  const versioned = /(opus|sonnet|haiku|fable)-(\d{1,2})(?:-(\d{1,2})(?!\d)|(?=$|\[|-(?:\d{8}(?!\d)|v\d)))/i.exec(id)
  if (versioned) return `${capitalize(versioned[1]!)} ${versioned[2]}${versioned[3] === undefined ? '' : `.${versioned[3]}`}`
  const alias = /^(opus|sonnet|haiku|fable)(?:\[[^\]]*\])?$/i.exec(id)
  if (alias) return capitalize(alias[1]!)

  return id.replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '')
}

export const EMPTY_MODEL: ModelState = {
  selected: null,
  selectedAt: 0,
  answered: null,
  requested: null,
  effort: null,
  answeredRequestedAt: 0,
}

export const selectModel = (m: ModelState, id: string, at: number): ModelState =>
  m.selected === id ? m : { ...m, selected: id, selectedAt: at }

export type Answer = { answered: string; requested: string; effort: string | null; requestedAt: number }

export const addAnswer = (m: ModelState, a: Answer): ModelState => ({
  ...m,
  answered: clean(a.answered),
  requested: clean(a.requested),
  effort: a.effort === null ? null : clean(a.effort),
  answeredRequestedAt: a.requestedAt,
})

export const keepSelection = (m: ModelState): ModelState => ({
  ...EMPTY_MODEL,
  selected: m.selected,
  selectedAt: m.selectedAt,
})

const answerWins = (m: ModelState) =>
  m.answered !== null &&
  (m.selected === null ||
    m.answeredRequestedAt >= m.selectedAt ||
    (m.requested !== null && modelName(m.requested) === modelName(m.selected)))

export const resolveAnswer = (a: { answered: string; requested: string | null; effort: string | null }): ResolvedModel => {
  const name = modelName(a.answered)
  const requested = a.requested === null ? null : modelName(a.requested)

  return { name, id: a.answered, fallbackFrom: requested !== null && requested !== name ? requested : null, effort: a.effort }
}

export const resolveModel = (m: ModelState): ResolvedModel | null => {
  if (m.answered !== null && answerWins(m)) {
    return resolveAnswer({ answered: m.answered, requested: m.requested, effort: m.effort })
  }

  return m.selected === null ? null : { name: modelName(m.selected), id: m.selected, fallbackFrom: null, effort: null }
}
