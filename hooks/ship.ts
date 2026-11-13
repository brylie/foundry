// The ship stage's gates, judged only from facts GitHub records: the check
// rollup, the reviews and review threads on the head commit, and each online
// reviewer's own comment. Nothing here asks the agent's opinion.

import type { Batch, BotState, Check, Light, Ship, Waiting } from '../types'
import { loginKey } from './model'

/** The pull request as the GraphQL query in github.ts returns it. */
export type PrData = {
  number: number
  url: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  headRefOid: string
  commits: { nodes: { commit: { committedDate: string; statusCheckRollup: Rollup | null } }[] }
  reviews: { nodes: { author: Actor; state: string; submittedAt: string; commit: { oid: string } | null }[] }
  reviewThreads: {
    pageInfo?: PageInfo
    nodes: { isResolved: boolean; comments: { nodes: { author: Actor; originalCommit?: { oid: string } | null }[] } }[]
  }
  comments: { nodes: { author: Actor; body: string; updatedAt: string }[] }
}

type Actor = { login: string } | null

/** Whether more results lie past the page read: a gate never goes green on part of a list. */
type PageInfo = { hasNextPage: boolean }

type Rollup = {
  contexts: {
    pageInfo?: PageInfo
    nodes: (
      | { __typename: 'CheckRun'; name: string; status: string; conclusion: string | null }
      | { __typename: 'StatusContext'; context: string; state: string }
    )[]
  }
}

const PASS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])
const FAIL = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR', 'STALE'])

/**
 * A reviewer's comment that says it has not reviewed yet: still working, or
 * stopped by a rate limit (coderabbit's "Review limit reached", gitar's
 * "Gitar is working").
 */
const BUSY = /review limit reached|rate[- ]limit|is working|in progress|reviewing (your|this)|currently processing|will review shortly/i

function checkLight(node: Rollup['contexts']['nodes'][number]): Check {
  if (node.__typename === 'CheckRun') {
    if (node.status !== 'COMPLETED') return { name: node.name, light: 'pending' }
    const conclusion = node.conclusion ?? ''

    return { name: node.name, light: PASS.has(conclusion) ? 'pass' : FAIL.has(conclusion) ? 'fail' : 'pending' }
  }
  const state = node.state

  return { name: node.context, light: state === 'SUCCESS' ? 'pass' : state === 'FAILURE' || state === 'ERROR' ? 'fail' : 'pending' }
}

/** No checks at all reads as pending: right after a push, CI has not registered yet. */
export function ciLight(checks: Check[]): Light {
  if (checks.length === 0) return 'pending'
  if (checks.some(c => c.light === 'fail')) return 'fail'
  if (checks.some(c => c.light === 'pending')) return 'pending'

  return 'pass'
}

function time(text: string | undefined): number {
  const ms = text ? Date.parse(text) : NaN

  return Number.isNaN(ms) ? 0 : ms
}

export type ShipReading = {
  ship: Ship
  /** The ship wait to show, when no decision of another kind is pending. */
  waiting?: Omit<Waiting, 'at'>
  isMerged: boolean
  /** What the agent should hear, once per head commit and state. */
  notice?: { key: string; text: string }
}

/** Reads the pull request into the ship stage's lights. */
export function readShip(batch: Batch, prior: Ship, pr: PrData, now: number): ShipReading {
  const head = pr.headRefOid
  const commit = pr.commits.nodes[0]?.commit
  const headAt = time(commit?.committedDate)
  const isNewHead = head !== prior.head
  const headSeenAt = isNewHead ? now : prior.headSeenAt

  const checks = (commit?.statusCheckRollup?.contexts.nodes ?? []).map(checkLight)
  // More checks than one page holds: a failure could be on the next page, so it is never read as green.
  const isPartialChecks = commit?.statusCheckRollup?.contexts.pageInfo?.hasNextPage === true
  const isPartialThreads = pr.reviewThreads.pageInfo?.hasNextPage === true
  const ciRead = ciLight(checks)
  const ci = isPartialChecks && ciRead === 'pass' ? 'pending' : ciRead

  // Reviews of the head commit, by author. Reviews under the person's own
  // account count as feedback here, never as their sign-off.
  // `reviewedBy`: authors with a review that stands (a dismissed one does not).
  // `opinion`: each author's latest approval or change request, which a later
  // plain comment does not clear, as on GitHub; a dismissal does.
  const reviewedBy = new Set<string>()
  const opinion = new Map<string, string>()
  for (const review of pr.reviews.nodes) {
    if (review.commit?.oid !== head || !review.author) continue
    const login = loginKey(review.author.login)
    if (review.state === 'APPROVED' || review.state === 'COMMENTED' || review.state === 'CHANGES_REQUESTED') reviewedBy.add(login)
    if (review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED') opinion.set(login, review.state)
    if (review.state === 'DISMISSED') opinion.delete(login)
  }
  const changesBy = [...opinion].filter(([, state]) => state === 'CHANGES_REQUESTED').map(([login]) => login)

  // A thread blocks while it is open. Anyone may resolve a thread, the agent
  // included, so an online reviewer's resolved thread still blocks until that
  // reviewer has reviewed the head commit and the head is newer than the
  // commit the thread was raised on: the fix has been pushed and re-reviewed.
  // A resolved thread someone else raised (the maintainer, say) is cleared.
  const openThreads = pr.reviewThreads.nodes.filter(t => {
    if (!t.isResolved) return true
    const first = t.comments.nodes[0]
    const login = first?.author ? loginKey(first.author.login) : ''
    if (!batch.onlineReviewers.includes(login)) return false

    return first?.originalCommit?.oid === head || !reviewedBy.has(login)
  })
  const threadsBy = new Map<string, number>()
  for (const thread of openThreads) {
    const author = thread.comments.nodes[0]?.author
    const login = author ? loginKey(author.login) : 'unknown'
    threadsBy.set(login, (threadsBy.get(login) ?? 0) + 1)
  }

  const timeoutMs = batch.botTimeoutMinutes * 60_000
  const bots: BotState[] = batch.onlineReviewers.map(login => {
    if (prior.dismissed.includes(`${login}@${head}`)) return { login, light: 'dismissed' }
    if (changesBy.includes(login)) return { login, light: 'changes', detail: 'requested changes' }
    const threads = threadsBy.get(login) ?? 0
    if (threads > 0) return { login, light: 'changes', detail: `${threads} thread${threads === 1 ? '' : 's'} open or awaiting re-review` }
    if (reviewedBy.has(login)) return { login, light: 'reviewed' }

    const comment = [...pr.comments.nodes].reverse().find(c => c.author && loginKey(c.author.login) === login)
    const isFresh = comment !== undefined && time(comment.updatedAt) >= headAt
    const isBusy = isFresh && BUSY.test(comment.body)
    const isLate = now - headSeenAt >= timeoutMs
    if (isFresh && !isBusy) return { login, light: 'comment', detail: 'left a comment on this commit' }
    if (isLate) return { login, light: 'timeout', detail: isBusy ? 'busy or rate-limited' : 'no review yet' }

    return { login, light: isBusy ? 'busy' : 'waiting' }
  })

  const ship: Ship = {
    ...prior,
    pr: pr.number,
    url: pr.url,
    head,
    headSeenAt,
    ci,
    checks,
    bots,
    openThreads: openThreads.length,
    isMerged: pr.state === 'MERGED',
    checkedAt: now,
    dismissed: isNewHead ? prior.dismissed.filter(d => !d.endsWith(`@${prior.head}`)) : prior.dismissed,
  }

  if (ship.isMerged) return { ship, isMerged: true }

  const short = head.slice(0, 7)
  const timedOut = bots.filter(b => b.light === 'timeout').map(b => b.login)
  const toRead = bots.filter(b => b.light === 'comment').map(b => b.login)
  const isBlocked = changesBy.length > 0 || openThreads.length > 0 || bots.some(b => b.light === 'changes')
  const isGreen = ci === 'pass' && !isPartialThreads && !isBlocked && bots.every(b => b.light === 'reviewed' || b.light === 'dismissed')

  let waiting: ShipReading['waiting']
  if (timedOut.length > 0) {
    waiting = {
      kind: 'bot-timeout',
      bots: timedOut,
      summary: `No review of ${short} after ${batch.botTimeoutMinutes} minutes from ${timedOut.join(', ')}. Keep waiting, or dismiss them for this commit.`,
    }
  } else if (toRead.length > 0) {
    waiting = {
      kind: 'bot-comment',
      bots: toRead,
      summary: `${toRead.join(', ')} left a comment on ${short} rather than a review. Read it on the pull request, then dismiss it here if nothing needs changing.`,
    }
  } else if (isGreen) {
    waiting = { kind: 'merge', summary: `CI is green and every online reviewer has passed ${short}. Merging is yours.` }
  }

  let notice: ShipReading['notice']
  const failed = checks.filter(c => c.light === 'fail').map(c => c.name)
  if (ci === 'fail') {
    notice = {
      key: `ci-fail@${head}:${failed.join(',')}`,
      text: `CI failed on ${short}: ${failed.join(', ')}. If it is a flaky test, rerun it with \`gh run rerun <run-id> --failed\`: a plain rerun is not a round. Otherwise call mcp__foundry__send_back with reason "ci-failure".`,
    }
  } else if (isBlocked) {
    const who = [...new Set([...changesBy, ...threadsBy.keys()])]
    notice = {
      key: `changes@${head}:${openThreads.length}:${changesBy.join(',')}`,
      text: `Changes were requested on ${short} (${who.join(', ')}; ${openThreads.length} threads open or awaiting re-review). Call mcp__foundry__send_back with reason "changes-requested" and fix them in the build loop. Reply in each thread with what you changed and resolve it once the fix is pushed; an online reviewer's thread counts as cleared only after it re-reviews the new commit.`,
    }
  } else if (isGreen) {
    notice = { key: `green@${head}`, text: `The ship gates are green on ${short}. Tell the person the pull request is ready to merge; the merge is theirs.` }
  }

  return { ship, waiting, isMerged: false, notice }
}
