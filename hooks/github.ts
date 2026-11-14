// GitHub, through the gh CLI: the one place the mod reads and writes a
// batch's state. These calls are the mod's own; the agent's tool calls never
// pass through here, and the guards keep it from writing the same things.

import type { EngineInterface } from 'claude-code'

import type { Batch } from '../types'
import { CONFIG_FILE } from './config'
import type { PrData } from './ship'
import { LABEL_SPECS, labelsFor, parseState, renderState } from './state'

export async function gh($: EngineInterface, args: string[], stdin?: string): Promise<string> {
  const ran = await $.process.run(['gh', ...args], stdin === undefined ? { timeoutMs: 60_000 } : { stdin, timeoutMs: 60_000 })
  if (ran.exitCode !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')}: ${ran.stderr.trim() || `exit ${ran.exitCode}`}`)

  return ran.stdout
}

export async function ghJson<T>($: EngineInterface, args: string[], stdin?: string): Promise<T> {
  return JSON.parse(await gh($, args, stdin)) as T
}

/** The repository the session works in, as `owner/name`, or undefined outside one. */
export async function currentRepo($: EngineInterface): Promise<string | undefined> {
  try {
    const name = (await gh($, ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])).trim()

    return name || undefined
  } catch {
    return undefined
  }
}

/**
 * The repository's foundry.yaml as its default branch holds it, never the
 * checkout's: a branch cannot change the allowlist or the rules it is judged
 * by. Undefined text means the default branch has no such file.
 */
export async function readRepoConfig($: EngineInterface, repo: string): Promise<{ branch: string; text?: string }> {
  const branch = (await gh($, ['repo', 'view', repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'])).trim() || 'main'
  try {
    const text = await gh($, ['api', '-H', 'Accept: application/vnd.github.raw+json', `repos/${repo}/contents/${CONFIG_FILE}?ref=${encodeURIComponent(branch)}`])

    return { branch, text }
  } catch (error) {
    if (/HTTP 404|Not Found/i.test(error instanceof Error ? error.message : String(error))) return { branch }
    throw error
  }
}

/** Creates Foundry's labels where missing; `--force` leaves existing ones as they are named. */
export async function ensureLabels($: EngineInterface, repo: string): Promise<void> {
  for (const label of LABEL_SPECS) {
    await gh($, ['label', 'create', label.name, '-R', repo, '--color', label.color, '--description', label.description, '--force'])
  }
}

const isFoundryLabel = (name: string) => name === 'foundry' || name.startsWith('foundry:')

/**
 * Sets an issue's or pull request's Foundry labels. It adds and removes
 * Foundry's own labels one by one and never replaces the whole set, so a
 * label someone else adds or removes meanwhile is left as they made it.
 */
async function setLabels($: EngineInterface, repo: string, number: number, wanted: string[]): Promise<void> {
  const current = (await ghJson<{ name: string }[]>($, ['api', `repos/${repo}/issues/${number}/labels?per_page=100`])).map(l => l.name)
  const add = wanted.filter(name => !current.includes(name))
  const remove = current.filter(name => isFoundryLabel(name) && !wanted.includes(name))
  if (add.length > 0) {
    await gh($, ['api', '-X', 'POST', `repos/${repo}/issues/${number}/labels`, '--input', '-'], JSON.stringify({ labels: add }))
  }
  for (const name of remove) {
    await gh($, ['api', '-X', 'DELETE', `repos/${repo}/issues/${number}/labels/${encodeURIComponent(name)}`])
  }
}

/** The GitHub login the mod writes as: only state comments by it are read back. */
export async function currentLogin($: EngineInterface): Promise<string> {
  return (await gh($, ['api', 'user', '--jq', '.login'])).trim()
}

/** Writes the batch's state comment and labels. Returns the batch with its comment id. */
/**
 * A write whose state comment landed and whose labels did not. It carries
 * the comment's id, so the retry rewrites that comment instead of posting a
 * second one.
 */
export class PartialWrite extends Error {
  constructor(
    message: string,
    readonly commentId: number,
  ) {
    super(message)
  }
}

export async function writeBatch($: EngineInterface, batch: Batch): Promise<Batch> {
  const body = JSON.stringify({ body: renderState(batch) })
  let commentId = batch.commentId
  if (commentId === undefined) {
    // A first write that lost its id (a failure after the comment landed) finds its comment again.
    const found = await readStateComment($, batch.repo, batch.lead, await currentLogin($))
    commentId = found?.commentId
  }
  if (commentId === undefined) {
    const made = await ghJson<{ id: number }>($, ['api', '-X', 'POST', `repos/${batch.repo}/issues/${batch.lead}/comments`, '--input', '-'], body)
    commentId = made.id
  } else {
    try {
      await gh($, ['api', '-X', 'PATCH', `repos/${batch.repo}/issues/comments/${commentId}`, '--input', '-'], body)
    } catch (error) {
      // Only a comment that is gone is written again; any other failure is
      // reported, and the next sync retries it, so an outage never leaves a
      // second state comment behind.
      if (!/HTTP 404|Not Found/i.test(error instanceof Error ? error.message : String(error))) throw error
      const made = await ghJson<{ id: number }>($, ['api', '-X', 'POST', `repos/${batch.repo}/issues/${batch.lead}/comments`, '--input', '-'], body)
      commentId = made.id
    }
  }

  const labels = labelsFor(batch)
  const items = batch.ship ? [...batch.issues, batch.ship.pr] : batch.issues
  try {
    for (const number of new Set(items)) await setLabels($, batch.repo, number, labels)
  } catch (error) {
    throw new PartialWrite(error instanceof Error ? error.message : String(error), commentId)
  }

  return { ...batch, commentId }
}

type Comment = { id: number; body: string; user: string }

/**
 * The latest state comment on an issue, or undefined when it has none. Every
 * page of comments is read. A record counts only when the mod's own account
 * wrote it and it names this repository and this issue as its lead, so a
 * copy someone else posts, or one moved from another issue, is ignored.
 */
export async function readStateComment(
  $: EngineInterface,
  repo: string,
  issue: number,
  writer: string,
  pinned?: number,
): Promise<{ batch: Batch; commentId: number } | undefined> {
  const out = await gh($, ['api', '--paginate', `repos/${repo}/issues/${issue}/comments?per_page=100`, '--jq', '.[] | {id, body, user: .user.login}'])
  const comments = out
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Comment)
  let found: { batch: Batch; commentId: number } | undefined
  for (const comment of comments) {
    if (comment.user.toLowerCase() !== writer.toLowerCase()) continue
    const batch = parseState(comment.body)
    if (batch === undefined || batch.repo !== repo || batch.lead !== issue) continue
    // The comment this session knows the batch by wins over any other, so a second one posted beside it is ignored.
    if (comment.id === pinned) return { batch, commentId: comment.id }
    if (found === undefined || comment.id > found.commentId) found = { batch, commentId: comment.id }
  }

  return found
}

/**
 * Every open batch in the repository, read from its state comment.
 * `pinned` maps a lead issue to the comment id this session knows it by.
 */
export async function loadBatches($: EngineInterface, repo: string, pinned: Record<number, number> = {}): Promise<Batch[]> {
  const writer = await currentLogin($)
  const issues = await ghJson<{ number: number }[]>($, ['issue', 'list', '-R', repo, '--label', 'foundry', '--state', 'open', '--limit', '100', '--json', 'number'])
  const seen = new Set<number>()
  const found: Batch[] = []
  for (const { number } of [...issues].sort((a, b) => a.number - b.number)) {
    if (seen.has(number)) continue
    const read = await readStateComment($, repo, number, writer, pinned[number])
    if (read === undefined) continue
    for (const n of read.batch.issues) seen.add(n)
    found.push({ ...read.batch, commentId: read.commentId })
  }

  return found
}

const PR_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number url state headRefOid
      commits(last: 1) { nodes { commit { committedDate statusCheckRollup { contexts(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          __typename
          ... on CheckRun { name status conclusion }
          ... on StatusContext { context state }
        }
      } } } } }
      reviews(last: 100) { nodes { author { login } state submittedAt commit { oid } } }
      reviewThreads(first: 100) { pageInfo { hasNextPage } nodes { isResolved comments(first: 1) { nodes { author { login } originalCommit { oid } } } } }
      comments(last: 100) { nodes { author { login } body updatedAt } }
    }
  }
}`

/** The pull request's checks, reviews, threads and comments. */
export async function fetchPr($: EngineInterface, repo: string, number: number): Promise<PrData> {
  const [owner = '', name = ''] = repo.split('/')
  const data = await ghJson<{ data: { repository: { pullRequest: PrData } } }>($, [
    'api',
    'graphql',
    '-f',
    `query=${PR_QUERY}`,
    '-F',
    `owner=${owner}`,
    '-F',
    `name=${name}`,
    '-F',
    `number=${number}`,
  ])

  return data.data.repository.pullRequest
}
