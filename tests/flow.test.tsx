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

    return { stdout: answer(argv, stdin), stderr: '', exitCode: 0 }
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

      return JSON.stringify(made)
    }
    if (/issues\/comments\/\d+/.test(path)) {
      const id = Number(/comments\/(\d+)/.exec(path)?.[1])
      for (const list of comments.values()) for (const c of list) if (c.id === id) c.body = (JSON.parse(stdin ?? '{}') as { body: string }).body

      return '{}'
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
  on('tool.call', (_, e) => {
    if (e.tool === 'Bash') ran.push(e.command)

    return { result: {} }
  })

  return { hub, prompts, ran, submit, clock, gate }
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
  const { hub, prompts, ran } = engine(on)
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
    expect(await ui.find({ type: 'Text', text: /Waiting on you: Sign-off/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Round 1 of 3/ })).toBeDefined()
    await ui.unmount()
  }

  // Plan sign-off, by the person's press.
  await press($, '12-approve')
  expect(prompts.at(-1)).toContain('approved the plan')
  expect(hub.state(12)?.stage).toBe('build')

  // Build loop: commits yes, pushes no.
  expect((await $.tool.call({ tool: 'Bash', command: 'git commit -m "Name the ports (#12)"' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'git push -u origin HEAD' })).deny).toContain('after the build sign-off')
  await $.tool.call({ tool: 'mcp__foundry__tests_record', command: 'npm test', passed: true, summary: '42 passed' })
  await approveAll($)
  await $.tool.call({ tool: 'mcp__foundry__signoff_request', summary: 'The change' })

  // Build sign-off, by the person's command.
  const typed = await $.command.run({ command: 'foundry', args: 'approve', origin: { kind: 'composer' }, presentation: SHOWN })
  expect(typed.context?.[0]).toContain('approved the implementation')

  // Ship gates.
  expect((await $.tool.call({ tool: 'Bash', command: 'git push -u origin HEAD' })).deny).toBeUndefined()
  expect(ran).toContain('git push -u origin HEAD')
  expect((await $.tool.call({ tool: 'mcp__foundry__pr_opened', pr: 'https://github.com/o/r/pull/9' })).deny).toBeUndefined()
  expect(hub.labels.get(9)).toEqual(['foundry', 'foundry:ship', 'foundry:waiting'])
  expect(hub.state(12)?.waiting?.kind).toBe('bot-comment')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Waiting on you: Online reviewer comment to read/ })).toBeDefined()
  await ui.press({ key: '12-dismiss-gitar-bot' })
  await ui.unmount()
  expect(hub.state(12)?.waiting?.kind).toBe('merge')
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
