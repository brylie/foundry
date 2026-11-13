// The state comment: how a batch is written into GitHub and read back. Free
// of `$`, so tests check the round trip directly.

import type { Batch } from '../types'
import { STATE_MARKER } from './guard'
import { TRACK, WAIT_LABEL, currentRound, isLoopStage, perspectiveStates, trackIndex } from './model'

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
    `Stage: **${step}**${round}${batch.waiting ? ` · ⚠️ waiting on the maintainer: ${WAIT_LABEL[batch.waiting.kind]}` : ''}`,
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

    return data.foundry === STATE_VERSION && isBatch(data.batch) ? data.batch : undefined
  } catch {
    return undefined
  }
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
const WAITS = ['signoff', 'conflict', 'round-limit', 'bot-timeout', 'bot-comment', 'merge', 'tamper'] as const
const LIGHTS = ['pass', 'fail', 'pending', 'none'] as const
const BOT_LIGHTS = ['waiting', 'busy', 'reviewed', 'changes', 'comment', 'dismissed', 'timeout'] as const

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
    isOptional(v['perspectives'], p => isListOf(p, isString)) &&
    isOptional(v['bots'], b => isListOf(b, isString))
  )
}

function isShip(v: unknown): boolean {
  return (
    isObject(v) &&
    isInt(v['pr']) &&
    isString(v['url']) &&
    isString(v['head']) &&
    isNumber(v['headSeenAt']) &&
    isOneOf(LIGHTS)(v['ci']) &&
    isListOf(v['checks'], c => isObject(c) && isString(c['name']) && isOneOf(LIGHTS)(c['light'])) &&
    isListOf(v['bots'], b => isObject(b) && isString(b['login']) && isOneOf(BOT_LIGHTS)(b['light'])) &&
    isInt(v['openThreads']) &&
    typeof v['isMerged'] === 'boolean' &&
    isNumber(v['checkedAt']) &&
    isListOf(v['dismissed'], isString) &&
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
    isNumber(v['botTimeoutMinutes']) &&
    isString(v['owner']) &&
    isOptional(v['commentId'], isInt) &&
    isInt(v['rev']) &&
    isNumber(v['startedAt'])
  )
}

/** The record compared for edits: the batch as JSON, without what only this machine knows. */
export function fingerprint(batch: Batch): string {
  return JSON.stringify({ ...batch, commentId: undefined })
}
