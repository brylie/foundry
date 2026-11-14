// The stages of a Foundry batch and every move between them, kept free of `$`
// so tests call them directly. Each move takes a batch and returns a new one.

import type { Batch, DocFolders, LoopStage, Review, Stage, Verdict, Waiting, WaitKind } from '../types'

export const DEFAULT_REVIEWERS = 'product-owner,usability,accessibility,architecture,security,documentation'

/**
 * Where each kind of doc usually lives, in the order a batch looks for it.
 * The first that exists wins; with none, the first is where it will be made.
 * For user docs every one that exists counts.
 */
export const DOC_CANDIDATES: Record<keyof DocFolders, string[]> = {
  requirements: ['docs/product', 'docs/requirements', 'docs/prd'],
  specifications: ['docs/design', 'docs/specs', 'docs/specifications', 'docs/spec'],
  decisions: ['docs/adr', 'docs/decisions'],
  user: ['README.md', 'CHANGELOG.md', 'docs/guide', 'docs/learn', 'docs/modules', 'docs/user', 'docs/manual', 'docs/reference'],
}

/** The doc kinds written in the plan loop, before any code: the rest change with the code. */
export const PLAN_DOCS: readonly (keyof DocFolders)[] = ['requirements', 'specifications', 'decisions']

export const NO_DOCS: DocFolders = { requirements: [], specifications: [], decisions: [], user: [] }

/** Where a batch's plan lives on its branch, beside the docs it agrees: one file per batch, named by its lead issue. */
export const PLAN_FOLDER = 'docs/plans'

export function planPath(batch: Pick<Batch, 'lead'>): string {
  return `${PLAN_FOLDER}/${batch.lead}.md`
}
export const DEFAULT_MAX_ROUNDS = 3
export const DEFAULT_ONLINE_REVIEWERS = 'coderabbitai[bot]'

export const VERDICTS: readonly Verdict[] = ['ready', 'revise', 'rethink']

/** The stages as the panel draws them, sign-offs included. */
export const TRACK = ['Plan', 'Plan sign-off', 'Build', 'Build sign-off', 'Ship', 'Done'] as const

export const WAIT_LABEL: Record<WaitKind, string> = {
  signoff: 'Sign-off',
  conflict: 'Reviewer conflict',
  'round-limit': 'Round limit reached',
  'bot-timeout': 'Online reviewer silent',
  'bot-comment': 'Online reviewer comment to read',
  merge: 'Ready to merge',
  tamper: 'State edited outside Foundry',
}

/** What the batch waits on, in the person's words: a sign-off says which one. */
export function waitLabel(batch: Batch): string {
  const kind = batch.waiting?.kind
  if (kind === undefined) return ''
  if (kind === 'signoff') return batch.stage === 'build' ? 'Build sign-off' : 'Plan sign-off'

  return WAIT_LABEL[kind]
}

/** How long something has waited, in words: "just now", "5 minutes", "2 hours", "3 days". */
export function waitedFor(since: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - since) / 60_000)
  if (minutes < 1) return 'just now'
  const [n, unit] = minutes < 60 ? [minutes, 'minute'] : minutes < 48 * 60 ? [Math.floor(minutes / 60), 'hour'] : [Math.floor(minutes / (24 * 60)), 'day']

  return `${n} ${unit}${n === 1 ? '' : 's'}`
}

export function keyOf(repo: string, lead: number): string {
  return `${repo}#${lead}`
}

export function batchKey(batch: Batch): string {
  return keyOf(batch.repo, batch.lead)
}

/** One spelling per perspective: `Product Owner` and `product_owner` are `product-owner`. */
export function perspectiveKey(perspective: string): string {
  return perspective.trim().toLowerCase().replace(/[\s_]+/g, '-')
}

/** The reviewers setting as perspectives, in order, each once. */
export function parseReviewers(text: string): string[] {
  return [...new Set(text.split(',').map(perspectiveKey).filter(Boolean))]
}

/** A GitHub login compared loosely: `CodeRabbitAI[bot]` and `coderabbitai` are one bot. */
export function loginKey(login: string): string {
  return login.trim().toLowerCase().replace(/\[bot\]$/, '')
}

export function parseLogins(text: string): string[] {
  return [...new Set(text.split(',').map(loginKey).filter(Boolean))]
}

export function isLoopStage(stage: Stage): stage is LoopStage {
  return stage === 'plan' || stage === 'build'
}

/** Where the batch sits on the panel's track. */
export function trackIndex(batch: Batch): number {
  const isSignoff = batch.waiting?.kind === 'signoff'
  switch (batch.stage) {
    case 'plan':
      return isSignoff ? 1 : 0
    case 'build':
      return isSignoff ? 3 : 2
    case 'ship':
      return 4
    case 'done':
      return 5
  }
}

export function currentRound(batch: Batch): number {
  return batch.stage === 'done' ? 0 : batch.rounds[batch.stage]
}

export type Settings = {
  reviewers: string[]
  maxRounds: number
  onlineReviewers: string[]
  maintainers: string[]
  docs: DocFolders
}

/** Everyone whose feedback the gate counts and the agent may act on: the online reviewers and the maintainers. */
export function allowlist(batch: Pick<Batch, 'onlineReviewers' | 'maintainers'>): string[] {
  return [...new Set([...batch.onlineReviewers, ...batch.maintainers])]
}

export function newBatch(
  input: { repo: string; title: string; issues: number[]; owner: string },
  settings: Settings,
  now: number,
): Batch {
  const lead = input.issues[0] ?? 0

  return {
    repo: input.repo,
    lead,
    title: input.title,
    issues: input.issues,
    stage: 'plan',
    rounds: { plan: 1, build: 1, ship: 1 },
    epoch: 1,
    vetoes: [],
    reviews: [],
    log: [{ n: 1, at: now, text: `Started: ${input.title}` }],
    ...settings,
    owner: input.owner,
    rev: 0,
    startedAt: now,
  }
}

// ---------------------------------------------------------------------------
// Reviews.

/** The reviews that count: this epoch's, in the stage the batch is in. */
export function counted(batch: Batch): Review[] {
  return batch.reviews.filter(r => r.epoch === batch.epoch && r.stage === batch.stage)
}

/** The latest counted verdict per perspective. */
export function latestByPerspective(batch: Batch): Map<string, Review> {
  const latest = new Map<string, Review>()
  for (const review of counted(batch)) latest.set(review.perspective, review)

  return latest
}

export type PerspectiveState = {
  perspective: string
  latest?: Review
  isVetoed: boolean
  isApproved: boolean
}

export function perspectiveStates(batch: Batch): PerspectiveState[] {
  const latest = latestByPerspective(batch)

  return batch.reviewers.map(perspective => {
    const review = latest.get(perspective)
    const isVetoed = batch.vetoes.includes(perspective)

    return { perspective, latest: review, isVetoed, isApproved: isVetoed || review?.verdict === 'ready' }
  })
}

/** Verdicts from perspectives outside the required list, such as a navigator: shown, never counted. */
export function extraReviews(batch: Batch): Review[] {
  const required = new Set(batch.reviewers)

  return [...latestByPerspective(batch).values()].filter(r => !required.has(r.perspective))
}

export function isAllApproved(batch: Batch): boolean {
  return perspectiveStates(batch).every(p => p.isApproved)
}

function notApproved(batch: Batch): string[] {
  return perspectiveStates(batch)
    .filter(p => !p.isApproved)
    .map(p => p.perspective)
}

/** A move's result: the new batch, or why the move is refused (with the batch it leaves). */
export type Move = { batch: Batch; error?: string; note?: string }

/** Adds a line to the batch's history, numbered after the last one; the log keeps its last 60. */
export function appendLog(batch: Batch, at: number, text: string, isForAgent = false): Batch {
  const n = (batch.log.at(-1)?.n ?? 0) + 1
  const entry = isForAgent ? { n, at, text, isForAgent } : { n, at, text }

  return { ...batch, log: [...batch.log, entry].slice(-60) }
}

const log = appendLog

function wait(batch: Batch, waiting: Omit<Waiting, 'at'>, at: number): Batch {
  const next = { ...batch, waiting: { ...waiting, at } }

  return log(next, at, `Waiting on you: ${waitLabel(next)}`)
}

function busy(batch: Batch): string | undefined {
  if (batch.waiting === undefined) return undefined

  return `"${batch.title}" is waiting on the person (${waitLabel(batch)}). End your turn, and tell them how to decide: ${howToDecide(batch)} You will be told when they do.`
}

/**
 * Records one verdict. A perspective's second verdict in the same round opens
 * the next round; at the round limit the stage escalates to the person instead.
 */
export function recordReview(
  batch: Batch,
  input: { perspective: string; reviewer: string; verdict: Verdict; summary: string },
  now: number,
): Move {
  if (!isLoopStage(batch.stage)) {
    return { batch, error: `Reviews are for the plan and build stages; "${batch.title}" is in ${batch.stage}.` }
  }
  const waiting = busy(batch)
  if (waiting) return { batch, error: waiting }

  const stage = batch.stage
  const perspective = perspectiveKey(input.perspective)
  let round = batch.rounds[stage]
  // Only a required reviewer moves the stage's rounds on: an extra one, such as a navigator, never uses them up.
  const isRequired = batch.reviewers.includes(perspective)
  const isAgain = isRequired && counted(batch).some(r => r.perspective === perspective && r.round === round)
  if (isAgain) {
    if (round >= batch.maxRounds) {
      const stuck = notApproved(batch)
      const escalated = wait(
        batch,
        {
          kind: 'round-limit',
          perspectives: stuck,
          summary: `The ${stage} loop used all ${batch.maxRounds} rounds. Not approved: ${stuck.join(', ') || 'none'}.`,
        },
        now,
      )

      return {
        batch: escalated,
        error: `The ${stage} stage has used its ${batch.maxRounds} rounds, so it escalated to the person. Tell them what is unresolved and end your turn.`,
      }
    }
    round += 1
  }

  const review: Review = {
    stage,
    perspective,
    reviewer: input.reviewer,
    verdict: input.verdict,
    summary: input.summary.slice(0, 600),
    round,
    epoch: batch.epoch,
    at: now,
  }
  // Keep this epoch's reviews whole and only a short tail of earlier ones.
  const older = batch.reviews.filter(r => r.epoch !== batch.epoch).slice(-20)
  const current = batch.reviews.filter(r => r.epoch === batch.epoch)

  return {
    batch: { ...batch, reviews: [...older, ...current, review], rounds: { ...batch.rounds, [stage]: round } },
  }
}

/** Two reviewers want things that cannot both hold: the person vetoes one or finds a compromise. */
export function raiseConflict(batch: Batch, perspectives: string[], summary: string, now: number): Move {
  if (!isLoopStage(batch.stage)) return { batch, error: 'Conflicts are raised in the plan and build stages.' }
  const waiting = busy(batch)
  if (waiting) return { batch, error: waiting }
  const named = parseReviewers(perspectives.join(','))
  if (named.length < 2) return { batch, error: 'A conflict names at least two perspectives.' }

  return { batch: wait(batch, { kind: 'conflict', perspectives: named, summary }, now) }
}

export function requestSignoff(batch: Batch, summary: string, now: number): Move {
  if (!isLoopStage(batch.stage)) return { batch, error: `There is no sign-off in the ${batch.stage} stage.` }
  const waiting = busy(batch)
  if (waiting) return { batch, error: waiting }
  const missing = notApproved(batch)
  if (missing.length > 0) {
    return {
      batch,
      error: `Every reviewer must approve before sign-off. Not yet: ${missing.join(', ')}. Address their findings and review again, or raise a conflict.`,
    }
  }

  return { batch: wait(batch, { kind: 'signoff', summary }, now) }
}

export function recordTests(batch: Batch, input: { command: string; isPassing: boolean; summary: string }, now: number): Batch {
  return {
    ...batch,
    tests: { light: input.isPassing ? 'pass' : 'fail', command: input.command, summary: input.summary.slice(0, 300), at: now },
  }
}

function enter(batch: Batch, stage: Stage): Batch {
  const rounds = { ...batch.rounds }
  // The stage left behind starts over next time; the ship counter alone runs across send-backs.
  if (batch.stage === 'plan') rounds.plan = 1
  if (batch.stage === 'build') rounds.build = 1

  return { ...batch, stage, rounds, epoch: batch.epoch + 1, vetoes: [], waiting: undefined }
}

/**
 * Sends a shipping pull request back to the build loop: a CI failure or a
 * change request. It is a ship round; at the limit it escalates instead.
 */
export function sendBack(
  batch: Batch,
  reason: 'ci-failure' | 'changes-requested',
  summary: string,
  now: number,
): Move {
  if (batch.stage !== 'ship') return { batch, error: 'Only a shipping batch is sent back.' }
  const waiting = batch.waiting && !['bot-timeout', 'bot-comment', 'merge'].includes(batch.waiting.kind)
  if (waiting) return { batch, error: busy(batch) }
  if (batch.rounds.ship >= batch.maxRounds) {
    return {
      batch: wait(
        batch,
        {
          kind: 'round-limit',
          summary: `The ship stage used all ${batch.maxRounds} rounds. Latest: ${reason}: ${summary}`,
        },
        now,
      ),
      error: `The ship stage has used its ${batch.maxRounds} rounds, so it escalated to the person. End your turn.`,
    }
  }

  const back = enter(batch, 'build')
  const what = reason === 'ci-failure' ? 'CI failed' : 'changes were requested'

  return {
    batch: log(
      { ...back, rounds: { ...back.rounds, ship: batch.rounds.ship + 1 } },
      now,
      `Sent back to build (ship round ${batch.rounds.ship + 1}): ${what}. ${summary}`,
    ),
  }
}

// ---------------------------------------------------------------------------
// The person's decisions.

export type Decision =
  | { action: 'approve' }
  | { action: 'changes' }
  | { action: 'veto'; perspective: string }
  | { action: 'compromise' }
  | { action: 'acknowledge' }
  | { action: 'end' }

/** What each kind of wait lets the person do, in the order the panel offers it. */
export function choices(batch: Batch): Decision['action'][] {
  switch (batch.waiting?.kind) {
    case 'signoff':
      return ['approve', 'changes']
    case 'round-limit':
      return isLoopStage(batch.stage) ? ['approve', 'changes', 'veto'] : ['changes', 'end']
    case 'conflict':
      return ['veto', 'compromise']
    case 'tamper':
      return ['acknowledge']
    default:
      return []
  }
}

/** One way the person can answer a wait: its label on a card or in Foundry's question, and the command to type. */
export type DecisionOption = { label: string; decision: Decision; typed: string }

/**
 * The person's options for the batch's wait, as the panel labels them, each
 * with the `/foundry` command that does the same: what they type where no
 * panel shows, on their phone say.
 */
export function decisionOptions(batch: Batch): DecisionOption[] {
  const at = `#${batch.lead}`
  const waiting = batch.waiting

  return choices(batch).flatMap((action): DecisionOption[] => {
    switch (action) {
      case 'approve':
        return [{ label: 'Approve', decision: { action }, typed: `/foundry approve ${at}` }]
      case 'changes': {
        const label = waiting?.kind === 'signoff' ? 'Request changes' : batch.stage === 'ship' ? 'Send back anyway' : 'Another round'

        return [{ label, decision: { action }, typed: `/foundry changes ${at}` }]
      }
      case 'veto':
        return (waiting?.perspectives ?? []).map(p => ({ label: `Veto ${p}`, decision: { action, perspective: p }, typed: `/foundry veto ${p} ${at}` }))
      case 'compromise':
        return [{ label: "I'll write a compromise", decision: { action }, typed: `/foundry compromise ${at}` }]
      case 'acknowledge':
        return [{ label: 'OK, restored', decision: { action }, typed: `/foundry ack ${at}` }]
      case 'end':
        return [{ label: 'End batch', decision: { action }, typed: `/foundry end ${at}` }]
      default:
        return []
    }
  })
}

/**
 * One choice in Foundry's question card: a single option, several that a
 * second question picks between (one per reviewer to overrule, say), or none
 * (`Not yet`, which decides nothing and leaves the card and the commands).
 */
export type QuestionChoice = { label: string; options: DecisionOption[] }

/** The card offers 2 to 4 choices: the engine pads fewer than two with a Yes and No that mean nothing here. */
const MAX_CHOICES = 4
const GROUP_LABEL: Partial<Record<Decision['action'], string>> = { veto: 'Overrule a reviewer…' }
export const NOT_YET = 'Not yet'

/**
 * The batch's wait as the question card offers it: every option, grouped per
 * kind once there are more than four, and never fewer than two choices.
 */
export function questionChoices(batch: Batch): QuestionChoice[] {
  const options = decisionOptions(batch)
  if (options.length === 0) return []
  let choices: QuestionChoice[] = options.map(o => ({ label: o.label, options: [o] }))
  if (options.length > MAX_CHOICES) {
    choices = []
    for (const o of options) {
      const group = GROUP_LABEL[o.decision.action]
      const same = choices.find(c => group !== undefined && c.label === group)
      if (same) same.options.push(o)
      else choices.push({ label: group ?? o.label, options: [o] })
    }
    // A group of one is that option itself.
    choices = choices.map(c => (c.options.length === 1 && c.options[0] ? { label: c.options[0].label, options: c.options } : c)).slice(0, MAX_CHOICES)
  }

  return choices.length === 1 ? [...choices, { label: NOT_YET, options: [] }] : choices
}

/**
 * What words the person types instead of a choice mean, for this wait: the
 * changes they want, or for a conflict the compromise. Undefined where words
 * decide nothing (a bot to dismiss, a restored state).
 */
export function freeTextAction(batch: Batch): 'changes' | 'compromise' | undefined {
  const actions = decisionOptions(batch).map(o => o.decision.action)
  if (actions.includes('changes')) return 'changes'
  if (actions.includes('compromise')) return 'compromise'

  return undefined
}

/** Where and how the person answers the batch's wait, in a sentence for the agent to pass on. */
export function howToDecide(batch: Batch): string {
  const typed = decisionOptions(batch).map(o => `\`${o.typed}\``)
  const list = typed.length <= 1 ? (typed[0] ?? '') : `${typed.slice(0, -1).join(', ')} or ${typed.at(-1) ?? ''}`
  const commands = typed.length === 0 ? '' : ` or by typing ${list} (from their phone too)`

  return `on the batch's card in the Foundry panel, in the question Foundry asks them${commands}.`
}

const NEXT: Record<LoopStage, Stage> = { plan: 'build', build: 'ship' }

const AFTER: Record<LoopStage, string> = {
  plan: 'Claim the issues, then build and test following the approved plan.',
  build: 'Mark the draft pull request ready for review (`gh pr ready <number>`), or open one if there is none yet, then call mcp__foundry__pr_opened with its URL.',
}

/**
 * Applies the person's decision. Only the person's own press or command
 * calls this: nothing the agent can call reaches it.
 */
export function decide(batch: Batch, decision: Decision, now: number): Move {
  if (decision.action === 'end') {
    return { batch: log({ ...batch, stage: 'done', waiting: undefined }, now, 'Ended by the person.', true), note: `The person ended the batch "${batch.title}". Its gates are off.` }
  }

  const allowed = choices(batch)
  if (!allowed.includes(decision.action)) {
    const what = batch.waiting ? waitLabel(batch) : 'nothing'

    return { batch, error: `"${batch.title}" is waiting on ${what}; "${decision.action}" does not apply.` }
  }

  const told = (next: Batch, text: string): Move => ({ batch: log(next, now, text, true), note: `Foundry, "${batch.title}": ${text}` })

  switch (decision.action) {
    case 'approve': {
      if (!isLoopStage(batch.stage)) return { batch, error: 'Nothing to approve here.' }
      const label = batch.stage === 'plan' ? 'plan' : 'implementation'

      return told(enter(batch, NEXT[batch.stage]), `The person approved the ${label}. ${AFTER[batch.stage]}`)
    }
    case 'changes': {
      if (batch.stage === 'ship') {
        const back = enter(batch, 'build')

        return told(
          { ...back, rounds: { ...back.rounds, ship: batch.rounds.ship + 1 } },
          'The person sent the work back to the build loop for another round. Wait for what they want changed.',
        )
      }
      if (!isLoopStage(batch.stage)) return { batch, error: 'Nothing to send back.' }
      const stage = batch.stage
      const next = { ...batch, waiting: undefined, epoch: batch.epoch + 1, rounds: { ...batch.rounds, [stage]: batch.rounds[stage] + 1 } }

      return told(
        next,
        `The person asked for changes (${stage} round ${next.rounds[stage]}). Wait for what they want, revise, then every reviewer reviews again.`,
      )
    }
    case 'veto': {
      const perspective = perspectiveKey(decision.perspective)
      if (!batch.reviewers.includes(perspective)) return { batch, error: `"${perspective}" is not one of this batch's reviewers.` }
      const next = { ...batch, vetoes: [...new Set([...batch.vetoes, perspective])], waiting: undefined }

      return told(
        next,
        `The person vetoed ${perspective} for this stage; it counts as approved. ${isAllApproved(next) ? 'Every reviewer now approves: request sign-off.' : 'Carry on with the other reviewers.'}`,
      )
    }
    case 'compromise':
      return told(
        { ...batch, waiting: undefined },
        'The person will write a compromise in the chat. Wait for it, apply it, then the reviewers in the conflict review again.',
      )
    case 'acknowledge':
      return { batch: log({ ...batch, waiting: undefined }, now, 'The person acknowledged the restored state.') }
  }
}

/** The agent's PR is open: the ship stage starts watching it. */
export function prOpened(batch: Batch, pr: number, url: string, now: number): Move {
  // A draft opens in the build loop, for the build sign-off to read; the gates watch it once it ships.
  if (batch.stage !== 'ship' && batch.stage !== 'build') return { batch, error: 'The pull request opens in the build loop, as a draft.' }
  if (batch.ship !== undefined && batch.ship.pr !== pr) {
    return { batch, error: `This batch already ships as #${batch.ship.pr}.` }
  }
  const ship = batch.ship ?? {
    pr,
    url,
    head: '',
    ci: 'pending' as const,
    checks: [],
    openThreads: 0,
    isMerged: false,
    checkedAt: 0,
    outsiders: [],
  }

  const what = batch.stage === 'build' ? `Draft pull request #${pr} opened.` : `Pull request #${pr} is ready for review.`

  return { batch: log({ ...batch, ship }, now, what) }
}
