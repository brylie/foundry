import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import type { PrData } from '../hooks/ship'
import { parseState } from '../hooks/state'

const PANE = {
  plugin: 'foundry',
  component: 'Pane',
  requestId: 'foundry',
  props: {
    title: 'Foundry',
    isFocused: false,
    bodyColumns: 70,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const SHOWN = { isFullscreen: true, columns: 120 }
/** The default reviewers: the spec's five, and documentation. */
const REVIEWERS = ['product-owner', 'usability', 'accessibility', 'architecture', 'security', 'documentation']
const HEAD = 'feedbeef00'
/** The account the mod's `gh` is signed in as. */
const WRITER = 'maintainer'

class NotFound extends Error {}

/** A pretend GitHub behind `gh`: comments and labels per issue, and one pull request. */
function github() {
  const comments = new Map<number, { id: number; body: string; user: string }[]>()
  const labels = new Map<number, string[]>()
  let nextId = 100
  let pr: PrData = {
    number: 9,
    url: 'https://github.com/o/r/pull/9',
    state: 'OPEN',
    headRefOid: HEAD,
    commits: { nodes: [{ commit: { committedDate: new Date(0).toISOString(), statusCheckRollup: { contexts: { nodes: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] } } } }] },
    reviews: { nodes: [{ author: { login: 'coderabbitai' }, state: 'COMMENTED', submittedAt: '', commit: { oid: HEAD } }] },
    reviewThreads: { nodes: [] },
    comments: { nodes: [{ author: { login: 'gitar-bot' }, body: 'Verification: no issues', updatedAt: new Date(1000).toISOString() }] },
  }
  const calls: string[] = []
  const failing: RegExp[] = []
  /** foundry.yaml on the default branch; undefined means the file is not there. */
  let config: string | undefined

  /** `gh` as the mod runs it: a call matching a `failOnce` pattern fails, once. */
  function run(argv: readonly string[], stdin?: string): { stdout: string; stderr: string; exitCode: number } {
    const line = argv.slice(1).join(' ')
    const fail = failing.findIndex(p => p.test(line))
    if (fail >= 0) {
      failing.splice(fail, 1)

      return { stdout: '', stderr: 'gh: Server Error (HTTP 502)', exitCode: 1 }
    }
    if (/contents\/foundry\.yaml/.test(line)) {
      calls.push(line)

      return config === undefined ? { stdout: '', stderr: 'gh: Not Found (HTTP 404)', exitCode: 1 } : { stdout: config, stderr: '', exitCode: 0 }
    }

    try {
      return { stdout: answer(argv, stdin), stderr: '', exitCode: 0 }
    } catch (error) {
      if (error instanceof NotFound) return { stdout: '', stderr: 'gh: Not Found (HTTP 404)', exitCode: 1 }
      throw error
    }
  }

  function answer(argv: readonly string[], stdin?: string): string {
    const args = argv.slice(1)
    const line = args.join(' ')
    calls.push(line)
    if (line.startsWith('repo view') && line.includes('defaultBranchRef')) return 'main\n'
    if (line.startsWith('repo view')) return 'o/r\n'
    if (line.startsWith('label create')) return ''
    if (line.startsWith('issue list')) return JSON.stringify([...labels].filter(([, l]) => l.includes('foundry')).map(([number]) => ({ number })))
    if (line.startsWith('api graphql')) return JSON.stringify({ data: { repository: { pullRequest: pr } } })
    if (line.startsWith('api user')) return `${WRITER}\n`
    const x = args.indexOf('-X')
    const method = x >= 0 ? (args[x + 1] ?? 'GET') : 'GET'
    const path = args.find(a => a.startsWith('repos/')) ?? ''
    const issue = Number(/issues\/(\d+)/.exec(path)?.[1])
    if (/issues\/\d+\/comments/.test(path)) {
      const list = comments.get(issue) ?? []
      // `--paginate --jq '.[] | {id, body, user: .user.login}'`: one object per line.
      if (method === 'GET') return list.map(c => JSON.stringify(c)).join('\n')
      const made = { id: nextId++, body: (JSON.parse(stdin ?? '{}') as { body: string }).body, user: WRITER }
      comments.set(issue, [...list, made])

      return JSON.stringify({ ...made, html_url: `https://github.com/o/r/issues/${issue}#issuecomment-${made.id}` })
    }
    if (/issues\/comments\/\d+/.test(path)) {
      const id = Number(/comments\/(\d+)/.exec(path)?.[1])
      const found = [...comments.values()].flat().find(c => c.id === id)
      // A comment that is gone answers 404, as GitHub does.
      if (found === undefined) throw new NotFound()
      found.body = (JSON.parse(stdin ?? '{}') as { body: string }).body
      const on = [...comments].find(([, list]) => list.includes(found))?.[0]

      return JSON.stringify({ ...found, html_url: `https://github.com/o/r/issues/${on}#issuecomment-${found.id}` })
    }
    const one = /issues\/\d+\/labels\/([^/?]+)/.exec(path)
    if (one && method === 'DELETE') {
      const name = decodeURIComponent(one[1] ?? '')
      labels.set(issue, (labels.get(issue) ?? []).filter(l => l !== name))

      return '[]'
    }
    if (/issues\/\d+\/labels/.test(path)) {
      if (method === 'GET') return JSON.stringify((labels.get(issue) ?? []).map(name => ({ name })))
      // POST adds to what is there, as GitHub does.
      const added = (JSON.parse(stdin ?? '{}') as { labels: string[] }).labels
      labels.set(issue, [...new Set([...(labels.get(issue) ?? []), ...added])])

      return '[]'
    }

    return ''
  }

  /** A comment someone else posts, as GitHub would list it. */
  function post(issue: number, body: string, user: string) {
    comments.set(issue, [...(comments.get(issue) ?? []), { id: nextId++, body, user }])
  }

  return {
    calls,
    labels,
    comments,
    post,
    failOnce: (pattern: RegExp) => failing.push(pattern),
    setConfig: (text: string | undefined) => (config = text),
    setPr: (next: Partial<PrData>) => (pr = { ...pr, ...next }),
    state: (issue: number) => {
      const body = (comments.get(issue) ?? []).map(c => c.body).find(b => b.includes('foundry:state'))

      return body === undefined ? undefined : parseState(body)
    },
    run,
  }
}

/** Stands in for the engine beneath the plugin, and records what it was asked. */
function engine(on: On) {
  const hub = github()
  const prompts: string[] = []
  const ran: string[] = []
  /** How the next prompt submissions go: accepted, dropped (as after Stop), or held until released. */
  const submit = { mode: 'accept' as 'accept' | 'drop' | 'hold', release: () => {} }
  const gate: { pattern?: RegExp; open: () => void } = { open: () => {} }
  const clock = mock.clock(on)
  on('ui.status', () => ({ value: undefined }))
  /** The tool rows that opened a wait, by their id, newest last, as the mod's debug log names them. */
  const rows: string[] = []
  on('ui.log', (_, e) => {
    const opened = /^Foundry: tool row (\S+) opened the wait /.exec(e.text)
    if (e.to === 'debug' && opened?.[1] !== undefined) rows.push(opened[1])

    return { value: undefined }
  })
  /** The person's notifications, as their channel holds them: sent by key, and taken back. */
  const notes = { sent: [] as { text: string; key?: string }[], taken: [] as string[] }
  on('ui.notify', (_, e) => {
    notes.sent.push({ text: e.text, ...(e.key === undefined ? {} : { key: e.key }) })

    return { value: { isSent: true, channel: 'test' } as never }
  })
  on('ui.cancelNotify', (_, e) => {
    notes.taken.push(e.key)

    return { value: { isSent: true } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__foundry__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.repo', () => ({ value: { root: '/repo', name: 'r', remote: 'git@github.com:o/r.git', internal: false } }))
  on('process.run', async (_, e) => {
    // A `gh` call matching the gate's pattern waits until the test opens it, once.
    const line = e.argv.slice(1).join(' ')
    if (gate.pattern?.test(line)) {
      gate.pattern = undefined
      await new Promise<void>(resolve => (gate.open = resolve))
    }
    const { stdout, stderr, exitCode } = hub.run(e.argv, e.init?.stdin)

    return { value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('prompt.submit', async (_, e) => {
    prompts.push(e.text)
    if (submit.mode === 'drop') return { drop: 'the person pressed Stop' }
    if (submit.mode === 'hold') await new Promise<void>(resolve => (submit.release = resolve))

    return { text: e.text }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  /**
   * Foundry's questions to the person, and how each is answered: a label, typed words, or dismissed.
   * `answer` answers every question; `answerAt`, when set, answers the question at that index instead.
   */
  const asks = {
    questions: [] as string[],
    /** The choices each question offered, by the same index. */
    labels: [] as string[][],
    answer: undefined as string | undefined,
    answerAt: undefined as ((index: number) => string | undefined) | undefined,
    held: undefined as Promise<void> | undefined,
  }
  /** The files of the checkout `$.fs.read` finds, by absolute path. */
  const files = new Map<string, string>()
  on('fs.read', (_, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)

    return { value: text }
  })
  on('tool.call', async (_, e) => {
    if (e.tool === 'Bash') ran.push(e.command)
    if (e.tool === 'AskUserQuestion') {
      const question = (e as unknown as { questions: { question: string }[] }).questions[0]?.question ?? ''
      const index = asks.questions.push(question) - 1
      asks.labels.push((e as unknown as { questions: { options: { label: string }[] }[] }).questions[0]?.options.map(o => o.label) ?? [])
      // A question the person leaves open answers only once the test lets it.
      if (asks.held) await asks.held
      const answer = asks.answerAt ? asks.answerAt(index) : asks.answer
      if (answer === undefined) return { deny: 'dismissed' }

      return { result: { answers: { [question]: answer } } }
    }

    return { result: {} }
  })

  return { hub, prompts, ran, submit, clock, gate, asks, files, notes, rows }
}

async function approveAll($: Engine) {
  for (const perspective of REVIEWERS) {
    const r = await $.tool.call({ tool: 'mcp__foundry__review_record', perspective, reviewer: `foundry:${perspective}`, verdict: 'ready', summary: 'fine' })
    expect(r.deny).toBeUndefined()
  }
}

async function press($: Engine, key: string) {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key })
  await ui.unmount()
}

test('a batch moves through every stage, its state in GitHub, gated by the person', async ($, on) => {
  const { hub, prompts, ran, clock } = engine(on)
  hub.setConfig('online_reviewers:\n  - coderabbitai[bot]\n  - gitar-bot[bot]\nmaintainers: [maintainer]\n')
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })

  const started = await $.tool.call({ tool: 'mcp__foundry__batch_start', title: 'Name the ports', issues: [12, 14] })
  expect(started.deny).toBeUndefined()
  // The allowlist comes from foundry.yaml on the default branch, never the checkout.
  expect(String(started.result)).toContain('Settings from foundry.yaml on main.')
  expect(hub.calls.some(c => c.includes('contents/foundry.yaml?ref=main'))).toBe(true)
  expect(hub.state(12)?.onlineReviewers).toEqual(['coderabbitai', 'gitar-bot'])
  expect(hub.state(12)?.stage).toBe('plan')
  expect(hub.labels.get(12)).toEqual(['foundry', 'foundry:plan'])
  expect(hub.labels.get(14)).toEqual(['foundry', 'foundry:plan'])

  // Plan loop: nothing in the repository moves.
  expect((await $.tool.call({ tool: 'Write', file_path: '/repo/src/a.ts', content: 'x' })).deny).toContain('no approved plan')
  expect((await $.tool.call({ tool: 'Bash', command: 'gh issue edit 12 --add-assignee @me' })).deny).toContain('plan stage')
  expect((await $.tool.call({ tool: 'mcp__foundry__signoff_request', summary: 'The plan' })).deny).toContain('Not yet')

  await approveAll($)
  expect((await $.tool.call({ tool: 'mcp__foundry__signoff_request', summary: '**The plan**' })).deny).toBeUndefined()
  expect(hub.labels.get(12)).toEqual(['foundry', 'foundry:plan', 'foundry:waiting'])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Waiting on you: Plan sign-off · just now/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Now: Plan sign-off, stage 2 of 6, round 1 of 3/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /security ready/ })).toBeDefined()
    await ui.unmount()
  }

  // Plan sign-off, by the person's press.
  await press($, '12-approve')
  expect(prompts.at(-1)).toContain('approved the plan')
  expect(hub.state(12)?.stage).toBe('build')

  // Build loop: commits and a draft pull request, for the build sign-off to read; review waits for the sign-off.
  expect((await $.tool.call({ tool: 'Bash', command: 'git commit -m "Name the ports (#12)"' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'git push -u origin HEAD' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'gh pr create --title t --body-file b.md' })).deny).toContain('--draft')
  expect((await $.tool.call({ tool: 'Bash', command: 'gh pr create --draft --title t --body-file b.md' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'gh pr ready 9' })).deny).toContain('after the build sign-off')
  const draft = await $.tool.call({ tool: 'mcp__foundry__pr_opened', pr: 'https://github.com/o/r/pull/9' })
  expect(String(draft.result)).toContain('Recorded draft pull request #9')
  await $.tool.call({ tool: 'mcp__foundry__tests_record', command: 'npm test', passed: true, summary: '42 passed' })
  await approveAll($)
  await $.tool.call({ tool: 'mcp__foundry__signoff_request', summary: 'The change' })

  // Build sign-off, by the person's command.
  const typed = await $.command.run({ command: 'foundry', args: 'approve', origin: { kind: 'composer' }, presentation: SHOWN })
  expect(typed.text).toContain('Done: approve for "Name the ports" (#12)')
  // The command wakes the agent once it is done, as a press would: a command's context alone may start no turn.
  await clock.settle()
  expect(prompts.at(-1)).toContain('approved the implementation')

  // Ship gates.
  expect((await $.tool.call({ tool: 'Bash', command: 'git push -u origin HEAD' })).deny).toBeUndefined()
  expect(ran).toContain('git push -u origin HEAD')
  expect((await $.tool.call({ tool: 'mcp__foundry__pr_opened', pr: 'https://github.com/o/r/pull/9' })).deny).toBeUndefined()
  expect(hub.labels.get(9)).toEqual(['foundry', 'foundry:ship', 'foundry:waiting'])
  // CI is green and nothing is open: ready to merge, without waiting for gitar-bot's comment or any review.
  expect(hub.state(12)?.waiting?.kind).toBe('merge')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Waiting on you: Ready to merge/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /gitar-bot|coderabbitai/ })).toBeUndefined()
  await ui.unmount()
  expect((await $.tool.call({ tool: 'Bash', command: 'gh pr merge 9 --squash' })).deny).toContain('the person merges')

  // The person merges on GitHub; the next poll sees it.
  hub.setPr({ state: 'MERGED' })
  await $.tool.call({ tool: 'mcp__foundry__pr_opened', pr: '9' })
  expect(hub.state(12)?.stage).toBe('done')
  expect(hub.labels.get(12)).toEqual([])
})

test("the agent cannot sign off or edit Foundry's state, but may resolve review threads", async ($, on) => {
  const { hub } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__foundry__batch_start', title: 'T', issues: [12] })
  await approveAll($)
  await $.tool.call({ tool: 'mcp__foundry__signoff_request', summary: 'plan' })

  const fromPeer = await $.command.run({ command: 'foundry', args: 'approve', origin: { kind: 'peer' }, presentation: SHOWN })
  expect(fromPeer.text).toContain('only from the person')
  expect((await $.tool.call({ tool: 'Skill', skill: 'foundry', args: 'approve' })).deny).toBeDefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'gh issue edit 12 --remove-label foundry:waiting' })).deny).toContain('only the Foundry mod')
  const commentId = hub.comments.get(12)?.[0]?.id
  expect((await $.tool.call({ tool: 'Bash', command: `gh api -X PATCH repos/o/r/issues/comments/${commentId} -f body=x` })).deny).toContain('state comment')
  expect((await $.tool.call({ tool: 'Write', file_path: '/tmp/x.sh', content: 'gh issue edit 12 --remove-label foundry:plan' })).deny).toContain('only the Foundry mod')
  const resolve = 'gh api graphql -f query="mutation { resolveReviewThread(input: {threadId: \\"t\\"}) { thread { id } } }"'
  expect((await $.tool.call({ tool: 'Bash', command: resolve })).deny).toBeUndefined()
  expect(hub.state(12)?.waiting?.kind).toBe('signoff')
})

test('an edit to the state comment made around the mod is restored and flagged', async ($, on) => {
  const { hub } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__foundry__batch_start', title: 'T', issues: [12] })

  // Someone flips the stage by hand, without a newer revision.
  const comment = hub.comments.get(12)?.[0]
  if (comment) comment.body = comment.body.replace('"stage":"plan"', '"stage":"ship"')
  await $.command.run({ command: 'foundry', args: 'sync', origin: { kind: 'composer' }, presentation: SHOWN })

  expect(hub.state(12)?.stage).toBe('plan')
  expect(hub.state(12)?.waiting?.kind).toBe('tamper')
})

/** A batch at its plan sign-off, every reviewer approving. */
async function toPlanSignoff($: Engine) {
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__foundry__batch_start', title: 'T', issues: [12] })
  await approveAll($)

  return $.tool.call({ tool: 'mcp__foundry__signoff_request', summary: 'Two issues, one shared slot type.' })
}

test('the person is asked at a sign-off, and their answer decides it, from wherever they are', async ($, on) => {
  const { hub, asks, clock } = engine(on)
  asks.answer = 'Approve'
  const asked = await toPlanSignoff($)
  // The agent is told where and how the person answers, the typed commands included.
  expect(String(asked.result)).toContain('`/foundry approve #12`')
  expect(String(asked.result)).toContain('(from their phone too)')

  // The agent's turn ends at the gate: the person is asked there and then.
  await $.turn.complete({ answer: 'Waiting on your sign-off.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  await clock.settle()

  expect(asks.questions).toHaveLength(1)
  expect(asks.questions[0]).toContain('Two issues, one shared slot type.')
  expect(hub.state(12)?.stage).toBe('build')
  // A later tick asks nothing more: the wait was answered.
  await clock.advance(60_000)
  expect(asks.questions).toHaveLength(1)
})

test('words typed instead of a choice ask for changes, and reach the agent as the person’s', async ($, on) => {
  const { hub, asks, clock } = engine(on)
  asks.answer = 'Split the slot type out first.'
  await toPlanSignoff($)
  await clock.advance(60_000)

  expect(hub.state(12)?.stage).toBe('plan')
  expect(hub.state(12)?.waiting).toBeUndefined()
  expect(hub.state(12)?.log.some(e => e.isForAgent === true && e.text === 'The person wrote: Split the slot type out first.')).toBe(true)
})

test('a dismissed question is not asked again; the card and the typed command still decide', async ($, on) => {
  const { hub, asks, clock } = engine(on)
  await toPlanSignoff($)
  await clock.advance(60_000)
  await clock.advance(60_000)
  expect(asks.questions).toHaveLength(1)

  // Waiting, the agent is refused and told how the person decides.
  const review = await $.tool.call({ tool: 'mcp__foundry__review_record', perspective: 'security', reviewer: 'r', verdict: 'ready', summary: 's' })
  expect(review.deny).toContain('`/foundry approve #12` or `/foundry changes #12`')
  // Typed from the phone, over Remote Control.
  const approved = await $.command.run({ command: 'foundry', args: 'approve #12', origin: { kind: 'bridge' }, presentation: SHOWN })
  expect(approved.text).toContain('Done: approve')
  expect(hub.state(12)?.stage).toBe('build')
})

test('a question answered after its gate was decided elsewhere decides nothing, not even the next gate', async ($, on) => {
  const { hub, asks, clock } = engine(on)
  let answer = () => {}
  asks.held = new Promise<void>(resolve => (answer = resolve))
  await toPlanSignoff($)
  void clock.advance(60_000)
  await clock.settle()
  expect(asks.questions).toHaveLength(1)

  // The person approves the plan on the desktop; the build reaches its own sign-off.
  await $.command.run({ command: 'foundry', args: 'approve #12', origin: { kind: 'composer' }, presentation: SHOWN })
  await approveAll($)
  await $.tool.call({ tool: 'mcp__foundry__signoff_request', summary: 'build' })

  // The plan's question, still open on the phone, is answered at last. The build sign-off is a
  // wait of its own, asked about separately: that question is left open.
  asks.answerAt = index => (index === 0 ? 'Approve' : undefined)
  answer()
  await clock.settle()

  expect(hub.state(12)?.stage).toBe('build')
  expect(hub.state(12)?.waiting?.kind).toBe('signoff')
})

test('words typed after a decision reach the agent as the person’s, and a typed decision wakes the agent', async ($, on) => {
  const { hub, prompts, clock } = engine(on)
  await toPlanSignoff($)
  const typed = await $.command.run({ command: 'foundry', args: 'changes #12 split the slot type out first', origin: { kind: 'bridge' }, presentation: SHOWN })
  expect(typed.text).toContain('Done: changes for "T" (#12)')
  expect(typed.context).toBeUndefined()
  await clock.settle()

  expect(hub.state(12)?.log.some(e => e.isForAgent === true && e.text === 'The person wrote: split the slot type out first')).toBe(true)
  expect(prompts.at(-1)).toContain('The person wrote: split the slot type out first')
})

test('a conflict’s compromise can be typed in one go, or written under Other in its question', async ($, on) => {
  const { hub, asks, clock } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__foundry__batch_start', title: 'T', issues: [12] })
  await $.tool.call({ tool: 'mcp__foundry__conflict_raise', perspectives: ['usability', 'security'], summary: 'X or Y' })
  asks.answer = 'Keep X, but behind a setting.'
  await clock.advance(60_000)
  await clock.settle()

  expect(hub.state(12)?.waiting).toBeUndefined()
  expect(hub.state(12)?.log.some(e => e.isForAgent === true && e.text === 'The person wrote: Keep X, but behind a setting.')).toBe(true)
  expect(asks.questions[0]).toContain('Or write the compromise under Other.')
  expect(asks.questions[0]).toContain('`/foundry compromise #12`')
})

test('words that answer nothing in a wait are kept: the question is asked again, and a one-choice wait offers Not yet', async ($, on) => {
  const { hub, asks, clock } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__foundry__batch_start', title: 'T', issues: [12] })
  // A restored outside edit: its one choice is OK.
  const comment = hub.comments.get(12)?.[0]
  if (comment) comment.body = comment.body.replace('"stage":"plan"', '"stage":"ship"')
  await $.command.run({ command: 'foundry', args: 'sync', origin: { kind: 'composer' }, presentation: SHOWN })
  expect(hub.state(12)?.waiting?.kind).toBe('tamper')

  asks.answerAt = index => (index === 0 ? 'what happened here?' : 'OK, restored')
  await clock.advance(60_000)
  await clock.settle()

  expect(asks.labels[0]).toEqual(['OK, restored', 'Not yet'])
  expect(asks.questions[1]).toContain('"what happened here?" doesn\'t answer this wait.')
  expect(hub.state(12)?.waiting).toBeUndefined()
})

test('Not yet decides nothing and is not asked again', async ($, on) => {
  const { hub, asks, clock } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__foundry__batch_start', title: 'T', issues: [12] })
  const comment = hub.comments.get(12)?.[0]
  if (comment) comment.body = comment.body.replace('"stage":"plan"', '"stage":"ship"')
  await $.command.run({ command: 'foundry', args: 'sync', origin: { kind: 'composer' }, presentation: SHOWN })
  asks.answer = 'Not yet'
  await clock.advance(60_000)
  await clock.advance(60_000)
  await clock.settle()

  expect(asks.questions).toHaveLength(1)
  expect(hub.state(12)?.waiting?.kind).toBe('tamper')
})

test('a wait with more than four choices groups the reviewers to overrule, and a second question picks one', { options: { maxRounds: 1 } }, async ($, on) => {
  const { hub, asks, clock } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__foundry__batch_start', title: 'T', issues: [12] })
  for (const perspective of [...REVIEWERS, 'usability']) {
    await $.tool.call({ tool: 'mcp__foundry__review_record', perspective, reviewer: `foundry:${perspective}`, verdict: 'revise', summary: 'no' })
  }
  expect(hub.state(12)?.waiting?.kind).toBe('round-limit')

  asks.answerAt = index => (index === 0 ? 'Overrule a reviewer…' : 'Veto architecture')
  await clock.advance(60_000)
  await clock.settle()

  expect(asks.labels[0]).toEqual(['Approve', 'Another round', 'Overrule a reviewer…'])
  // Four reviewers to pick from; the rest are named, to type.
  expect(asks.labels[1]).toEqual(['Veto product-owner', 'Veto usability', 'Veto accessibility', 'Veto architecture'])
  expect(asks.questions[1]).toContain('`/foundry veto security #12`')
  expect(asks.questions[1]).toContain('`/foundry veto documentation #12`')
  expect(hub.state(12)?.vetoes).toEqual(['architecture'])
})

test('ending a batch asks first, on the card and by command', async ($, on) => {
  const { hub } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__foundry__batch_start', title: 'T', issues: [12] })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: '12-end' })
  expect(await ui.find({ type: 'Text', text: /End "T"\? Its gates stop guarding/ })).toBeDefined()
  await ui.press({ key: '12-end-keep' })
  expect(await ui.find({ type: 'Text', text: /End "T"\?/ })).toBeUndefined()
  expect(hub.state(12)?.stage).toBe('plan')
  await ui.unmount()

  const asked = await $.command.run({ command: 'foundry', args: 'end #12', origin: { kind: 'composer' }, presentation: SHOWN })
  expect(asked.text).toContain('`/foundry end #12 confirm`')
  expect(hub.state(12)?.stage).toBe('plan')

  const again = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await again.press({ key: '12-end' })
  await again.press({ key: '12-end-confirm' })
  await again.unmount()
  expect(hub.state(12)?.stage).toBe('done')
})

test('the plan is copied to the lead issue when it changes, in one comment, and linked wherever it is read', async ($, on) => {
  const { hub, files, asks, clock } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__foundry__batch_start', title: 'T', issues: [12] })
  const copies = () => (hub.comments.get(12) ?? []).filter(c => c.body.includes('foundry:plan-copy'))

  // No plan file yet: nothing is copied.
  await $.tool.call({ tool: 'mcp__foundry__review_record', perspective: 'security', reviewer: 'r', verdict: 'revise', summary: 's' })
  expect(copies()).toHaveLength(0)

  files.set('/repo/docs/plans/12.md', '# Plan for T\n\nFirst draft.')
  await $.tool.call({ tool: 'mcp__foundry__review_record', perspective: 'usability', reviewer: 'r', verdict: 'ready', summary: 's' })
  expect(copies()).toHaveLength(1)
  expect(copies()[0]?.body).toContain('First draft.')
  const patches = () => hub.calls.filter(c => c.includes(`issues/comments/${copies()[0]?.id}`)).length
  const before = patches()

  // An unchanged plan isn't written again; a revised one is, in the same comment.
  await $.tool.call({ tool: 'mcp__foundry__review_record', perspective: 'accessibility', reviewer: 'r', verdict: 'ready', summary: 's' })
  expect(patches()).toBe(before)
  files.set('/repo/docs/plans/12.md', '# Plan for T\n\nRevised after review.')
  await approveAll($)
  const asked = await $.tool.call({ tool: 'mcp__foundry__signoff_request', summary: 'Plan' })
  expect(copies()).toHaveLength(1)
  expect(copies()[0]?.body).toContain('Revised after review.')
  const url = hub.state(12)?.planCopy?.url ?? ''
  expect(url).toMatch(/^https:\/\/github\.com\/o\/r\/issues\/12#issuecomment-\d+$/)

  // The link reaches the agent, the question and the card.
  expect(String(asked.result)).toContain(url)
  await clock.advance(60_000)
  expect(asks.questions[0]).toContain(`The plan: ${url}`)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Link', text: /Plan on GitHub/ })).toBeDefined()
  await ui.unmount()
})

test('a new wait reaches the person as a notification, taken back once they decide', async ($, on) => {
  const { notes } = engine(on)
  await toPlanSignoff($)
  expect(notes.sent).toHaveLength(1)
  expect(notes.sent[0]?.text).toBe('Foundry: "T" (#12) is waiting on you: Plan sign-off.')
  const key = notes.sent[0]?.key ?? ''
  expect(key).not.toBe('')

  await $.command.run({ command: 'foundry', args: 'approve #12', origin: { kind: 'bridge' }, presentation: SHOWN })
  expect(notes.taken).toEqual([key])
})

test('the card puts the request first, names each button by its batch, and says each state in words', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__foundry__batch_start', title: 'Name the ports', issues: [12] })
  const before = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // Nothing tested and no pull request yet: no Tests and CI row to read.
  expect(await before.find({ type: 'Text', text: /Tests not run/ })).toBeUndefined()
  expect(await before.find({ type: 'Text', text: /security not reviewed/ })).toBeDefined()
  await before.unmount()

  await approveAll($)
  await $.tool.call({ tool: 'mcp__foundry__tests_record', command: 'npm test', passed: true, summary: 'ok' })
  await $.tool.call({ tool: 'mcp__foundry__signoff_request', summary: 'The plan' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // It draws "Approve"; its name, which a screen reader reads, says which batch. It takes the keys first.
  const approve = await ui.find({ key: '12-approve' })
  expect(approve?.text).toBe('Approve')
  expect(approve?.props).toMatchObject({ label: 'Approve: Name the ports', autoFocus: true })
  expect(await ui.find({ type: 'Text', text: /security ready/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Tests pass/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /CI not run/ })).toBeDefined()
  await ui.unmount()
})

test('commands read kindly: any case, aliases, and a miss names what does apply', async ($, on) => {
  const { hub, files } = engine(on)
  await toPlanSignoff($)
  files.set('/repo/docs/plans/12.md', '# Plan for T\n\nSlots first.')

  const wrong = await $.command.run({ command: 'foundry', args: 'compromise #12', origin: { kind: 'bridge' }, presentation: SHOWN })
  expect(wrong.text).toContain('#12 is waiting on Plan sign-off: type `/foundry approve #12`, `/foundry changes #12`.')

  const status = await $.command.run({ command: 'foundry', args: 'status', origin: { kind: 'bridge' }, presentation: SHOWN })
  expect(status.text).toContain('Waiting on you: Plan sign-off. Type `/foundry approve #12`, `/foundry changes #12`.')
  const plan = await $.command.run({ command: 'foundry', args: 'Plan #12', origin: { kind: 'bridge' }, presentation: SHOWN })
  expect(plan.text).toContain('Slots first.')

  // A phone keyboard's capital, and the word people reach for.
  const typed = await $.command.run({ command: 'foundry', args: 'Approve #12', origin: { kind: 'bridge' }, presentation: SHOWN })
  expect(typed.text).toContain('Done: approve')
  expect(hub.state(12)?.stage).toBe('build')
  const pane = await $.command.run({ command: 'foundry', args: 'pane', origin: { kind: 'bridge' }, presentation: SHOWN })
  expect(pane.text).toBe('Foundry pane opened.')
})

test("a card shows the batch's plan file from this checkout, at a press", async ($, on) => {
  const { files } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const started = await $.tool.call({ tool: 'mcp__foundry__batch_start', title: 'T', issues: [12] })
  expect(String(started.result)).toContain('Plan: docs/plans/12.md')
  // The plan stage lets the agent write the plan, and still no code.
  expect((await $.tool.call({ tool: 'Write', file_path: '/repo/docs/plans/12.md', content: '# Plan' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Write', file_path: '/repo/docs/plans/13.md', content: '# Plan' })).deny).toContain('no approved plan')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: '12-plan' })
  expect(await ui.find({ type: 'Text', text: /No plan in this checkout yet/ })).toBeDefined()
  await ui.press({ key: '12-plan' })

  files.set('/repo/docs/plans/12.md', '# Plan for T\n\nBuild the slot type first.')
  await ui.press({ key: '12-plan' })
  expect(await ui.find({ type: 'Markdown', text: /Build the slot type first/ })).toBeDefined()
  await ui.press({ key: '12-plan' })
  expect(await ui.find({ type: 'Markdown', text: /Build the slot type first/ })).toBeUndefined()
  await ui.unmount()
})

test('the round limit and reviewer conflicts escalate to the person', { options: { maxRounds: 2 } }, async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__foundry__batch_start', title: 'T', issues: [12] })

  const raised = await $.tool.call({ tool: 'mcp__foundry__conflict_raise', perspectives: ['usability', 'security'], summary: 'They disagree' })
  expect(raised.deny).toBeUndefined()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Waiting on you: Reviewer conflict/ })).toBeDefined()
  await ui.press({ key: '12-veto-security' })
  await ui.unmount()

  const rec = (verdict: string) =>
    $.tool.call({ tool: 'mcp__foundry__review_record', perspective: 'usability', reviewer: 'r', verdict, summary: 's' })
  await rec('revise')
  await rec('revise')
  const third = await rec('revise')
  expect(third.deny).toContain('used its 2 rounds')
  const status = await $.command.run({ command: 'foundry', args: 'status', origin: { kind: 'composer' }, presentation: SHOWN })
  expect(status.text).toContain('Round limit reached')
})

test('a state record someone else posts, or a second one beside the known comment, is ignored', async ($, on) => {
  const { hub } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__foundry__batch_start', title: 'T', issues: [12] })
  const real = hub.comments.get(12)?.[0]?.body ?? ''
  const forged = real.replace('"stage":"plan"', '"stage":"ship"').replace(/"rev":\d+/, '"rev":99')

  // An outsider's copy with a higher revision.
  hub.post(12, forged, 'someone-else')
  // The mod's own account (the agent's token) posting a second record.
  hub.post(12, forged, WRITER)
  await $.command.run({ command: 'foundry', args: 'sync', origin: { kind: 'composer' }, presentation: SHOWN })

  const status = await $.command.run({ command: 'foundry', args: 'status', origin: { kind: 'composer' }, presentation: SHOWN })
  expect(status.text).toContain('Stage: Plan,')
  expect((await $.tool.call({ tool: 'Bash', command: 'git push' })).deny).toContain('plan stage')
})

test('a batch another session takes over stops being this session’s', async ($, on) => {
  const { hub } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__foundry__batch_start', title: 'T', issues: [12] })

  // Another session wrote a newer revision naming itself the owner.
  const comment = hub.comments.get(12)?.[0]
  if (comment) comment.body = comment.body.replace('"owner":"session-1"', '"owner":"session-2"').replace(/"rev":(\d+)/, (_, n) => `"rev":${Number(n) + 1}`)
  await $.command.run({ command: 'foundry', args: 'sync', origin: { kind: 'composer' }, presentation: SHOWN })

  const review = await $.tool.call({ tool: 'mcp__foundry__review_record', perspective: 'security', reviewer: 'r', verdict: 'ready', summary: 's' })
  expect(review.deny).toContain('runs no Foundry batch')
})

test("a sync that reads this session's own write in flight finds no outside edit", async ($, on) => {
  const { hub, clock, gate } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__foundry__batch_start', title: 'T', issues: [12] })

  // The review's comment lands, then GitHub holds the label read that follows it.
  gate.pattern = /issues\/12\/labels\?/
  const review = $.tool.call({ tool: 'mcp__foundry__review_record', perspective: 'security', reviewer: 'r', verdict: 'ready', summary: 's' })
  await clock.settle()
  // A sync reads GitHub in that window: the new revision is there, the write not yet done.
  const synced = $.command.run({ command: 'foundry', args: 'sync', origin: { kind: 'composer' }, presentation: SHOWN })
  await clock.settle()
  gate.open()
  expect((await review).deny).toBeUndefined()
  await synced

  expect(hub.state(12)?.waiting).toBeUndefined()
  expect(hub.state(12)?.log.some(e => e.text.includes('outside edit'))).toBe(false)
})

test('changes queued behind a write in flight each build on the one before, never on the copy their dispatch began with', async ($, on) => {
  const { hub, clock, gate } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__foundry__batch_start', title: 'T', issues: [12] })

  // GitHub holds the first review's write; two more reviews queue behind it, each in its own dispatch.
  gate.pattern = /-X PATCH .*issues\/comments\//
  const record = (perspective: string) =>
    $.tool.call({ tool: 'mcp__foundry__review_record', perspective, reviewer: `foundry:${perspective}`, verdict: 'ready', summary: 'fine' })
  const first = record('security')
  await clock.settle()
  const second = record('architecture')
  const third = record('usability')
  await clock.settle()
  gate.open()
  for (const call of [first, second, third]) expect((await call).deny).toBeUndefined()
  await clock.settle()

  // Each review read the batch as the one before it left it: all three are kept, one revision each after the start's.
  const state = hub.state(12)
  expect(state?.reviews.map(r => r.perspective).sort()).toEqual(['architecture', 'security', 'usability'])
  expect(state?.rev).toBe(4)
})

test('a session that wrote a batch before it was taken over never flags or rewrites the new owner’s state', async ($, on) => {
  const { hub } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__foundry__batch_start', title: 'T', issues: [12] })
  const sync = () => $.command.run({ command: 'foundry', args: 'sync', origin: { kind: 'composer' }, presentation: SHOWN })
  /** Another session's write: itself the owner, one revision on, with a change of its own. */
  const ownerWrites = (title: string) => {
    const comment = hub.comments.get(12)?.[0]
    if (comment) {
      comment.body = comment.body
        .replace('"owner":"session-1"', '"owner":"session-2"')
        .replace(/"title":"[^"]*"/, `"title":"${title}"`)
        .replace(/"rev":(\d+)/, (_, n) => `"rev":${Number(n) + 1}`)
    }
  }

  ownerWrites('Taken over')
  await sync()
  const patches = () => hub.calls.filter(c => c.includes('-X PATCH')).length
  const before = patches()
  // GitHub still holds the owner's copy, which this session now holds too: nothing to restore.
  await sync()
  ownerWrites('Moved on')
  await sync()
  await sync()

  expect(patches()).toBe(before)
  expect(hub.state(12)?.waiting).toBeUndefined()
  expect(hub.state(12)?.title).toBe('Moved on')
})

test("a takeover that lands while this session's own write is failing is kept, not restored over", async ($, on) => {
  const { hub } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__foundry__batch_start', title: 'T', issues: [12] })
  // This session's next revision never reaches GitHub.
  hub.failOnce(/-X PATCH .*issues\/comments\//)
  await $.tool.call({ tool: 'mcp__foundry__review_record', perspective: 'security', reviewer: 'r', verdict: 'ready', summary: 's' })

  // Another session takes over from GitHub's copy: the same revision number, its own content.
  const comment = hub.comments.get(12)?.[0]
  if (comment) {
    comment.body = comment.body
      .replace('"owner":"session-1"', '"owner":"session-2"')
      .replace(/"title":"[^"]*"/, '"title":"Taken over"')
      .replace(/"rev":(\d+)/, (_, n) => `"rev":${Number(n) + 1}`)
  }
  await $.command.run({ command: 'foundry', args: 'sync', origin: { kind: 'composer' }, presentation: SHOWN })

  expect(hub.state(12)?.owner).toBe('session-2')
  expect(hub.state(12)?.title).toBe('Taken over')
  expect(hub.state(12)?.waiting).toBeUndefined()
  const review = await $.tool.call({ tool: 'mcp__foundry__review_record', perspective: 'usability', reviewer: 'r', verdict: 'ready', summary: 's' })
  expect(review.deny).toContain('runs no Foundry batch')
})

/** Rewrites the state comment on #12 as another hand would: `bump` revisions on, the rest as `edit` says. */
function rewriteState(hub: ReturnType<typeof engine>['hub'], bump: number, edit: (body: string) => string) {
  const comment = hub.comments.get(12)?.[0]
  if (comment) comment.body = edit(comment.body).replace(/"rev":(\d+)/, (_, n) => `"rev":${Number(n) + bump}`)
}

test('an edit that names another owner without a newer revision is restored and flagged, not taken as a takeover', async ($, on) => {
  const { hub } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__foundry__batch_start', title: 'T', issues: [12] })

  rewriteState(hub, 0, body => body.replace('"owner":"session-1"', '"owner":"session-2"'))
  await $.command.run({ command: 'foundry', args: 'sync', origin: { kind: 'composer' }, presentation: SHOWN })

  expect(hub.state(12)?.owner).toBe('session-1')
  expect(hub.state(12)?.waiting?.kind).toBe('tamper')
  // The session still runs the batch: it waits on the person, not on another session.
  const review = await $.tool.call({ tool: 'mcp__foundry__review_record', perspective: 'security', reviewer: 'r', verdict: 'ready', summary: 's' })
  expect(review.deny).toContain('State edited outside Foundry')
})

test('writes still failing are not retried over a takeover at a revision between them', async ($, on) => {
  const { hub } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__foundry__batch_start', title: 'T', issues: [12] })
  // Two revisions of this session's never reach GitHub: its copy runs two ahead.
  for (const perspective of ['security', 'usability']) {
    hub.failOnce(/-X PATCH .*issues\/comments\//)
    await $.tool.call({ tool: 'mcp__foundry__review_record', perspective, reviewer: 'r', verdict: 'ready', summary: 's' })
  }

  // Another session takes over from GitHub's copy, one revision on: behind this session's copy.
  rewriteState(hub, 1, body => body.replace('"owner":"session-1"', '"owner":"session-2"').replace(/"title":"[^"]*"/, '"title":"Taken over"'))
  await $.command.run({ command: 'foundry', args: 'sync', origin: { kind: 'composer' }, presentation: SHOWN })

  expect(hub.state(12)?.owner).toBe('session-2')
  expect(hub.state(12)?.title).toBe('Taken over')
  expect(hub.state(12)?.waiting).toBeUndefined()
  const review = await $.tool.call({ tool: 'mcp__foundry__review_record', perspective: 'architecture', reviewer: 'r', verdict: 'ready', summary: 's' })
  expect(review.deny).toContain('runs no Foundry batch')
})

test("this session's own takeover whose write failed is retried, though GitHub still names the owner it took over from", async ($, on) => {
  const { hub } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__foundry__batch_start', title: 'T', issues: [12] })
  // Another session takes the batch, and this session's sync accepts that.
  rewriteState(hub, 1, body => body.replace('"owner":"session-1"', '"owner":"session-2"'))
  await $.command.run({ command: 'foundry', args: 'sync', origin: { kind: 'composer' }, presentation: SHOWN })

  // This session takes it back, but that write fails.
  hub.failOnce(/-X PATCH .*issues\/comments\//)
  await $.tool.call({ tool: 'mcp__foundry__batch_start', title: 'T', issues: [12] })
  expect(hub.state(12)?.owner).toBe('session-2')
  await $.command.run({ command: 'foundry', args: 'sync', origin: { kind: 'composer' }, presentation: SHOWN })

  expect(hub.state(12)?.owner).toBe('session-1')
  expect(hub.state(12)?.waiting).toBeUndefined()
})

/** Deletes #12's state comment and posts `edit` of it afresh, as the mod's own account: a new comment id. */
function repostState(hub: ReturnType<typeof engine>['hub'], bump: number, edit: (body: string) => string) {
  const old = hub.comments.get(12)?.[0]?.body ?? ''
  hub.comments.set(12, [])
  hub.post(12, edit(old).replace(/"rev":(\d+)/, (_, n) => `"rev":${Number(n) + bump}`), WRITER)
}

test('a state comment deleted and posted again, with nothing newer, is restored and flagged', async ($, on) => {
  const { hub } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__foundry__batch_start', title: 'T', issues: [12] })

  repostState(hub, 0, body => body.replace('"stage":"plan"', '"stage":"ship"'))
  await $.command.run({ command: 'foundry', args: 'sync', origin: { kind: 'composer' }, presentation: SHOWN })

  // Restored into the comment that is there, not posted beside it.
  expect((hub.comments.get(12) ?? []).filter(c => c.body.includes('foundry:state')).length).toBe(1)
  expect(hub.state(12)?.stage).toBe('plan')
  expect(hub.state(12)?.waiting?.kind).toBe('tamper')
})

test('a takeover posted as a new comment stands, even over a write of this session that failed', async ($, on) => {
  const { hub } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__foundry__batch_start', title: 'T', issues: [12] })
  hub.failOnce(/-X PATCH .*issues\/comments\//)
  await $.tool.call({ tool: 'mcp__foundry__review_record', perspective: 'security', reviewer: 'r', verdict: 'ready', summary: 's' })

  // The comment is gone; another session takes over, one revision past GitHub's, in a comment of its own.
  repostState(hub, 1, body => body.replace('"owner":"session-1"', '"owner":"session-2"').replace(/"title":"[^"]*"/, '"title":"Taken over"'))
  await $.command.run({ command: 'foundry', args: 'sync', origin: { kind: 'composer' }, presentation: SHOWN })

  const states = (hub.comments.get(12) ?? []).filter(c => c.body.includes('foundry:state'))
  expect(states.length).toBe(1)
  expect(hub.state(12)?.owner).toBe('session-2')
  expect(hub.state(12)?.title).toBe('Taken over')
  const review = await $.tool.call({ tool: 'mcp__foundry__review_record', perspective: 'usability', reviewer: 'r', verdict: 'ready', summary: 's' })
  expect(review.deny).toContain('runs no Foundry batch')
})

test('a takeover posted as a new comment past writes still failing stands at the next sync too', async ($, on) => {
  const { hub } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__foundry__batch_start', title: 'T', issues: [12] })
  // Two revisions never land: this session's copy runs two ahead of GitHub, one ahead of the takeover.
  for (const perspective of ['security', 'usability']) {
    hub.failOnce(/-X PATCH .*issues\/comments\//)
    await $.tool.call({ tool: 'mcp__foundry__review_record', perspective, reviewer: 'r', verdict: 'ready', summary: 's' })
  }
  repostState(hub, 1, body => body.replace('"owner":"session-1"', '"owner":"session-2"').replace(/"title":"[^"]*"/, '"title":"Taken over"'))

  for (let i = 0; i < 2; i++) await $.command.run({ command: 'foundry', args: 'sync', origin: { kind: 'composer' }, presentation: SHOWN })

  expect((hub.comments.get(12) ?? []).filter(c => c.body.includes('foundry:state')).length).toBe(1)
  expect(hub.state(12)?.owner).toBe('session-2')
  expect(hub.state(12)?.title).toBe('Taken over')
  // This session's own copy holds the takeover too, not its copy from before.
  const status = await $.command.run({ command: 'foundry', args: 'status #12', origin: { kind: 'composer' }, presentation: SHOWN })
  expect(status.text).toContain('Taken over')
})

test('an outside edit to a batch another session runs is left to that session to restore', async ($, on) => {
  const { hub } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__foundry__batch_start', title: 'T', issues: [12] })
  rewriteState(hub, 1, body => body.replace('"owner":"session-1"', '"owner":"session-2"'))
  await $.command.run({ command: 'foundry', args: 'sync', origin: { kind: 'composer' }, presentation: SHOWN })
  const patches = () => hub.calls.filter(c => c.includes('-X PATCH')).length
  const before = patches()

  // Someone flips the stage by hand: session-2 runs the batch, so this session writes nothing.
  rewriteState(hub, 0, body => body.replace('"stage":"plan"', '"stage":"ship"'))
  await $.command.run({ command: 'foundry', args: 'sync', origin: { kind: 'composer' }, presentation: SHOWN })

  expect(patches()).toBe(before)
})

test('a write that does not reach GitHub is reported and retried at the next sync', async ($, on) => {
  const { hub } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__foundry__batch_start', title: 'T', issues: [12] })
  await approveAll($)
  await $.tool.call({ tool: 'mcp__foundry__signoff_request', summary: 'plan' })

  hub.failOnce(/-X PATCH .*issues\/comments\//)
  const approved = await $.command.run({ command: 'foundry', args: 'approve', origin: { kind: 'composer' }, presentation: SHOWN })
  expect(approved.text).toContain('Not saved to GitHub yet')
  expect(hub.state(12)?.stage).toBe('plan')

  await $.command.run({ command: 'foundry', args: 'sync', origin: { kind: 'composer' }, presentation: SHOWN })
  expect(hub.state(12)?.stage).toBe('build')
})

test('pr_opened brings its news back in the result, without submitting a prompt from the tool call', async ($, on) => {
  const { prompts } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__foundry__batch_start', title: 'T', issues: [12] })
  await approveAll($)
  await $.tool.call({ tool: 'mcp__foundry__signoff_request', summary: 'plan' })
  await $.command.run({ command: 'foundry', args: 'approve', origin: { kind: 'composer' }, presentation: SHOWN })
  await approveAll($)
  await $.tool.call({ tool: 'mcp__foundry__signoff_request', summary: 'build' })
  await $.command.run({ command: 'foundry', args: 'approve', origin: { kind: 'composer' }, presentation: SHOWN })

  const before = prompts.length
  const opened = await $.tool.call({ tool: 'mcp__foundry__pr_opened', pr: '9' })
  expect(prompts.length).toBe(before)
  expect(String(opened.result)).toContain('Watching pull request #9')
})

test('a shell write to the repository is held in the plan stage; elsewhere it is not', async ($, on) => {
  const { ran } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__foundry__batch_start', title: 'T', issues: [12] })

  expect((await $.tool.call({ tool: 'Bash', command: 'printf x > src/a.ts' })).deny).toContain('shell write to src/a.ts')
  expect((await $.tool.call({ tool: 'Bash', command: "sed -i '' s/a/b/ /repo/src/b.ts" })).deny).toContain('no approved plan')
  expect((await $.tool.call({ tool: 'Bash', command: 'npm test > /tmp/out.txt 2>&1' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'echo note >> /repo/.claude/plan.md' })).deny).toBeUndefined()
  expect(ran).toEqual(['npm test > /tmp/out.txt 2>&1', 'echo note >> /repo/.claude/plan.md'])
})

test('with no foundry.yaml, the plugin settings apply and the signed-in account is the maintainer', async ($, on) => {
  const { hub } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const started = await $.tool.call({ tool: 'mcp__foundry__batch_start', title: 'T', issues: [12] })

  expect(String(started.result)).toContain("No foundry.yaml on main: the plugin's settings apply.")
  expect(hub.state(12)?.onlineReviewers).toEqual(['coderabbitai'])
  expect(hub.state(12)?.maintainers).toEqual([WRITER])
  expect(String(started.result)).toContain(`Allowlist: act only on PR comments from coderabbitai, ${WRITER}.`)
})

/** Takes a fresh batch through both sign-offs to an open, green pull request #9. */
async function toShip($: Engine) {
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__foundry__batch_start', title: 'T', issues: [12] })
  for (const stage of ['plan', 'build']) {
    await approveAll($)
    await $.tool.call({ tool: 'mcp__foundry__signoff_request', summary: stage })
    await $.command.run({ command: 'foundry', args: 'approve', origin: { kind: 'composer' }, presentation: SHOWN })
  }
  await $.tool.call({ tool: 'mcp__foundry__pr_opened', pr: '9' })
}

const RED = {
  commits: {
    nodes: [
      {
        commit: {
          committedDate: new Date(0).toISOString(),
          statusCheckRollup: { contexts: { nodes: [{ __typename: 'CheckRun' as const, name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }] } },
        },
      },
    ],
  },
}

test('a dropped wake is sent again on the next tick, and never twice while one is pending', async ($, on) => {
  const { hub, prompts, submit, clock } = engine(on)
  await toShip($)
  hub.setPr(RED)

  // The timer reads the failure and tries to tell the agent; the prompt is dropped.
  submit.mode = 'drop'
  await clock.advance(60_000)
  const tries = prompts.filter(p => p.includes('CI failed')).length
  expect(tries).toBe(1)

  // Next tick: held while the session is busy. Further ticks send nothing more.
  submit.mode = 'hold'
  void clock.advance(60_000)
  await clock.settle()
  void clock.advance(60_000)
  await clock.settle()
  expect(prompts.filter(p => p.includes('CI failed')).length).toBe(2)

  // Accepted at last: nothing is sent again after that.
  submit.mode = 'accept'
  submit.release()
  await clock.settle()
  await clock.advance(60_000)
  expect(prompts.filter(p => p.includes('CI failed')).length).toBe(2)
})

test("a send-back made while a poll's write is in flight lands after it, not under it", async ($, on) => {
  const { hub, clock, gate } = engine(on)
  await toShip($)
  hub.setPr(RED)

  // The poll reads the failure and starts writing it; GitHub holds that write.
  gate.pattern = /-X PATCH .*issues\/comments\//
  void clock.advance(60_000)
  await clock.settle()

  // The agent sends the work back meanwhile; it waits for the poll's write.
  const back = $.tool.call({ tool: 'mcp__foundry__send_back', reason: 'ci-failure', summary: 'unit tests' })
  await clock.settle()
  gate.open()
  expect((await back).deny).toBeUndefined()

  expect(hub.state(12)?.stage).toBe('build')
  expect(hub.state(12)?.rounds.ship).toBe(2)
})

test("a write whose comment landed but whose labels did not is finished, not flagged as tampering", async ($, on) => {
  const { hub } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__foundry__batch_start', title: 'T', issues: [12] })
  await approveAll($)
  await $.tool.call({ tool: 'mcp__foundry__signoff_request', summary: 'plan' })

  hub.failOnce(/-X POST repos\/o\/r\/issues\/12\/labels/)
  const approved = await $.command.run({ command: 'foundry', args: 'approve', origin: { kind: 'composer' }, presentation: SHOWN })
  expect(approved.text).toContain('Not saved to GitHub yet')
  expect(hub.state(12)?.stage).toBe('build')
  expect(hub.labels.get(12)).not.toContain('foundry:build')

  await $.command.run({ command: 'foundry', args: 'sync', origin: { kind: 'composer' }, presentation: SHOWN })
  expect(hub.state(12)?.waiting).toBeUndefined()
  expect(hub.labels.get(12)).toEqual(['foundry', 'foundry:build'])
})

test('a first write whose labels fail keeps its comment, and the retry posts no second one', async ($, on) => {
  const { hub } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })

  hub.failOnce(/-X POST repos\/o\/r\/issues\/12\/labels/)
  const started = await $.tool.call({ tool: 'mcp__foundry__batch_start', title: 'T', issues: [12] })
  expect(String(started.result)).toContain('Could not write the state to GitHub yet')
  expect(hub.comments.get(12)).toHaveLength(1)
  expect(hub.labels.get(12) ?? []).toEqual([])

  // Without its label the issue is not listed, so only this session knows the batch: it finishes the write.
  await $.command.run({ command: 'foundry', args: 'sync', origin: { kind: 'composer' }, presentation: SHOWN })
  expect(hub.comments.get(12)).toHaveLength(1)
  expect(hub.labels.get(12)).toEqual(['foundry', 'foundry:plan'])
  expect(hub.state(12)?.waiting).toBeUndefined()
})

test('a sync says when its retry fails again or GitHub cannot be read, and only then', async ($, on) => {
  const { hub } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__foundry__batch_start', title: 'T', issues: [12] })
  await approveAll($)
  await $.tool.call({ tool: 'mcp__foundry__signoff_request', summary: 'plan' })
  const sync = () => $.command.run({ command: 'foundry', args: 'sync', origin: { kind: 'composer' }, presentation: SHOWN })

  hub.failOnce(/-X PATCH .*issues\/comments\//)
  await $.command.run({ command: 'foundry', args: 'approve', origin: { kind: 'composer' }, presentation: SHOWN })

  // The retry fails too: the write is still pending, and the sync says so.
  hub.failOnce(/-X PATCH .*issues\/comments\//)
  const retried = await sync()
  expect(retried.text).toContain('Not saved to GitHub yet: "T" (#12)')
  expect(hub.state(12)?.stage).toBe('plan')

  // GitHub cannot be read at all.
  hub.failOnce(/^issue list/)
  const unread = await sync()
  expect(unread.text).toContain('Could not sync from GitHub')
  expect(unread.text).not.toContain('Synced the batches')

  // The next sync lands the write and reports nothing pending.
  const landed = await sync()
  expect(landed.text).toBe('Synced the batches from GitHub.')
  expect(hub.state(12)?.stage).toBe('build')
})

test('docs come first: the plan loop writes requirements and specs, and a reviewer sub-agent never edits code', async ($, on) => {
  const { ran } = engine(on)
  // Two sub-agents run in this session: a Foundry reviewer and the oversight agent's general helper.
  on('agent.list', () => ({
    value: [
      { id: 'po-1', type: 'foundry:product-owner', description: 'requirements', status: 'running' },
      { id: 'gp-1', type: 'general-purpose', description: 'helper', status: 'running' },
    ] as never,
  }))
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const started = await $.tool.call({ tool: 'mcp__foundry__batch_start', title: 'T', issues: [12] })
  // No doc folders exist in the checkout here, so the usual ones are where the authors start them.
  expect(String(started.result)).toContain('Docs: requirements docs/product; specifications docs/design; decisions docs/adr')

  const prd = { tool: 'Write', file_path: '/repo/docs/product/slots.md', content: '# Slots' } as const
  expect((await $.tool.call({ ...prd, agentId: 'po-1' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Write', file_path: '/repo/src/slot.rs', content: 'x', agentId: 'po-1' })).deny).toContain("doesn't edit")
  expect((await $.tool.call({ tool: 'Bash', command: 'git commit -am docs', agentId: 'po-1' })).deny).toContain("doesn't commit")
  expect((await $.tool.call({ tool: 'Bash', command: 'printf x > src/slot.rs', agentId: 'po-1' })).deny).toContain("doesn't edit")
  // The oversight agent and its helpers are held by the stage, as before.
  expect((await $.tool.call({ tool: 'Write', file_path: '/repo/src/slot.rs', content: 'x', agentId: 'gp-1' })).deny).toContain('no approved plan')
  expect(ran).toEqual([])

  // After the plan sign-off the reviewer goes back to reading only.
  await approveAll($)
  await $.tool.call({ tool: 'mcp__foundry__signoff_request', summary: 'plan and docs' })
  await $.command.run({ command: 'foundry', args: 'approve', origin: { kind: 'composer' }, presentation: SHOWN })
  expect((await $.tool.call({ ...prd, agentId: 'po-1' })).deny).toContain("doesn't edit")
  expect((await $.tool.call({ tool: 'Write', file_path: '/repo/src/slot.rs', content: 'x' })).deny).toBeUndefined()
})

test('a link inside a doc folder, or a shell target the guard cannot place, carries no write into the code', async ($, on) => {
  const { ran } = engine(on)
  on('agent.list', () => ({ value: [{ id: 'po-1', type: 'foundry:product-owner', description: 'requirements', status: 'running' }] as never }))
  // docs/product/code is a link to src.
  on('fs.stat', (_, e) => ({
    value: { kind: 'file', size: 0, mtimeMs: 0, isLink: false, realPath: e.path.replace(/^\/repo\/docs\/product\/code(?=\/|$)/, '/repo/src') } as never,
  }))
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__foundry__batch_start', title: 'T', issues: [12] })

  const throughLink = { tool: 'Write', file_path: '/repo/docs/product/code/slot.rs', content: 'x' } as const
  expect((await $.tool.call({ ...throughLink, agentId: 'po-1' })).deny).toContain("doesn't edit")
  expect((await $.tool.call(throughLink)).deny).toContain('no approved plan')
  expect((await $.tool.call({ tool: 'Write', file_path: '/repo/docs/product/slots.md', content: '# Slots', agentId: 'po-1' })).deny).toBeUndefined()

  expect((await $.tool.call({ tool: 'Bash', command: 'printf x > "$PWD/src/a.ts"' })).deny).toContain('no approved plan')
  expect((await $.tool.call({ tool: 'Bash', command: 'printf x > "$OUT/a.ts"' })).deny).toContain("can't place")
  expect((await $.tool.call({ tool: 'Bash', command: 'printf x > "$OUT/a.ts"', agentId: 'po-1' })).deny).toContain("can't place")
  expect(ran).toEqual([])
})

test('a doc folder that is itself a link still takes its plan-loop edits, by Edit and by shell', async ($, on) => {
  const { ran } = engine(on)
  on('agent.list', () => ({ value: [{ id: 'po-1', type: 'foundry:product-owner', description: 'requirements', status: 'running' }] as never }))
  // docs/product is a link to /repo/product.
  on('fs.stat', (_, e) => ({
    value: { kind: 'file', size: 0, mtimeMs: 0, isLink: false, realPath: e.path.replace(/^\/repo\/docs\/product(?=\/|$)/, '/repo/product') } as never,
  }))
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__foundry__batch_start', title: 'T', issues: [12] })

  const prd = { tool: 'Write', file_path: '/repo/docs/product/slots.md', content: '# Slots' } as const
  expect((await $.tool.call({ ...prd, agentId: 'po-1' })).deny).toBeUndefined()
  expect((await $.tool.call(prd)).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'printf x >> docs/product/slots.md', agentId: 'po-1' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'printf x >> docs/product/slots.md' })).deny).toBeUndefined()
  // The link's target outside the doc folders is still code.
  expect((await $.tool.call({ tool: 'Write', file_path: '/repo/product/../src/a.ts', content: 'x', agentId: 'po-1' })).deny).toContain("doesn't edit")
  expect(ran).toEqual(['printf x >> docs/product/slots.md', 'printf x >> docs/product/slots.md'])
})

test('a plan folder that is a link still takes the plan, by Edit and by shell, and nothing else', async ($, on) => {
  const { ran } = engine(on)
  // docs/plans is a link to /repo/plan-files.
  on('fs.stat', (_, e) => ({
    value: { kind: 'file', size: 0, mtimeMs: 0, isLink: false, realPath: e.path.replace(/^\/repo\/docs\/plans(?=\/|$)/, '/repo/plan-files') } as never,
  }))
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__foundry__batch_start', title: 'T', issues: [12] })

  expect((await $.tool.call({ tool: 'Write', file_path: '/repo/docs/plans/12.md', content: '# Plan' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'printf x >> docs/plans/12.md' })).deny).toBeUndefined()
  // Another file through the same link is still held.
  expect((await $.tool.call({ tool: 'Write', file_path: '/repo/docs/plans/13.md', content: 'x' })).deny).toContain('no approved plan')
  expect(ran).toEqual(['printf x >> docs/plans/12.md'])
})

test('with no batch, nothing is guarded but merging, and the panel says so', async ($, on) => {
  const { ran } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })

  expect((await $.tool.call({ tool: 'Bash', command: 'git push' })).deny).toBeUndefined()
  expect(ran).toEqual(['git push'])
  expect((await $.tool.call({ tool: 'Bash', command: 'gh pr merge 3' })).deny).toContain('the person merges')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /No Foundry batches/ }))?.text).toBe('No Foundry batches')
  await ui.unmount()
})

// ---------------------------------------------------------------------------
// The decision card under the agent's own tool row, in the transcript.

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
/** The id of the newest tool row that opened a wait. */
function lastRow(rows: string[]): string {
  const id = rows.at(-1)
  expect(id).toBeDefined()

  return id ?? ''
}

/** A tool's row in the transcript, as the engine asks the plugins to draw it once the call has resolved. */
function toolRow(tool: string, id: string, input: Record<string, unknown> = {}) {
  return {
    plugin: 'foundry',
    component: 'ToolUse',
    requestId: id,
    props: { tool_use_id: id, tool, input, isRunning: false, isErrored: false, isInterrupted: false },
  } as const
}

test("the agent's sign-off row draws the wait's card on every surface, and a press there decides it", async ($, on) => {
  const { hub, prompts, rows } = engine(on)
  await toPlanSignoff($)
  const id = lastRow(rows)
  const row = toolRow('mcp__foundry__signoff_request', id, { summary: 'Two issues, one shared slot type.' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...row, surface })
    expect(await ui.find({ type: 'Text', text: /Waiting on you: Plan sign-off · just now/ })).toBeDefined()
    // The panel's buttons, by the panel's keys and accessible names, and the typed commands beside them.
    expect((await ui.find({ key: '12-approve' }))?.props).toMatchObject({ label: 'Approve: T', variant: 'primary' })
    expect((await ui.find({ key: '12-changes' }))?.text).toBe('Request changes')
    expect(await ui.find({ type: 'Text', text: /Or type \/foundry approve #12 · \/foundry changes #12/ })).toBeDefined()
    // In the mobile app, the border on the Box that holds the row is what asks for a card under it.
    if (surface === 'mobile') expect((await ui.find({ type: 'Box' }))?.props).toMatchObject({ borderStyle: 'round' })
    await ui.unmount()
  }

  // Pressed in the mobile app, over Remote Control: the sign-off is decided and the agent woken.
  const phone = await $.ui.mount({ ...row, surface: 'mobile' })
  await phone.press({ key: '12-approve' })
  expect(hub.state(12)?.stage).toBe('build')
  expect(prompts.at(-1)).toContain('approved the plan')
  await phone.unmount()

  // Decided, the row says so and offers nothing more.
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...row, surface })
    expect(await ui.find({ type: 'Text', text: /Foundry: decided\./ })).toBeDefined()
    expect(await ui.find({ key: '12-approve' })).toBeUndefined()
    await ui.unmount()
  }
})

test("an earlier sign-off's row offers nothing once decided, not even the sign-off that followed it", async ($, on) => {
  const { hub, rows } = engine(on)
  await toPlanSignoff($)
  const plan = toolRow('mcp__foundry__signoff_request', lastRow(rows))
  // The plan's card, open on the phone while the person decides at the desk.
  const phone = await $.ui.mount({ ...plan, surface: 'mobile' })
  expect(await phone.find({ key: '12-approve' })).toBeDefined()

  await $.command.run({ command: 'foundry', args: 'approve #12', origin: { kind: 'composer' }, presentation: SHOWN })
  await approveAll($)
  await $.tool.call({ tool: 'mcp__foundry__signoff_request', summary: 'The change' })
  const build = toolRow('mcp__foundry__signoff_request', lastRow(rows))
  expect(build.requestId).not.toBe(plan.requestId)

  // The batch waits again, on a sign-off of the same kind: the plan's row stays decided, its buttons gone.
  expect(await phone.find({ type: 'Text', text: /Foundry: decided\./ })).toBeDefined()
  expect(await phone.find({ key: '12-approve' })).toBeUndefined()
  expect(await phone.find({ key: '12-changes' })).toBeUndefined()
  await phone.unmount()
  expect(hub.state(12)?.stage).toBe('build')
  expect(hub.state(12)?.waiting?.kind).toBe('signoff')

  // The build sign-off is answered under its own row.
  const now = await $.ui.mount({ ...build, surface: 'mobile' })
  expect(await now.find({ type: 'Text', text: /Waiting on you: Build sign-off/ })).toBeDefined()
  await now.press({ key: '12-changes' })
  await now.unmount()
  expect(hub.state(12)?.stage).toBe('build')
  expect(hub.state(12)?.waiting).toBeUndefined()
})

test('a conflict and the round limit draw their cards under the rows that raised them; other rows draw as they are', { options: { maxRounds: 2 } }, async ($, on) => {
  const { hub, rows } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__foundry__batch_start', title: 'T', issues: [12] })

  // A sign-off the mod refused opened no wait, so its row gets no card.
  expect((await $.tool.call({ tool: 'mcp__foundry__signoff_request', summary: 'early' })).deny).toContain('Not yet')
  expect(rows).toEqual([])

  await $.tool.call({ tool: 'mcp__foundry__conflict_raise', perspectives: ['usability', 'security'], summary: 'They disagree' })
  const conflict = await $.ui.mount({ ...toolRow('mcp__foundry__conflict_raise', lastRow(rows)), surface: 'mobile' })
  expect(await conflict.find({ type: 'Text', text: /Waiting on you: Reviewer conflict/ })).toBeDefined()
  expect(await conflict.find({ key: '12-veto-usability' })).toBeDefined()
  expect(await conflict.find({ key: '12-compromise' })).toBeDefined()
  await conflict.press({ key: '12-veto-security' })
  expect(await conflict.find({ type: 'Text', text: /Foundry: decided\./ })).toBeDefined()
  await conflict.unmount()
  expect(hub.state(12)?.vetoes).toContain('security')

  const rec = () => $.tool.call({ tool: 'mcp__foundry__review_record', perspective: 'usability', reviewer: 'r', verdict: 'revise', summary: 's' })
  await rec()
  await rec()
  // The review that hits the limit is refused, but it opened the wait: its row carries the card.
  expect((await rec()).deny).toContain('used its 2 rounds')
  const limit = await $.ui.mount({ ...toolRow('mcp__foundry__review_record', lastRow(rows)), surface: 'desktop' })
  expect(await limit.find({ type: 'Text', text: /Waiting on you: Round limit reached/ })).toBeDefined()
  expect(await limit.find({ key: '12-approve' })).toBeDefined()
  expect(await limit.find({ key: '12-veto-usability' })).toBeDefined()
  await limit.unmount()

  // An ordinary review's row, which opened nothing, draws as the engine draws it.
  const plain = await $.ui.mount({ ...toolRow('mcp__foundry__review_record', 'not-a-wait'), surface: 'desktop' })
  expect(await plain.find({ type: 'Text', text: /Waiting on you|Foundry: decided/ })).toBeUndefined()
  await plain.unmount()
})
