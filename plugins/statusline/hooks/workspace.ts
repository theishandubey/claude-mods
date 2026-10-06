import type { GitInfo } from '../types'
import { clean } from './model'

const SHORT_SHA = 7

export const shortenPath = (cwd: string, home: string | null, max: number): string => {
  const root = home === null ? '' : home.replace(/\/+$/, '')
  const shown = root !== '' && (cwd === root || cwd.startsWith(`${root}/`)) ? `~${cwd.slice(root.length)}` : cwd
  if (shown.length <= max) return shown

  const segments = shown.split('/').filter(Boolean)
  let kept = segments.slice(-1)
  for (let i = segments.length - 2; i >= 0; i--) {
    const next = [segments[i]!, ...kept]
    if (`…/${next.join('/')}`.length > max) break
    kept = next
  }

  return `…/${kept.join('/')}`
}

export const splitPath = (shown: string): { parent: string; base: string } => {
  if (shown === '~' || shown === '/') return { parent: '', base: shown }
  const cut = shown.lastIndexOf('/') + 1

  return { parent: shown.slice(0, cut), base: shown.slice(cut) }
}

export const basename = (shown: string) => splitPath(shown).base

export const parseGitStatus = (stdout: string): GitInfo | null => {
  let oid = ''
  let head = ''
  let ahead = 0
  let behind = 0
  let isDirty = false
  for (const line of stdout.split('\n')) {
    if (line === '') continue
    if (!line.startsWith('# ')) {
      isDirty = true
      continue
    }
    const [key, ...rest] = line.slice(2).split(' ')
    if (key === 'branch.oid') oid = rest.join(' ')
    else if (key === 'branch.head') head = rest.join(' ')
    else if (key === 'branch.ab') {
      ahead = Number(/^\+(\d+)$/.exec(rest[0] ?? '')?.[1] ?? 0)
      behind = Number(/^-(\d+)$/.exec(rest[1] ?? '')?.[1] ?? 0)
    }
  }
  const isDetached = head === '(detached)'
  const name = isDetached ? `@${oid.slice(0, SHORT_SHA)}` : head
  if (name === '' || name === '@') return null

  return { head: clean(name), isDetached, isDirty, ahead, behind }
}
