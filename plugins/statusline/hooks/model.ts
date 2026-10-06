import type { ModelState } from '../types'

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g

export const clean = (s: string) => {
  const cut = s.replace(CONTROL, ' ').slice(0, 200)
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}

const capitalize = (s: string) => `${s[0]!.toUpperCase()}${s.slice(1).toLowerCase()}`

export const modelName = (id: string) => {
  const versioned = /(opus|sonnet|haiku|fable)-(\d{1,2})(?:-(\d{1,2})(?!\d)|(?=$|\[|-(?:\d{8}(?!\d)|v\d)))/i.exec(id)
  if (versioned) return `${capitalize(versioned[1]!)} ${versioned[2]}${versioned[3] === undefined ? '' : `.${versioned[3]}`}`
  const alias = /^(opus|sonnet|haiku|fable)(?:\[[^\]]*\])?$/i.exec(id)

  return alias ? capitalize(alias[1]!) : id.replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '')
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

export type ResolvedModel = { name: string; effort: string | null; fallbackFrom: string | null }

const answerWins = (m: ModelState) =>
  m.answered !== null &&
  (m.selected === null ||
    m.answeredRequestedAt >= m.selectedAt ||
    (m.requested !== null && modelName(m.requested) === modelName(m.selected)))

export const resolveModel = (m: ModelState): ResolvedModel | null => {
  if (m.answered !== null && answerWins(m)) {
    const name = modelName(m.answered)
    const requested = m.requested === null ? null : modelName(m.requested)

    return { name, effort: m.effort, fallbackFrom: requested !== null && requested !== name ? requested : null }
  }

  return m.selected === null ? null : { name: modelName(m.selected), effort: null, fallbackFrom: null }
}
