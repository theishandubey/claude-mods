import { baseId } from './pricing'

const FAMILY = /^(?:claude-)?(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?$/

export const modelLabel = (id: string | undefined): string | undefined => {
  if (!id) return undefined
  const stripped = baseId(id)
  const match = FAMILY.exec(stripped)
  if (!match) {
    const rest = stripped.replace(/^claude-/, '')
    return rest || undefined
  }
  const [, family, major, minor] = match
  return `${family![0]!.toUpperCase()}${family!.slice(1)} ${major}${minor === undefined ? '' : `.${minor}`}`
}
