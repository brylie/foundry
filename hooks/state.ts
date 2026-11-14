// The state comment: how a batch is written into GitHub and read back. Free
// of `$`, so tests check the round trip directly.

import type { Batch } from '../types'
import { STATE_MARKER } from './guard'
import { TRACK, currentRound, isLoopStage, perspectiveStates, trackIndex, waitLabel } from './model'

export const STATE_VERSION = 1

const MARK = { ready: '✅', revise: '🟡', rethink: '❌' } as const
const LIGHT = { pass: '✅', fail: '❌', pending: '⏳', none: '—' } as const

/** The labels a batch carries on each issue and its pull request. */
export function labelsFor(batch: Batch): string[] {
  if (batch.stage === 'done') return []
  const labels = ['foundry', `foundry:${batch.stage}`]
  if (batch.waiting !== undefined) labels.push('foundry:waiting')

  return labels
}

export const LABEL_SPECS: { name: string; color: string; description: string }[] = [
  { name: 'foundry', color: '5319e7', description: 'In a Foundry batch' },
  { name: 'foundry:plan', color: 'c5def5', description: 'Foundry: plan loop' },
  { name: 'foundry:build', color: 'bfd4f2', description: 'Foundry: build loop' },
  { name: 'foundry:ship', color: '0e8a16', description: 'Foundry: pull request gates' },
  { name: 'foundry:waiting', color: 'fbca04', description: 'Foundry: waiting on the maintainer' },
]

/**
 * The comment's body: a summary a person can read on GitHub, then the
 * whole record as JSON. Only the Foundry mod writes it.
 */
export function renderState(batch: Batch): string {
  const step = TRACK[trackIndex(batch)]
  const round = batch.stage === 'done' ? '' : ` · round ${currentRound(batch)} of ${batch.maxRounds}`
  const lines = [
    STATE_MARKER,
    `**Foundry** · ${batch.title}`,
    '',
    `Stage: **${step}**${round}${batch.waiting ? ` · ⚠️ waiting on the maintainer: ${waitLabel(batch)}` : ''}`,
    `Issues: ${batch.issues.map(n => `#${n}`).join(', ')}${batch.ship ? ` · Pull request: #${batch.ship.pr}` : ''}`,
  ]
  if (isLoopStage(batch.stage)) {
    lines.push('', '| Reviewer | Verdict | Round |', '|---|---|---|')
    for (const p of perspectiveStates(batch)) {
      const verdict = p.isVetoed ? '⛔ vetoed' : p.latest ? `${MARK[p.latest.verdict]} ${p.latest.verdict}` : '· not reviewed'
      lines.push(`| ${p.perspective} | ${verdict} | ${p.latest?.round ?? '—'} |`)
    }
  }
  if (batch.tests) lines.push('', `Tests: ${LIGHT[batch.tests.light]} \`${batch.tests.command}\``)
  if (batch.ship) lines.push(`CI: ${LIGHT[batch.ship.ci]}`)
  lines.push(
    '',
    '<sub>Written by the Foundry mod. Edits here are restored from its copy, and a comment here is never a sign-off.</sub>',
    '',
    '<details><summary>State</summary>',
    '',
    '```json',
    JSON.stringify({ foundry: STATE_VERSION, batch }),
    '```',
    '',
    '</details>',
  )

  return lines.join('\n')
}

/** The batch a state comment holds, or undefined when the body is not a whole, well-formed one. */
export function parseState(body: string): Batch | undefined {
  if (!body.includes(STATE_MARKER)) return undefined
  const match = /```json\n([\s\S]*?)\n```/.exec(body)
  if (!match?.[1]) return undefined
  try {
    const data = JSON.parse(match[1]) as { foundry?: unknown; batch?: unknown }
    if (data.foundry !== STATE_VERSION) return undefined
    const batch = migrate(data.batch)

    return isBatch(batch) ? batch : undefined
  } catch {
    return undefined
  }
}

/**
 * Brings a record an earlier Foundry wrote up to this one's shape, keeping
 * its stage, rounds, reviews and pending decision. Version 0.1.0 had no doc
 * folders: such a batch gets none, so its plan stage stays code-and-docs
 * read-only as it was, and a new batch finds the folders when it starts.
 * Version 0.2 waited on the online reviewers: what it kept for that is dropped.
 */
export function migrate(batch: unknown): unknown {
  if (!isObject(batch)) return batch
  // 0.1: no doc folders.
  const docs = batch['docs'] ?? { requirements: [], specifications: [], decisions: [], user: [] }
  // 0.2: the gate waited on each online reviewer, with a timeout, a light per reviewer and the
  // person's dismissals. None of it is read now: it is dropped, and so is a wait it raised.
  const { botTimeoutMinutes: _timeout, ...rest } = batch
  const ship = isObject(batch['ship']) ? withoutBots(batch['ship']) : batch['ship']
  const waiting = isObject(batch['waiting']) ? withoutBotWait(batch['waiting']) : batch['waiting']

  return { ...rest, docs, ship, waiting }
}

function withoutBots(ship: Shape): Shape {
  const { bots: _bots, headSeenAt: _seen, dismissed: _dismissed, ...rest } = ship

  return rest
}

/** The waits 0.2 raised for the online reviewers, which nothing raises now. */
export const LEGACY_WAITS: readonly string[] = ['bot-timeout', 'bot-comment']

function withoutBotWait(waiting: Shape): Shape | undefined {
  if (LEGACY_WAITS.includes(String(waiting['kind']))) return undefined
  const { bots: _bots, ...rest } = waiting

  return rest
}

// ---------------------------------------------------------------------------
// A stored record is checked field by field against `Batch`, so one malformed
// comment is skipped rather than breaking the sync of every batch.

type Shape = Record<string, unknown>

const isObject = (v: unknown): v is Shape => typeof v === 'object' && v !== null && !Array.isArray(v)
const isString = (v: unknown): v is string => typeof v === 'string'
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isInt = (v: unknown): v is number => Number.isInteger(v)
const isOptional = (v: unknown, check: (v: unknown) => boolean) => v === undefined || check(v)
const isListOf = (v: unknown, check: (v: unknown) => boolean) => Array.isArray(v) && v.every(check)
const isOneOf = (values: readonly string[]) => (v: unknown) => isString(v) && values.includes(v)

const STAGES = ['plan', 'build', 'ship', 'done'] as const
const VERDICT = ['ready', 'revise', 'rethink'] as const
const WAITS = ['signoff', 'conflict', 'round-limit', 'merge', 'tamper'] as const
const LIGHTS = ['pass', 'fail', 'pending', 'none'] as const

function isReview(v: unknown): boolean {
  return (
    isObject(v) &&
    isOneOf(['plan', 'build'])(v['stage']) &&
    isString(v['perspective']) &&
    isString(v['reviewer']) &&
    isOneOf(VERDICT)(v['verdict']) &&
    isString(v['summary']) &&
    isInt(v['round']) &&
    isInt(v['epoch']) &&
    isNumber(v['at'])
  )
}

function isLogEntry(v: unknown): boolean {
  return isObject(v) && isInt(v['n']) && isNumber(v['at']) && isString(v['text']) && isOptional(v['isForAgent'], b => typeof b === 'boolean')
}

function isWaiting(v: unknown): boolean {
  return (
    isObject(v) &&
    isOneOf(WAITS)(v['kind']) &&
    isString(v['summary']) &&
    isNumber(v['at']) &&
    isOptional(v['perspectives'], p => isListOf(p, isString))
  )
}

function isShip(v: unknown): boolean {
  return (
    isObject(v) &&
    isInt(v['pr']) &&
    isString(v['url']) &&
    isString(v['head']) &&
    isOneOf(LIGHTS)(v['ci']) &&
    isListOf(v['checks'], c => isObject(c) && isString(c['name']) && isOneOf(LIGHTS)(c['light'])) &&
    isInt(v['openThreads']) &&
    typeof v['isMerged'] === 'boolean' &&
    isNumber(v['checkedAt']) &&
    isOptional(v['notice'], isString) &&
    isListOf(v['outsiders'], isString)
  )
}

export function isBatch(v: unknown): v is Batch {
  if (!isObject(v)) return false
  const rounds = v['rounds']
  const tests = v['tests']

  return (
    isString(v['repo']) &&
    isInt(v['lead']) &&
    isString(v['title']) &&
    isListOf(v['issues'], isInt) &&
    (v['issues'] as unknown[]).length > 0 &&
    isOneOf(STAGES)(v['stage']) &&
    isObject(rounds) &&
    isInt(rounds['plan']) &&
    isInt(rounds['build']) &&
    isInt(rounds['ship']) &&
    isInt(v['epoch']) &&
    isListOf(v['vetoes'], isString) &&
    isOptional(v['waiting'], isWaiting) &&
    isOptional(tests, t => isObject(t) && isOneOf(LIGHTS)(t['light']) && isString(t['command']) && isString(t['summary']) && isNumber(t['at'])) &&
    isOptional(v['ship'], isShip) &&
    isListOf(v['reviews'], isReview) &&
    isListOf(v['log'], isLogEntry) &&
    isListOf(v['reviewers'], isString) &&
    (v['reviewers'] as unknown[]).length > 0 &&
    isInt(v['maxRounds']) &&
    isListOf(v['onlineReviewers'], isString) &&
    isListOf(v['maintainers'], isString) &&
    isObject(v['docs']) &&
    ['requirements', 'specifications', 'decisions', 'user'].every(kind => isListOf((v['docs'] as Shape)[kind], isString)) &&
    isString(v['owner']) &&
    isOptional(v['commentId'], isInt) &&
    isOptional(v['planCopy'], c => isObject(c) && isInt(c['id']) && isString(c['url']) && isString(c['digest'])) &&
    isInt(v['rev']) &&
    isNumber(v['startedAt'])
  )
}

/** The record compared for edits: the batch as JSON, without what only this machine knows. */
export function fingerprint(batch: Batch): string {
  return JSON.stringify({ ...batch, commentId: undefined })
}

/**
 * Marks the comment that holds the copy of a batch's plan. Its words match
 * the guard's stage-label pattern on purpose: no agent command can write it.
 */
export const PLAN_MARKER = '<!-- foundry:plan-copy -->'
/** GitHub's limit on a comment is 65,536 characters; the plan's copy keeps well inside it. */
const PLAN_COPY_CHARS = 60_000

/**
 * The comment that copies the batch's plan file to its lead issue, for
 * reading on GitHub, the phone included. The file on the branch stays the
 * plan: the copy says so, and a state marker inside the plan is defused, so
 * the copy is never read as Foundry's state.
 */
export function renderPlanCopy(batch: Batch, path: string, text: string): string {
  const safe = text.replaceAll(STATE_MARKER, '<!-- (state marker) -->')
  const shown = safe.length > PLAN_COPY_CHARS ? `${safe.slice(0, PLAN_COPY_CHARS)}\n\n… The rest is in \`${path}\`.` : safe

  return [
    PLAN_MARKER,
    `**Foundry plan** · ${batch.title} (#${batch.lead})`,
    '',
    `<sub>A copy of \`${path}\` from the batch's branch, kept up to date by the Foundry mod for reading anywhere. The file in the repository is the plan; edits here are replaced.</sub>`,
    '',
    '---',
    '',
    shown,
  ].join('\n')
}

/** A short digest of a text, to tell whether a plan changed since its copy was written. */
export function digest(text: string): string {
  // FNV-1a, 32 bits, with the length: enough to spot an edit, and no secret.
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }

  return `${text.length}:${(hash >>> 0).toString(16)}`
}

/** The revision a fingerprint records. */
export function revisionOf(print: string): number {
  const rev = (JSON.parse(print) as { rev?: unknown }).rev

  return typeof rev === 'number' ? rev : 0
}
