export const BUNDLE_DIR = '.auto-handoff'

const PRODUCER = 'auto-handoff/0.2.0'
export const MAX_CONCEPTS = 8
const MAX_CATALOG_CHARS = 8_000
export const LATEST_HANDOFFS = 3
export const LOG_TITLE = '# Update log'

export const KINDS = [
  { dir: 'decisions', type: 'Decision', heading: 'Decisions', what: 'a choice that was made, with its reason' },
  { dir: 'gotchas', type: 'Gotcha', heading: 'Gotchas', what: 'a non-obvious trap in this project and how to avoid it' },
  { dir: 'conventions', type: 'Convention', heading: 'Conventions', what: 'a rule the code or the user follows here' },
  { dir: 'questions', type: 'Open Question', heading: 'Open questions', what: 'something unresolved and what would settle it' },
] as const

type Kind = (typeof KINDS)[number]

const ID = /^(?:decisions|gotchas|conventions|questions)\/[a-z0-9]+(?:-[a-z0-9]+)*$/

export const BLOCK = /<concept>[ \t]*\n([\s\S]*?)\n[ \t]*<\/concept>/g

const SECRETS: readonly (readonly [string, RegExp, ((match: string, tag: string) => string)?])[] = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ['Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['OpenAI key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g],
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}/g],
  ['JWT', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ['bearer token', /\bBearer[ \t]+[A-Za-z0-9._~+\/-]{20,}=*/g],
  ['URL credentials', /\b[a-z][a-z0-9+.-]*:\/\/[^\/\s:@]+:[^\/\s@]+@/g, (match, tag) => `${match.slice(0, match.indexOf('//') + 2)}${tag}@`],
  ['Stripe key', /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/g],
  ['GitLab token', /\bglpat-[A-Za-z0-9_-]{20,}/g],
  ['npm token', /\bnpm_[A-Za-z0-9]{36}/g],
  ['Hugging Face token', /\bhf_[A-Za-z0-9]{30,}/g],
]

export type Concept = {
  id: string
  kind: Kind
  title: string
  description: string
  status: 'stable' | 'deprecated'
  supersedes: string | undefined
  body: string
}

type Meta = { title: string | undefined; description: string | undefined; status: string | undefined; human: boolean }

export type Compaction = { summary: string; sessionId: string; transcriptPath: string; cwd: string; now: number }

const quote = (text: string) => JSON.stringify(text)

export const lf = (text: string) => text.replace(/\r\n/g, '\n')

export const linkText = (text: string) => text.replace(/[[\]]/g, '')

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export const isoOf = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

const unquote = (value: string) => {
  if (value.startsWith('"')) {
    try {
      return String(JSON.parse(value))
    } catch {
      return value
    }
  }
  return value.replace(/^'(.*)'$/, '$1')
}

export const frontmatterEnd = (text: string) => (text.startsWith('---\n') ? text.indexOf('\n---', 3) : -1)

export const bodyOf = (text: string) => {
  const end = frontmatterEnd(text)
  return end < 0 ? text : text.slice(text.indexOf('\n', end + 1) + 1)
}

export function metaOf(text: string): Meta {
  const end = frontmatterEnd(text)
  const head = end < 0 ? '' : text.slice(4, end)
  const field = (key: string) => {
    const match = new RegExp(`^${key}:[ \\t]*(.+)$`, 'm').exec(head)
    return match === null ? undefined : unquote((match[1] ?? '').trim())
  }
  return { title: field('title'), description: field('description'), status: field('status'), human: /\bby:[ \t]*["']?human:/.test(head) }
}

export function redact(text: string) {
  let count = 0
  let out = text
  for (const [kind, pattern, shape] of SECRETS) {
    out = out.replace(pattern, match => {
      count += 1
      const tag = `[redacted ${kind}]`
      return shape === undefined ? tag : shape(match, tag)
    })
  }
  return { text: out, count }
}

export function parseBlock(raw: string): Concept | undefined {
  const split = raw.search(/\n[ \t]*\n/)
  if (split < 0) return undefined
  const fields = new Map<string, string>()
  for (const line of raw.slice(0, split).split('\n')) {
    const match = /^\s*([a-z]+):[ \t]*(.*?)\s*$/.exec(line)
    if (match !== null) fields.set(match[1] ?? '', match[2] ?? '')
  }
  const id = fields.get('id') ?? ''
  const kind = KINDS.find(k => id.startsWith(`${k.dir}/`))
  const title = fields.get('title') ?? ''
  const body = raw.slice(split).trim()
  if (!ID.test(id) || kind === undefined || title === '' || body === '') return undefined
  const supersedes = fields.get('supersedes')
  return {
    id,
    kind,
    title,
    description: fields.get('description') ?? '',
    status: fields.get('status') === 'deprecated' ? 'deprecated' : 'stable',
    supersedes: supersedes !== undefined && ID.test(supersedes) && supersedes !== id ? supersedes : undefined,
    body,
  }
}

export const goalOf = (summary: string) => {
  const match = /^#{1,6}[ \t]*(?:\d+\.[ \t]*)?\**Goal\b[^\n]*\n+[ \t]*([^#\s][^\n]*)/im.exec(summary)
  const line = match === null ? '' : (match[1] ?? '').replace(/[*_`]/g, '').trim()
  return line === '' ? 'Handoff written at a compaction' : line.slice(0, 200)
}

export const conceptText = (concept: Concept, handoffId: string, at: string) =>
  [
    '---',
    `type: ${concept.kind.type}`,
    `title: ${quote(concept.title)}`,
    `description: ${quote(concept.description)}`,
    `status: ${concept.status}`,
    `generated: { by: ${PRODUCER}, at: ${at} }`,
    'sources:',
    `  - { id: handoff, resource: /${handoffId}.md }`,
    '---',
    '',
    concept.body,
    ...(concept.supersedes === undefined ? [] : ['', `Supersedes [${concept.supersedes}](/${concept.supersedes}.md).`]),
    '',
  ].join('\n')

export const handoffText = (compaction: Compaction, title: string, goal: string, at: string, body: string) =>
  [
    '---',
    'type: Handoff',
    `title: ${quote(title)}`,
    `description: ${quote(goal)}`,
    `generated: { by: ${PRODUCER}, at: ${at} }`,
    `workdir: ${quote(compaction.cwd)}`,
    'sources:',
    `  - { id: transcript, resource: ${quote(`file://${encodeURI(compaction.transcriptPath)}`)}, title: ${quote(`Claude Code session ${compaction.sessionId}`)} }`,
    '---',
    '',
    body.trim(),
    '',
  ].join('\n')

export function clip(text: string, root: string) {
  if (text.length <= MAX_CATALOG_CHARS) return text
  const cut = text.lastIndexOf('\n', MAX_CATALOG_CHARS)
  return `${text.slice(0, cut < 0 ? MAX_CATALOG_CHARS : cut)}\n* ... index truncated; read ${root}/index.md for the rest`
}

export const knowledgeInstructions = (catalog: string | undefined) =>
  [
    'After the nine sections, add one more section headed Knowledge.',
    `In it, record durable knowledge about this project that a later session would need even for a different task, as at most ${MAX_CONCEPTS} blocks of exactly this form:`,
    '<concept>',
    'id: <folder>/<lowercase-words-joined-by-hyphens>',
    'title: <short title>',
    'description: <one sentence>',
    'status: stable',
    'supersedes: <id of an older concept this one replaces; leave the line out otherwise>',
    '',
    '<the knowledge in Markdown, with the reason it holds>',
    '</concept>',
    `Folders: ${KINDS.map(kind => `${kind.dir} for ${kind.what}`).join('; ')}.`,
    'Task progress belongs in Status, not here; leave the section empty when nothing durable was learned.',
    'Emit only knowledge that is new or changed in this conversation; never repeat what the catalog below already says.',
    'To change an existing concept, reuse its id: the block replaces it. To retire one with no replacement, reuse its id with status: deprecated and say why.',
    catalog === undefined ? 'The catalog is empty.' : `The catalog of existing concepts; an id is a link path without its leading / and .md:\n${catalog}`,
  ].join('\n')
