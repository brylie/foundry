import { describe, expect, test } from 'claude-code/testing'

import type { Batch, Ship } from '../types'
import { newBatch, parseLogins } from '../hooks/model'
import { readShip } from '../hooks/ship'
import type { PrData } from '../hooks/ship'

const HEAD = 'abc1234def'
const PUSHED = '2026-11-13T10:00:00Z'
const T0 = Date.parse(PUSHED)
const MIN = 60_000

const batch: Batch = {
  ...newBatch(
    { repo: 'o/r', title: 'T', issues: [1], owner: 's' },
    { reviewers: ['security'], maxRounds: 3, onlineReviewers: parseLogins('coderabbitai[bot],gitar-bot[bot]'), botTimeoutMinutes: 30 },
    0,
  ),
  stage: 'ship',
}

const prior: Ship = {
  pr: 9,
  url: 'https://github.com/o/r/pull/9',
  head: HEAD,
  headSeenAt: T0,
  ci: 'pending',
  checks: [],
  bots: [],
  openThreads: 0,
  isMerged: false,
  checkedAt: 0,
  dismissed: [],
}

type Parts = {
  checks?: { name: string; conclusion: string | null }[]
  reviews?: { login: string; state: string; oid?: string }[]
  threads?: { login: string; isResolved: boolean }[]
  comments?: { login: string; body: string; updatedAt: string }[]
  state?: PrData['state']
}

function pr(parts: Parts): PrData {
  return {
    number: 9,
    url: prior.url,
    state: parts.state ?? 'OPEN',
    headRefOid: HEAD,
    commits: {
      nodes: [
        {
          commit: {
            committedDate: PUSHED,
            statusCheckRollup: {
              contexts: {
                nodes: (parts.checks ?? []).map(c => ({
                  __typename: 'CheckRun' as const,
                  name: c.name,
                  status: c.conclusion === null ? 'IN_PROGRESS' : 'COMPLETED',
                  conclusion: c.conclusion,
                })),
              },
            },
          },
        },
      ],
    },
    reviews: { nodes: (parts.reviews ?? []).map(r => ({ author: { login: r.login }, state: r.state, submittedAt: PUSHED, commit: { oid: r.oid ?? HEAD } })) },
    reviewThreads: { nodes: (parts.threads ?? []).map(t => ({ isResolved: t.isResolved, comments: { nodes: [{ author: { login: t.login } }] } })) },
    comments: { nodes: (parts.comments ?? []).map(c => ({ author: { login: c.login }, body: c.body, updatedAt: c.updatedAt })) },
  }
}

const GREEN = [
  { name: 'test', conclusion: 'SUCCESS' },
  { name: 'codecov/patch', conclusion: 'SUCCESS' },
]
const LATER = '2026-11-13T10:05:00Z'

describe('CI', () => {
  test('green, red and pending follow the check rollup; Codecov is a check like any other', async () => {
    expect(readShip(batch, prior, pr({ checks: GREEN }), T0).ship.ci).toBe('pass')
    const red = readShip(batch, prior, pr({ checks: [...GREEN.slice(0, 1), { name: 'codecov/patch', conclusion: 'FAILURE' }] }), T0)
    expect(red.ship.ci).toBe('fail')
    expect(red.notice?.text).toContain('gh run rerun')
    expect(red.notice?.text).toContain('send_back')
    expect(readShip(batch, prior, pr({ checks: [{ name: 'test', conclusion: null }] }), T0).ship.ci).toBe('pending')
    // Right after a push no check has registered yet: that is not green.
    expect(readShip(batch, prior, pr({}), T0).ship.ci).toBe('pending')
  })
})

describe('online reviewers', () => {
  test('a busy or rate-limited comment is not a review, and silence times out', async () => {
    const busy = { login: 'coderabbitai', body: '> [!WARNING]\n> ## Review limit reached', updatedAt: LATER }
    const early = readShip(batch, prior, pr({ checks: GREEN, comments: [busy] }), T0 + 5 * MIN)
    expect(early.ship.bots.find(b => b.login === 'coderabbitai')?.light).toBe('busy')
    expect(early.waiting).toBeUndefined()

    const late = readShip(batch, prior, pr({ checks: GREEN, comments: [busy] }), T0 + 31 * MIN)
    expect(late.ship.bots.map(b => b.light)).toEqual(['timeout', 'timeout'])
    expect(late.waiting?.kind).toBe('bot-timeout')
    expect(late.waiting?.bots).toEqual(['coderabbitai', 'gitar-bot'])
  })

  test('a review of an older commit does not count for the head', async () => {
    const reading = readShip(batch, prior, pr({ checks: GREEN, reviews: [{ login: 'coderabbitai[bot]', state: 'COMMENTED', oid: 'old0000' }] }), T0)
    expect(reading.ship.bots[0]?.light).toBe('waiting')
  })

  test("gitar-bot's fresh summary comment waits for the person to read and dismiss it", async () => {
    const gitar = { login: 'gitar-bot', body: '<details><summary>Verification</summary>No issues</details>', updatedAt: LATER }
    const reviewed = { login: 'coderabbitai', state: 'COMMENTED' }
    const reading = readShip(batch, prior, pr({ checks: GREEN, reviews: [reviewed], comments: [gitar] }), T0 + MIN)
    expect(reading.ship.bots.map(b => b.light)).toEqual(['reviewed', 'comment'])
    expect(reading.waiting?.kind).toBe('bot-comment')

    const dismissed = readShip(batch, { ...prior, dismissed: [`gitar-bot@${HEAD}`] }, pr({ checks: GREEN, reviews: [reviewed], comments: [gitar] }), T0 + MIN)
    expect(dismissed.waiting?.kind).toBe('merge')
    expect(dismissed.notice?.text).toContain('ready to merge')
  })

  test('open threads and change requests block, wherever they come from', async () => {
    const both = [{ login: 'coderabbitai', state: 'COMMENTED' }, { login: 'gitar-bot', state: 'COMMENTED' }]
    const threads = readShip(batch, prior, pr({ checks: GREEN, reviews: both, threads: [{ login: 'coderabbitai', isResolved: false }] }), T0)
    expect(threads.ship.openThreads).toBe(1)
    expect(threads.ship.bots[0]?.light).toBe('changes')
    expect(threads.waiting).toBeUndefined()
    expect(threads.notice?.text).toContain('Do not resolve threads yourself')

    // A review under the maintainer's own account is feedback: its change request blocks, and nothing of it signs off.
    const mine = readShip(batch, prior, pr({ checks: GREEN, reviews: [...both, { login: 'brylie', state: 'CHANGES_REQUESTED' }] }), T0)
    expect(mine.waiting).toBeUndefined()
    expect(mine.notice?.text).toContain('Changes were requested')

    const resolved = readShip(batch, prior, pr({ checks: GREEN, reviews: both, threads: [{ login: 'coderabbitai', isResolved: true }] }), T0)
    expect(resolved.waiting?.kind).toBe('merge')
  })

  test('a later plain comment does not clear a change request; a dismissed review is not a review', async () => {
    const both = [{ login: 'coderabbitai', state: 'COMMENTED' }, { login: 'gitar-bot', state: 'COMMENTED' }]
    const changed = readShip(
      batch,
      prior,
      pr({ checks: GREEN, reviews: [...both, { login: 'brylie', state: 'CHANGES_REQUESTED' }, { login: 'brylie', state: 'COMMENTED' }] }),
      T0,
    )
    expect(changed.waiting).toBeUndefined()
    expect(changed.notice?.text).toContain('Changes were requested')

    const lifted = readShip(
      batch,
      prior,
      pr({ checks: GREEN, reviews: [...both, { login: 'brylie', state: 'CHANGES_REQUESTED' }, { login: 'brylie', state: 'DISMISSED' }] }),
      T0,
    )
    expect(lifted.waiting?.kind).toBe('merge')

    const dismissedOnly = readShip(batch, prior, pr({ checks: GREEN, reviews: [{ login: 'coderabbitai', state: 'DISMISSED' }] }), T0)
    expect(dismissedOnly.ship.bots[0]?.light).toBe('waiting')
  })

  test('a gate is never green on a partial page of checks or threads', async () => {
    const both = [{ login: 'coderabbitai', state: 'COMMENTED' }, { login: 'gitar-bot', state: 'COMMENTED' }]
    const full = pr({ checks: GREEN, reviews: both })
    const moreChecks: PrData = {
      ...full,
      commits: {
        nodes: full.commits.nodes.map(n => ({
          commit: { ...n.commit, statusCheckRollup: { contexts: { ...n.commit.statusCheckRollup!.contexts, pageInfo: { hasNextPage: true } } } },
        })),
      },
    }
    const checksRead = readShip(batch, prior, moreChecks, T0)
    expect(checksRead.ship.ci).toBe('pending')
    expect(checksRead.waiting).toBeUndefined()

    const moreThreads = readShip(batch, prior, { ...full, reviewThreads: { ...full.reviewThreads, pageInfo: { hasNextPage: true } } }, T0)
    expect(moreThreads.ship.ci).toBe('pass')
    expect(moreThreads.waiting).toBeUndefined()
  })

  test('a new head commit resets the reviewers and the person’s dismissals', async () => {
    const before = { ...prior, head: 'old0000', dismissed: ['gitar-bot@old0000'] }
    const reading = readShip(batch, before, pr({ checks: GREEN }), T0 + 7 * MIN)
    expect(reading.ship.headSeenAt).toBe(T0 + 7 * MIN)
    expect(reading.ship.dismissed).toEqual([])
  })

  test('a merged pull request ends the stage', async () => {
    expect(readShip(batch, prior, pr({ state: 'MERGED' }), T0).isMerged).toBe(true)
  })
})
