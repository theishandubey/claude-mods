import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.parse('2026-10-06T12:00:00Z')

type RunInit = { cwd?: string; timeoutMs?: number }
type GitAnswer = { exitCode: number; stdout: string } | 'throw'

const CLEAN_MAIN = '# branch.oid 1111111111111111111111111111111111111111\n# branch.head main\n'

type Node = { type: string; props?: Record<string, unknown>; children?: unknown[] }

const flatten = (node: unknown): string => {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flatten).join('')
  const el = node as Node
  const sep = el.props?.flexDirection === 'column' ? '\n' : el.props?.columnGap ? ' '.repeat(Number(el.props.columnGap)) : ''

  return (el.children ?? []).map(flatten).join(sep)
}

const findNode = (node: unknown, pred: (n: Node) => boolean): Node | undefined => {
  if (node === null || typeof node !== 'object') return undefined
  if (Array.isArray(node)) return node.map(n => findNode(n, pred)).find(Boolean)
  const el = node as Node
  if (pred(el)) return el

  return (el.children ?? []).map(n => findNode(n, pred)).find(Boolean)
}

const runOf = (tree: unknown, text: string) =>
  findNode(tree, n => n.type === 'Text' && n.children?.length === 1 && n.children[0] === text)?.props

const draw = async ($: any, columns: number | null = 140, surface = 'terminal', props: Record<string, unknown> = {}) => {
  const ui = await $.ui.mount({
    plugin: 'statusline',
    surface,
    component: 'PromptHint',
    props: { isDraft: false, isWorking: false, hint: '? for shortcuts', ...props },
    ...(columns === null ? {} : { viewport: { columns, rows: 40, isFullscreen: false } }),
  })

  return ui.drawn()
}

const line = (tree: unknown) => flatten(tree).split('\n')[0]

const harness = async ($: any, on: any, options: { home?: string | null } = {}) => {
  const clock = mock.clock(on, { now: NOW })
  const home = options.home === undefined ? '/Users/robin' : options.home
  mock.env(on, home === null ? {} : { HOME: home })
  const h = {
    clock,
    model: 'claude-opus-5-5',
    cwd: '',
    surfaces: ['terminal'] as string[],
    git: { exitCode: 128, stdout: '' } as GitAnswer,
    pins: [] as (string | undefined)[],
    runs: [] as { argv: readonly string[]; init: RunInit | undefined }[],
    commandFails: false,
    toolFails: false,
    stepMs: 0,
    modelDelays: [] as number[],
    gitDelays: [] as number[],
  }
  on('session.model', async () => {
    const value = h.model
    const delay = h.modelDelays.shift()
    if (delay) await clock.sleep(delay)
    return { value }
  })
  on('session.cwd', () => ({ value: h.cwd }))
  on('session.surfaces', () => ({ value: h.surfaces }))
  on('process.run', async (_: unknown, e: { argv: readonly string[]; init?: RunInit }) => {
    h.runs.push({ argv: e.argv, init: e.init })
    const answer = h.git
    const delay = h.gitDelays.shift()
    if (delay) await clock.sleep(delay)
    if (answer === 'throw') throw new Error('spawn git ENOENT')
    return { value: { exitCode: answer.exitCode, stdout: answer.stdout, stderr: '' } } as never
  })
  on('ui.status', (_: unknown, e: { text: string | undefined }) => {
    h.pins.push(e.text)
    return { value: undefined }
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine hint'] }) as never)
  on('session.start', (_: unknown, e: unknown) => e as never)
  on('session.end', (_: unknown, e: { sessionId: string }) => ({ sessionId: e.sessionId }) as never)
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }) as never)
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }) as never)
  on('tool.call', () => {
    if (h.toolFails) throw new Error('tool crashed')
    return { result: 'fine' } as never
  })
  on('classic.CwdChanged', () => ({}) as never)
  on('command.run', { command: 'model' }, () => {
    if (h.commandFails) throw new Error('model picker crashed')
    return { text: 'ok' }
  })
  const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' }
  let answering = usage
  on('turn.step', async function* (_: unknown, e: { turnId: string; index: number }) {
    if (h.stepMs > 0) await clock.sleep(h.stepMs)
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: answering } as never
  })

  return Object.assign(h, {
    answerWith: (model: string) => {
      answering = { ...usage, model }
    },
  })
}

type Harness = Awaited<ReturnType<typeof harness>>

const start = async ($: any, on: any, setup: (h: Harness) => void = () => {}, options?: { home?: string | null }) => {
  const h = await harness($, on, options)
  setup(h)
  await $.session.start({ cwd: h.cwd, surface: 'terminal', isInteractive: true })
  await h.clock.settle()
  return h
}

const step = async ($: any, input: Record<string, unknown> = {}) => {
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3, effort: 'high', ...input })) {
  }
}

const clearSession = ($: any) => $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)

test('draws the selected model at session start', async ($, on) => {
  await start($, on)
  expect(line(await draw($))).toBe('Opus 5.5')
})

test('shows the effort once the main thread has answered', async ($, on) => {
  const h = await start($, on)
  await step($)
  await h.clock.settle()
  expect(line(await draw($))).toBe('Opus 5.5 high')
})

test('ignores subagent steps', async ($, on) => {
  const h = await start($, on)
  h.answerWith('claude-sonnet-5-5')
  await step($, { agentId: 'agent-1', model: 'claude-sonnet-5-5', effort: 'low' })
  await h.clock.settle()
  expect(line(await draw($))).toBe('Opus 5.5')
})

test('a step without a stated effort shows just the model', async ($, on) => {
  const h = await start($, on)
  await step($, { effort: undefined })
  await h.clock.settle()
  expect(line(await draw($))).toBe('Opus 5.5')
})

test('a /model switch shows the selected model without effort until the new one answers', async ($, on) => {
  const h = await start($, on)
  await step($)
  await h.clock.settle()
  expect(line(await draw($))).toBe('Opus 5.5 high')
  await h.clock.advance(60_000)
  h.model = 'claude-sonnet-5-5'
  const result = await $.command.run({ command: 'model' } as never)
  await h.clock.settle()
  expect(result.text).toBe('ok')
  expect(line(await draw($))).toBe('Sonnet 5.5')
  h.answerWith('claude-sonnet-5-5')
  await step($, { model: 'claude-sonnet-5-5' })
  await h.clock.settle()
  expect(line(await draw($))).toBe('Sonnet 5.5 high')
})

test('/model refreshes the line even when the command fails', async ($, on) => {
  const h = await start($, on)
  h.commandFails = true
  h.model = 'claude-haiku-4-5'
  await $.command.run({ command: 'model' } as never).catch(() => {})
  await h.clock.settle()
  expect(line(await draw($))).toBe('Haiku 4.5')
})

test('an answer still streaming from the old model does not overwrite a /model switch', async ($, on) => {
  const h = await start($, on)
  h.stepMs = 500
  const stepping = step($)
  await h.clock.advance(100)
  h.model = 'claude-sonnet-5-5'
  await $.command.run({ command: 'model' } as never)
  await h.clock.settle()
  await h.clock.advance(500)
  await stepping
  await h.clock.settle()
  expect(line(await draw($))).toBe('Sonnet 5.5')
})

test('an answer in flight across a /model switch to the same model keeps its detail', async ($, on) => {
  const h = await start($, on, s => {
    s.model = 'opus'
  })
  h.stepMs = 500
  const stepping = step($)
  await h.clock.advance(100)
  h.model = 'claude-opus-5-5[1m]'
  await $.command.run({ command: 'model' } as never)
  await h.clock.settle()
  await h.clock.advance(500)
  await stepping
  await h.clock.settle()
  expect(line(await draw($))).toBe('Opus 5.5 high')
})

test('a model change that bypasses /model shows at the next turn start', async ($, on) => {
  const h = await start($, on)
  await step($)
  await h.clock.advance(60_000)
  h.model = 'claude-sonnet-5-5'
  expect(line(await draw($))).toBe('Opus 5.5 high')
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await h.clock.settle()
  expect(line(await draw($))).toBe('Sonnet 5.5')
})

test('reading the same selection again keeps the precise name of the model that answered', async ($, on) => {
  const h = await start($, on, s => {
    s.model = 'opus'
  })
  expect(line(await draw($))).toBe('Opus')
  await step($)
  await h.clock.settle()
  expect(line(await draw($))).toBe('Opus 5.5 high')
  await h.clock.advance(60_000)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await h.clock.settle()
  expect(line(await draw($))).toBe('Opus 5.5 high')
})

test('names the requested model when another one answered', async ($, on) => {
  const h = await start($, on)
  h.answerWith('claude-sonnet-5-5')
  await step($)
  await h.clock.settle()
  expect(line(await draw($))).toBe('Sonnet 5.5 fallback from Opus 5.5')
})

test('a cloud-provider id of the requested model is not a fallback', async ($, on) => {
  const h = await start($, on)
  h.answerWith('claude-opus-5-5')
  await step($, { model: 'us.anthropic.claude-opus-5-5-v1:0' })
  await h.clock.settle()
  expect(line(await draw($))).toBe('Opus 5.5 high')
})

test('a tagged id of the requested model is not a fallback', async ($, on) => {
  const h = await start($, on)
  h.answerWith('my-custom-model')
  await step($, { model: 'my-custom-model[1m]' })
  await h.clock.settle()
  expect(line(await draw($))).toBe('my-custom-model high')
})

test('a dated id of the requested model is not a fallback', async ($, on) => {
  const h = await start($, on)
  h.answerWith('claude-opus-4-1-20250805')
  await step($, { model: 'claude-opus-4-1' })
  await h.clock.settle()
  expect(line(await draw($))).toBe('Opus 4.1 high')
})

test('a tagged and dated raw id of the requested model is not a fallback', async ($, on) => {
  const h = await start($, on)
  h.answerWith('claude-sonnet-4-20250514[1m]')
  await step($, { model: 'claude-sonnet-4-20250514' })
  await h.clock.settle()
  expect(line(await draw($))).toBe('claude-sonnet-4 high')
})

test('a dated raw id and its undated form are not a fallback', async ($, on) => {
  const h = await start($, on)
  h.answerWith('claude-sonnet-4-20250514')
  await step($, { model: 'claude-sonnet-4' })
  await h.clock.settle()
  expect(line(await draw($))).toBe('claude-sonnet-4 high')
})

test('/clear keeps the selected model and drops the answer', async ($, on) => {
  const h = await start($, on)
  await step($)
  await h.clock.settle()
  expect(line(await draw($))).toBe('Opus 5.5 high')
  await clearSession($)
  await h.clock.settle()
  expect(line(await draw($))).toBe('Opus 5.5')
})

test('/clear picks up a model changed in between', async ($, on) => {
  const h = await start($, on)
  await step($)
  h.model = 'claude-sonnet-5-5'
  await clearSession($)
  await h.clock.settle()
  expect(line(await draw($))).toBe('Sonnet 5.5')
})

for (const [id, name] of [
  ['us.anthropic.claude-opus-5-5-v1:0', 'Opus 5.5'],
  ['anthropic.claude-sonnet-4-5-20250929-v1:0', 'Sonnet 4.5'],
  ['claude-opus-4-1-20250805', 'Opus 4.1'],
  ['claude-opus-5-5[1m]', 'Opus 5.5'],
  ['opus', 'Opus'],
  ['SONNET[1m]', 'Sonnet'],
  ['my-custom-model', 'my-custom-model'],
  ['claude-opus-5-512', 'claude-opus-5-512'],
  ['bad\u001b[31mid', 'bad [31mid'],
] as const) {
  test(`names the model ${JSON.stringify(id)} as ${JSON.stringify(name)}`, async ($, on) => {
    const h = await start($, on, s => {
      s.model = id
    })
    expect(line(await draw($))).toBe(name)
  })
}

test('an empty model read leaves the line as it was', async ($, on) => {
  const h = await start($, on)
  h.model = '  '
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await h.clock.settle()
  expect(line(await draw($))).toBe('Opus 5.5')
})

test('of two overlapping model reads the later one wins', async ($, on) => {
  const h = await start($, on)
  h.model = 'claude-sonnet-5-5'
  h.modelDelays = [200, 0]
  await $.turn.start({ text: 'hi', turnId: 't1' })
  h.model = 'claude-haiku-4-5'
  await $.turn.start({ text: 'hi', turnId: 't2' })
  await h.clock.advance(500)
  expect(line(await draw($))).toBe('Haiku 4.5')
})

test('draws only the engine footer when there is nothing to show', async ($, on) => {
  await start($, on, s => {
    s.model = ''
  })
  expect(flatten(await draw($))).toBe('engine hint')
})

for (const surfaces of [['desktop'], ['desktop', 'mobile'], []]) {
  test(`draws only the engine footer on desktop when the terminal is not a surface (${surfaces.join(', ') || 'none'})`, async ($, on) => {
    const h = await start($, on, s => {
      s.cwd = '/Users/robin/Development/claude-mods'
      s.git = { exitCode: 0, stdout: CLEAN_MAIN }
      s.surfaces = surfaces
    })
    await step($)
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' } as never)
    await h.clock.settle()
    expect(flatten(await draw($, 140, 'desktop'))).toBe('engine hint')
    expect(h.runs).toEqual([])
  })
}

test('never pins a notice, and clears a leftover one at most once', async ($, on) => {
  const h = await start($, on)
  expect(h.pins).toEqual([])
  await draw($)
  await step($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await h.clock.settle()
  await draw($)
  await draw($)
  expect(h.pins).toEqual([undefined])
})

test('keeps the engine footer under the row', async ($, on) => {
  await start($, on)
  expect(flatten(await draw($)).split('\n')).toEqual(['Opus 5.5', 'engine hint'])
})

test('spaces the row one line from the footer and lines it up with the footer text', async ($, on) => {
  await start($, on)
  const row = findNode(await draw($), n => n.type === 'Box' && n.props?.key === 'statusline')
  expect(row?.props?.marginTop).toBe(1)
  expect(row?.props?.paddingX).toBeUndefined()
})

test('shows the row while the prompt holds a draft and while a turn is running', async ($, on) => {
  await start($, on)
  expect(line(await draw($, 140, 'terminal', { isDraft: true, isWorking: true }))).toBe('Opus 5.5')
})

const PROJECT = '/Users/robin/Development/claude-mods'

const repo = (stdout: string): GitAnswer => ({ exitCode: 0, stdout })

const inRepo = ($: any, on: any, stdout: string, cwd = PROJECT) =>
  start($, on, s => {
    s.cwd = cwd
    s.git = repo(stdout)
  })

test('shows model, effort, home-collapsed directory and git state on one line', async ($, on) => {
  const h = await inRepo(
    $,
    on,
    [
      '# branch.oid 2222222222222222222222222222222222222222',
      '# branch.head meter-redesign',
      '# branch.upstream origin/meter-redesign',
      '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 aaaa bbbb plugins/meter/hooks/format.ts',
      '',
    ].join('\n'),
  )
  await step($)
  await h.clock.settle()
  expect(line(await draw($))).toBe('Opus 5.5 high   ~/Development/claude-mods   meter-redesign ● ↑2↓1')
})

test('runs one git status in the session directory with a short timeout and no shell', async ($, on) => {
  const h = await inRepo($, on, CLEAN_MAIN)
  expect(h.runs).toHaveLength(1)
  expect(h.runs[0]!.argv.slice(-3)).toEqual(['status', '--porcelain=v2', '--branch'])
  expect(h.runs[0]!.argv[0]).toBe('git')
  expect(h.runs[0]!.init?.cwd).toBe(PROJECT)
  expect(h.runs[0]!.init?.timeoutMs).toBe(2000)
})

for (const [label, stdout, git] of [
  ['a clean branch with no upstream', CLEAN_MAIN, 'main'],
  ['a branch ahead of its upstream', `${CLEAN_MAIN}# branch.upstream origin/main\n# branch.ab +3 -0\n`, 'main ↑3'],
  ['a branch behind its upstream', `${CLEAN_MAIN}# branch.upstream origin/main\n# branch.ab +0 -4\n`, 'main ↓4'],
  ['a branch level with its upstream', `${CLEAN_MAIN}# branch.upstream origin/main\n# branch.ab +0 -0\n`, 'main'],
  ['a staged change', `${CLEAN_MAIN}1 M. N... 100644 100644 100644 aaaa bbbb a.ts\n`, 'main ●'],
  ['an unstaged change', `${CLEAN_MAIN}1 .M N... 100644 100644 100644 aaaa bbbb a.ts\n`, 'main ●'],
  ['an untracked file', `${CLEAN_MAIN}? notes.md\n`, 'main ●'],
  ['a rename', `${CLEAN_MAIN}2 R. N... 100644 100644 100644 aaaa bbbb R100 b.ts\ta.ts\n`, 'main ●'],
  ['an unmerged path', `${CLEAN_MAIN}u UU N... 100644 100644 100644 100644 aaaa bbbb cccc a.ts\n`, 'main ●'],
  ['a dirty branch both ahead and behind', `${CLEAN_MAIN}# branch.upstream origin/main\n# branch.ab +1 -2\n? x\n`, 'main ● ↑1↓2'],
  [
    'a detached head',
    '# branch.oid abc1234def5678abc1234def5678abc1234def56\n# branch.head (detached)\n',
    '@abc1234',
  ],
  [
    'a detached head with changes',
    '# branch.oid abc1234def5678abc1234def5678abc1234def56\n# branch.head (detached)\n? x\n',
    '@abc1234 ●',
  ],
  ['a repository with no commits', '# branch.oid (initial)\n# branch.head main\n', 'main'],
  ['a branch named with a slash', '# branch.oid 1111\n# branch.head feature/status-line\n', 'feature/status-line'],
] as const) {
  test(`shows git state for ${label}`, async ($, on) => {
    const h = await inRepo($, on, stdout)
    expect(line(await draw($))).toBe(`Opus 5.5   ~/Development/claude-mods   ${git}`)
  })
}

test('leaves the git part out when the directory is not a repository', async ($, on) => {
  const h = await start($, on, s => {
    s.cwd = PROJECT
    s.git = { exitCode: 128, stdout: '' }
  })
  expect(line(await draw($))).toBe('Opus 5.5   ~/Development/claude-mods')
})

test('leaves the git part out when git cannot run', async ($, on) => {
  const h = await start($, on, s => {
    s.cwd = PROJECT
    s.git = 'throw'
  })
  expect(line(await draw($))).toBe('Opus 5.5   ~/Development/claude-mods')
})

test('leaves the git part out when git prints nothing it knows', async ($, on) => {
  const h = await inRepo($, on, '')
  expect(line(await draw($))).toBe('Opus 5.5   ~/Development/claude-mods')
})

test('a git failure after a good read drops the git part', async ($, on) => {
  const h = await inRepo($, on, CLEAN_MAIN)
  expect(line(await draw($))).toBe('Opus 5.5   ~/Development/claude-mods   main')
  h.git = 'throw'
  await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  await h.clock.settle()
  expect(line(await draw($))).toBe('Opus 5.5   ~/Development/claude-mods')
})

for (const [label, cwd, home, shown] of [
  ['the home directory itself', '/Users/robin', '/Users/robin', '~'],
  ['a directory under home', '/Users/robin/src/app', '/Users/robin', '~/src/app'],
  ['a sibling that merely shares the home prefix', '/Users/robinx/app', '/Users/robin', '/Users/robinx/app'],
  ['a directory outside home', '/work/proj', '/Users/robin', '/work/proj'],
  ['an unknown home', '/Users/robin/src/app', null, '/Users/robin/src/app'],
  ['a home written with a trailing slash', '/Users/robin/src/app', '/Users/robin/', '~/src/app'],
  ['a path of exactly 48 characters', '/aaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbb/ccccccccccccc', '/Users/robin', '/aaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbb/ccccccccccccc'],
  [
    'a path over 48 characters',
    '/Users/robin/Development/organisation/claude-mods/plugins/statusline',
    '/Users/robin',
    '…/organisation/claude-mods/plugins/statusline',
  ],
  ['a long path outside home', '/srv/deployments/production/releases/2026-10-06/current', '/Users/robin', '…/production/releases/2026-10-06/current'],
  ['a path of 49 characters', '/aaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbb/cccccccccccccc', '/Users/robin', '…/bbbbbbbbbbbbbbbb/cccccccccccccc'],
  ['a single segment over 48 characters', `/${'x'.repeat(55)}`, '/Users/robin', `…/${'x'.repeat(55)}`],
] as const) {
  test(`shows ${label} as ${JSON.stringify(shown)}`, async ($, on) => {
    await start(
      $,
      on,
      s => {
        s.cwd = cwd
      },
      { home },
    )
    expect(line(await draw($))).toBe(`Opus 5.5   ${shown}`)
  })
}

test('leaves out the model when it is unknown and keeps the rest of the line', async ($, on) => {
  const h = await start($, on, s => {
    s.model = ''
    s.cwd = PROJECT
    s.git = repo(`${CLEAN_MAIN}? x\n`)
  })
  expect(line(await draw($))).toBe('~/Development/claude-mods   main ●')
})

test('shows only the model when the directory is unknown and there is no repository', async ($, on) => {
  const h = await start($, on)
  expect(line(await draw($))).toBe('Opus 5.5')
})

test('of two overlapping git reads the later one wins', async ($, on) => {
  const h = await inRepo($, on, CLEAN_MAIN)
  h.git = repo('# branch.oid 1111\n# branch.head stale\n')
  h.gitDelays = [300, 0]
  await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  await h.clock.settle()
  h.git = repo('# branch.oid 1111\n# branch.head fresh\n')
  await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 't2', reason: 'answer' } as never)
  await h.clock.advance(1000)
  expect(line(await draw($))).toBe('Opus 5.5   ~/Development/claude-mods   fresh')
})

test('re-reads git when a turn completes', async ($, on) => {
  const h = await inRepo($, on, CLEAN_MAIN)
  h.git = repo(`${CLEAN_MAIN}? x\n`)
  const result = await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  await h.clock.settle()
  expect(result.text).toBe('done')
  expect(line(await draw($))).toBe('Opus 5.5   ~/Development/claude-mods   main ●')
})

const callTool = ($: any, tool: string, input: Record<string, unknown> = {}) => $.tool.call({ tool, ...input })

for (const [tool, input] of [
  ['Bash', { command: 'git checkout -b topic' }],
  ['Edit', { file_path: '/work/a.ts', old_string: 'a', new_string: 'b' }],
  ['Write', { file_path: '/work/a.ts', content: 'a' }],
  ['NotebookEdit', { notebook_path: '/work/a.ipynb', new_source: 'a' }],
] as const) {
  test(`re-reads git after a ${tool} call, a second after the last one`, async ($, on) => {
    const h = await inRepo($, on, CLEAN_MAIN)
    h.git = repo('# branch.oid 1111\n# branch.head topic\n')
    await callTool($, tool, input)
    await h.clock.advance(999)
    expect(line(await draw($))).toBe('Opus 5.5   ~/Development/claude-mods   main')
    await h.clock.advance(1)
    expect(line(await draw($))).toBe('Opus 5.5   ~/Development/claude-mods   topic')
  })
}

test('a burst of tool calls runs git once', async ($, on) => {
  const h = await inRepo($, on, CLEAN_MAIN)
  const before = h.runs.length
  await callTool($, 'Bash', { command: 'a' })
  await h.clock.advance(400)
  await callTool($, 'Edit', { file_path: '/work/a.ts', old_string: 'a', new_string: 'b' })
  await h.clock.advance(400)
  await callTool($, 'Write', { file_path: '/work/b.ts', content: 'b' })
  await h.clock.advance(999)
  expect(h.runs.length).toBe(before)
  await h.clock.advance(1)
  expect(h.runs.length).toBe(before + 1)
})

test('calls that cannot change the tree do not run git', async ($, on) => {
  const h = await inRepo($, on, CLEAN_MAIN)
  const before = h.runs.length
  await callTool($, 'Read', { file_path: '/work/a.ts' })
  await callTool($, 'Grep', { pattern: 'a' })
  await h.clock.advance(5000)
  expect(h.runs.length).toBe(before)
})

test('a tool call that throws still re-reads git', async ($, on) => {
  const h = await inRepo($, on, CLEAN_MAIN)
  const before = h.runs.length
  h.toolFails = true
  await callTool($, 'Bash', { command: 'a' }).catch(() => {})
  await h.clock.advance(1000)
  expect(h.runs.length).toBe(before + 1)
})

test('re-reads the directory and git when the working directory changes', async ($, on) => {
  const h = await inRepo($, on, CLEAN_MAIN)
  h.cwd = '/Users/robin/Development/other'
  h.git = repo('# branch.oid 1111\n# branch.head dev\n')
  await $.classic.CwdChanged({
    old_cwd: PROJECT,
    new_cwd: h.cwd,
    session_id: 's1',
    transcript_path: '/t.jsonl',
    cwd: h.cwd,
  } as never)
  await h.clock.settle()
  expect(line(await draw($))).toBe('Opus 5.5   ~/Development/other   dev')
})

test('reads the directory and git again at session start', async ($, on) => {
  const h = await inRepo($, on, CLEAN_MAIN)
  h.git = repo(`${CLEAN_MAIN}? x\n`)
  await $.session.start({ cwd: h.cwd, surface: 'terminal', isInteractive: true })
  await h.clock.settle()
  expect(line(await draw($))).toBe('Opus 5.5   ~/Development/claude-mods   main ●')
})

test('a subagent finishing a turn does not re-read git', async ($, on) => {
  const h = await inRepo($, on, CLEAN_MAIN)
  const before = h.runs.length
  h.git = repo(`${CLEAN_MAIN}? x\n`)
  await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer', agentId: 'agent-1' } as never)
  await h.clock.settle()
  expect(h.runs.length).toBe(before)
  expect(line(await draw($))).toBe('Opus 5.5   ~/Development/claude-mods   main')
})

test('the row draws again after a git refresh', async ($, on) => {
  const h = await inRepo($, on, CLEAN_MAIN)
  const before = line(await draw($))
  h.git = repo('# branch.oid 1111\n# branch.head topic\n')
  await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  await h.clock.settle()
  const after = line(await draw($))
  expect(before).toBe('Opus 5.5   ~/Development/claude-mods   main')
  expect(after).toBe('Opus 5.5   ~/Development/claude-mods   topic')
})

const WIDE = '/Volumes/Data/Projects/Sources/claude-mods'
const DIRTY_AHEAD_BEHIND = [
  '# branch.oid 2222222222222222222222222222222222222222',
  '# branch.head meter-redesign',
  '# branch.upstream origin/meter-redesign',
  '# branch.ab +2 -1',
  '? x',
  '',
].join('\n')

const inWideRepo = async ($: any, on: any, answeredBy?: string) => {
  const h = await inRepo($, on, DIRTY_AHEAD_BEHIND, WIDE)
  if (answeredBy) h.answerWith(answeredBy)
  await step($)
  await h.clock.settle()
  return h
}

for (const [label, columns, answeredBy, expected] of [
  ['140 columns', 140, undefined, 'Opus 5.5 high   /Volumes/Data/Projects/Sources/claude-mods   meter-redesign ● ↑2↓1'],
  ['100 columns', 100, undefined, 'Opus 5.5 high   /Volumes/Data/Projects/Sources/claude-mods   meter-redesign ● ↑2↓1'],
  ['100 columns on a fallback model', 100, 'claude-sonnet-5-5', 'Sonnet 5.5 fallback from Opus 5.5  …/Sources/claude-mods  meter-redesign ● ↑2↓1'],
  ['60 columns', 60, undefined, 'Opus 5.5 high  claude-mods  meter-redesign ● ↑2↓1'],
  ['60 columns on a fallback model', 60, 'claude-sonnet-5-5', 'Sonnet 5.5 fallback  claude-mods  meter-redesign ● ↑2↓1'],
  ['30 columns', 30, undefined, 'Opus 5.5  meter-redes… ● ↑2↓1'],
  ['no viewport', null, undefined, 'Opus 5.5 high  …/Sources/claude-mods  meter-redesign ● ↑2↓1'],
] as const) {
  test(`fits the row at ${label}`, async ($, on) => {
    await inWideRepo($, on, answeredBy)
    expect(line(await draw($, columns))).toBe(expected)
  })
}

test('cuts a branch name over 48 characters with an ellipsis', async ($, on) => {
  await inRepo($, on, `# branch.oid 1111\n# branch.head ${'x'.repeat(60)}\n`)
  expect(line(await draw($))).toBe(`Opus 5.5   ~/Development/claude-mods   ${'x'.repeat(47)}…`)
})

test('draws the model bold and the effort dim', async ($, on) => {
  await inWideRepo($, on)
  const tree = await draw($)
  expect(runOf(tree, 'Opus 5.5')?.bold).toBe(true)
  expect(runOf(tree, 'Opus 5.5')?.color).toBeUndefined()
  expect(runOf(tree, ' high')?.dimColor).toBe(true)
})

test('draws a fallback model name bold in the warning colour and the rest dim', async ($, on) => {
  await inWideRepo($, on, 'claude-sonnet-5-5')
  const tree = await draw($)
  expect(runOf(tree, 'Sonnet 5.5')).toMatchObject({ color: 'warning', bold: true })
  expect(runOf(tree, ' fallback from Opus 5.5')?.dimColor).toBe(true)
})

test('draws the directory parent dim and its basename plain', async ($, on) => {
  await inWideRepo($, on)
  const tree = await draw($)
  expect(runOf(tree, '/Volumes/Data/Projects/Sources/')?.dimColor).toBe(true)
  expect(runOf(tree, 'claude-mods')?.dimColor).toBeUndefined()
})

test('draws the dirty marker and the ahead count plain and the behind count in the warning colour', async ($, on) => {
  await inWideRepo($, on)
  const tree = await draw($)
  expect(runOf(tree, '●')?.color).toBeUndefined()
  expect(runOf(tree, '↑2')?.color).toBeUndefined()
  expect(runOf(tree, '↓1')?.color).toBe('warning')
  expect(runOf(tree, 'meter-redesign')?.color).toBeUndefined()
})

test('draws a detached head in the warning colour', async ($, on) => {
  await inRepo($, on, '# branch.oid abc1234def5678abc1234def5678abc1234def56\n# branch.head (detached)\n')
  expect(runOf(await draw($), '@abc1234')?.color).toBe('warning')
})
