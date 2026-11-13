import { describe, expect, test } from 'claude-code/testing'

import type { Batch, Verdict } from '../types'
import {
  appendLog,
  choices,
  currentRound,
  decide,
  isAllApproved,
  newBatch,
  parseLogins,
  parseReviewers,
  raiseConflict,
  recordReview,
  requestSignoff,
  sendBack,
  trackIndex,
} from '../hooks/model'
import { isBatch, labelsFor, parseState, renderState } from '../hooks/state'

const FIVE = parseReviewers('product-owner,usability,accessibility,architecture,security')
const SETTINGS = {
  reviewers: FIVE,
  maxRounds: 3,
  onlineReviewers: parseLogins('coderabbitai[bot],gitar-bot[bot]'),
  maintainers: ['brylie'],
  botTimeoutMinutes: 30,
}

function start(): Batch {
  return newBatch({ repo: 'o/r', title: 'Name the ports', issues: [12, 14], owner: 's1' }, SETTINGS, 0)
}

let clock = 0
function review(batch: Batch, perspective: string, verdict: Verdict = 'ready') {
  clock += 1

  return recordReview(batch, { perspective, reviewer: `foundry:${perspective}`, verdict, summary: 'ok' }, clock)
}

function approveAll(batch: Batch): Batch {
  return FIVE.reduce((b, p) => review(b, p).batch, batch)
}

function signOff(batch: Batch): Batch {
  const asked = requestSignoff(batch, 'please', 1).batch

  return decide(asked, { action: 'approve' }, 2).batch
}

describe('settings', () => {
  test('perspectives and logins have one spelling each', async () => {
    expect(FIVE).toEqual(['product-owner', 'usability', 'accessibility', 'architecture', 'security'])
    expect(parseReviewers(' Product Owner, security ,, SECURITY')).toEqual(['product-owner', 'security'])
    expect(parseLogins('CodeRabbitAI[bot], gitar-bot')).toEqual(['coderabbitai', 'gitar-bot'])
  })
})

describe('the plan and build loops', () => {
  test('all five must approve before sign-off; four is not enough', async () => {
    let batch = start()
    for (const p of FIVE.slice(0, 4)) batch = review(batch, p).batch
    expect(requestSignoff(batch, 's', 1).error).toContain('Not yet: security')
    batch = review(batch, 'security', 'revise').batch
    expect(isAllApproved(batch)).toBe(false)
    batch = review(batch, 'security').batch
    expect(isAllApproved(batch)).toBe(true)
    expect(requestSignoff(batch, 's', 1).batch.waiting?.kind).toBe('signoff')
  })

  test('a reviewer reviewing again opens the next round, and the round limit escalates', async () => {
    let batch = start()
    batch = review(batch, 'security', 'revise').batch
    expect(currentRound(batch)).toBe(1)
    batch = review(batch, 'security', 'revise').batch
    expect(currentRound(batch)).toBe(2)
    batch = review(batch, 'security', 'revise').batch
    expect(currentRound(batch)).toBe(3)

    const fourth = review(batch, 'security', 'revise')
    expect(fourth.error).toContain('used its 3 rounds')
    expect(fourth.batch.waiting?.kind).toBe('round-limit')
    expect(fourth.batch.waiting?.perspectives).toContain('security')
    expect(choices(fourth.batch)).toEqual(['approve', 'changes', 'veto'])
  })

  test('the round counter resets when work moves to the next stage', async () => {
    let batch = review(review(start(), 'security', 'revise').batch, 'security', 'revise').batch
    expect(currentRound(batch)).toBe(2)
    batch = signOff(approveAll(batch))
    expect(batch.stage).toBe('build')
    expect(currentRound(batch)).toBe(1)
    // The plan's approvals do not carry into the build loop.
    expect(isAllApproved(batch)).toBe(false)
  })

  test('only the person signs off, and the panel track follows', async () => {
    let batch = approveAll(start())
    expect(trackIndex(batch)).toBe(0)
    batch = requestSignoff(batch, 'the plan', 1).batch
    expect(trackIndex(batch)).toBe(1)
    expect(review(batch, 'security').error).toContain('waiting on the person')

    const back = decide(batch, { action: 'changes' }, 2)
    expect(back.batch.stage).toBe('plan')
    expect(currentRound(back.batch)).toBe(2)
    expect(isAllApproved(back.batch)).toBe(false)
    expect(back.note).toContain('asked for changes')

    batch = decide(batch, { action: 'approve' }, 2).batch
    expect(batch.stage).toBe('build')
    expect(trackIndex(batch)).toBe(2)
  })
})

describe('review findings', () => {
  test('an extra perspective, such as a navigator, never uses up the rounds', async () => {
    let batch = start()
    for (let i = 0; i < 6; i++) {
      const move = review(batch, 'navigator', 'revise')
      expect(move.error).toBeUndefined()
      batch = move.batch
    }
    expect(currentRound(batch)).toBe(1)
    expect(batch.waiting).toBeUndefined()
  })

  test('the log numbers its lines past what it keeps, so a delivery cursor survives the trim', async () => {
    let batch = start()
    for (let i = 0; i < 70; i++) batch = appendLog(batch, i, `line ${i}`, i % 2 === 0)
    expect(batch.log).toHaveLength(60)
    expect(batch.log.at(-1)?.n).toBe(71)
    expect(batch.log[0]?.n).toBe(12)
  })

  test('a state record missing fields is skipped, not trusted', async () => {
    const partial = '<!-- foundry:state -->\n```json\n{"foundry":1,"batch":{"lead":12}}\n```'
    expect(parseState(partial)).toBeUndefined()
    const wrongStage = renderState({ ...start(), stage: 'shipping' as never })
    expect(parseState(wrongStage)).toBeUndefined()
    expect(isBatch(start())).toBe(true)

    const ship = {
      pr: 9,
      url: 'u',
      head: 'h',
      headSeenAt: 0,
      ci: 'pass',
      checks: [],
      bots: [{ login: 'coderabbitai', light: 'changes', detail: '1 thread' }],
      openThreads: 0,
      isMerged: false,
      checkedAt: 0,
      dismissed: [],
      outsiders: [],
    }
    expect(isBatch({ ...start(), stage: 'ship', ship })).toBe(true)
    expect(isBatch({ ...start(), stage: 'ship', ship: { ...ship, bots: [{ login: 'coderabbitai', light: 'changes', detail: 123 }] } })).toBe(false)
  })
})

describe('conflicts', () => {
  test('a conflict escalates; a veto counts that reviewer as approved for the stage', async () => {
    let batch = FIVE.slice(0, 4).reduce((b, p) => review(b, p).batch, start())
    batch = review(batch, 'security', 'revise').batch
    batch = raiseConflict(batch, ['usability', 'security'], 'Usability wants X, security forbids it', 3).batch
    expect(batch.waiting?.kind).toBe('conflict')
    expect(choices(batch)).toEqual(['veto', 'compromise'])

    const vetoed = decide(batch, { action: 'veto', perspective: 'security' }, 4)
    expect(vetoed.batch.waiting).toBeUndefined()
    expect(isAllApproved(vetoed.batch)).toBe(true)
    expect(vetoed.note).toContain('request sign-off')

    // The veto lasts for this stage only.
    expect(signOff(vetoed.batch).vetoes).toEqual([])

    const compromise = decide(batch, { action: 'compromise' }, 4)
    expect(compromise.batch.waiting).toBeUndefined()
    expect(compromise.note).toContain('compromise')
  })

  test('a conflict needs two reviewers', async () => {
    expect(raiseConflict(start(), ['security'], 'x', 1).error).toContain('at least two')
  })
})

describe('the ship stage', () => {
  function shipping(): Batch {
    return signOff(approveAll(signOff(approveAll(start()))))
  }

  test('a send-back is a ship round, and the ship counter runs across build loops', async () => {
    let batch = shipping()
    expect(batch.stage).toBe('ship')
    expect(batch.rounds.ship).toBe(1)

    batch = sendBack(batch, 'ci-failure', 'unit tests', 5).batch
    expect(batch.stage).toBe('build')
    expect(batch.rounds.ship).toBe(2)
    expect(batch.rounds.build).toBe(1)
    expect(isAllApproved(batch)).toBe(false)

    batch = sendBack(signOff(approveAll(batch)), 'changes-requested', 'coderabbit', 6).batch
    expect(batch.rounds.ship).toBe(3)

    const limit = sendBack(signOff(approveAll(batch)), 'ci-failure', 'again', 7)
    expect(limit.error).toContain('used its 3 rounds')
    expect(limit.batch.stage).toBe('ship')
    expect(choices(limit.batch)).toEqual(['changes', 'end'])
  })

  test('ending a batch turns its gates off', async () => {
    const ended = decide(shipping(), { action: 'end' }, 9)
    expect(ended.batch.stage).toBe('done')
    expect(labelsFor(ended.batch)).toEqual([])
  })
})

describe('the state comment', () => {
  test('a batch round-trips through its comment, and its labels follow the stage', async () => {
    const batch = requestSignoff(approveAll(start()), 'the plan', 3).batch
    const body = renderState(batch)
    expect(body).toContain('<!-- foundry:state -->')
    expect(body).toContain('waiting on the maintainer: Sign-off')
    expect(parseState(body)).toEqual(batch)
    expect(parseState('a plain comment')).toBeUndefined()
    expect(labelsFor(batch)).toEqual(['foundry', 'foundry:plan', 'foundry:waiting'])
  })
})
