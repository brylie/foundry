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

/** The batch a state comment holds, or undefined when the body is not one. */
export function parseState(body: string): Batch | undefined {
  if (!body.includes(STATE_MARKER)) return undefined
  const match = /```json\n([\s\S]*?)\n```/.exec(body)
  if (!match?.[1]) return undefined
  try {
    const data = JSON.parse(match[1]) as { foundry?: number; batch?: Batch }
    if (data.foundry !== STATE_VERSION || typeof data.batch?.lead !== 'number') return undefined

    return data.batch
  } catch {
    return undefined
  }
}

/** The record compared for edits: the batch as JSON, without what only this machine knows. */
export function fingerprint(batch: Batch): string {
  return JSON.stringify({ ...batch, commentId: undefined })
}
