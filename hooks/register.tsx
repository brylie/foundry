// Foundry's mod: the gate logic of each batch's stages, the tools the
// oversight agent moves a batch with, the guards, and the panel where the
// person signs off. The batch's record lives in GitHub; this session keeps a
// copy to draw from and to notice edits made around the mod.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Batch, Light, Meta, Verdict } from '../types'
import { currentRepo, ensureLabels, fetchPr, loadBatches, writeBatch } from './github'
import { bashActions, editRefusal, refusal, scriptRefusal, stateRefusal } from './guard'
import {
  DEFAULT_BOT_TIMEOUT_MINUTES,
  DEFAULT_MAX_ROUNDS,
  DEFAULT_ONLINE_REVIEWERS,
  DEFAULT_REVIEWERS,
  TRACK,
  VERDICTS,
  WAIT_LABEL,
  batchKey,
  choices,
  currentRound,
  decide,
  extraReviews,
  isLoopStage,
  keyOf,
  newBatch,
  parseLogins,
  parseReviewers,
  perspectiveStates,
  prOpened,
  raiseConflict,
  recordReview,
  recordTests,
  requestSignoff,
  sendBack,
  trackIndex,
} from './model'
import type { Decision, Move, Settings } from './model'
import { readShip } from './ship'
import { fingerprint } from './state'

const PANE = 'foundry'
const COMMAND = 'foundry'
const POLL_MS = 60_000
const SYNC_EVERY = 5

// Change a tag when its value's fields change: an older stored value then reads as the initial one.
const batchesAtom = atom({ plugin: 'foundry', key: 'batches' } as const, [] as Batch[], { shape: 'batches-1' })
const EMPTY_META: Meta = { mine: null, written: {}, delivered: {}, errors: {}, syncedAt: 0 }
const metaAtom = atom({ plugin: 'foundry', key: 'meta' } as const, EMPTY_META, { shape: 'meta-1' })

// Where a person's own command can come from. A peer session, a channel or a
// plugin is never the person signing off.
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk'])

const VERDICT_MARK: Record<Verdict, string> = { ready: '✓', revise: '~', rethink: '✗' }
const VERDICT_COLOR: Record<Verdict, string> = { ready: 'success', revise: 'warning', rethink: 'error' }
const LIGHT_MARK: Record<Light, string> = { pass: '✓', fail: '✗', pending: '…', none: '—' }
const LIGHT_COLOR: Record<Light, string> = { pass: 'success', fail: 'error', pending: 'warning', none: 'subtle' }

type Options = { reviewers?: string; maxRounds?: number; onlineReviewers?: string; botTimeoutMinutes?: number }

function settingsFrom(options: Options): Settings {
  // An empty list would let a gate pass with no reviews at all, so it means the defaults.
  const reviewers = parseReviewers(options.reviewers ?? '')
  const rounds = Math.floor(Number(options.maxRounds ?? DEFAULT_MAX_ROUNDS))
  const timeout = Number(options.botTimeoutMinutes ?? DEFAULT_BOT_TIMEOUT_MINUTES)

  return {
    reviewers: reviewers.length > 0 ? reviewers : parseReviewers(DEFAULT_REVIEWERS),
    maxRounds: Number.isFinite(rounds) && rounds >= 1 ? rounds : DEFAULT_MAX_ROUNDS,
    onlineReviewers: parseLogins(options.onlineReviewers ?? DEFAULT_ONLINE_REVIEWERS),
    botTimeoutMinutes: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_BOT_TIMEOUT_MINUTES,
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isActive(batch: Batch | undefined): batch is Batch {
  return batch !== undefined && batch.stage !== 'done'
}

// -------------------------------------------------------------------------
// Reading and writing the session's copy, and GitHub behind it.

async function mine($: EngineInterface): Promise<Batch | undefined> {
  const meta = await read($, metaAtom)
  if (meta.mine === null) return undefined

  return (await read($, batchesAtom)).find(b => batchKey(b) === meta.mine)
}

async function byKey($: EngineInterface, key: string): Promise<Batch | undefined> {
  return (await read($, batchesAtom)).find(b => batchKey(b) === key)
}

/** Keeps the batch in this session's copy, then writes it to GitHub. */
async function save($: EngineInterface, batch: Batch): Promise<Batch> {
  const key = batchKey(batch)
  let saved: Batch = { ...batch, rev: batch.rev + 1 }
  await update($, batchesAtom, list => [...list.filter(b => batchKey(b) !== key), saved])
  try {
    saved = await writeBatch($, saved)
    const written = saved
    await update($, batchesAtom, list => list.map(b => (batchKey(b) === key ? written : b)))
    await update($, metaAtom, meta => {
      const { [key]: _, ...errors } = meta.errors

      return { ...meta, written: { ...meta.written, [key]: fingerprint(written) }, errors }
    })
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    await update($, metaAtom, meta => ({ ...meta, errors: { ...meta.errors, [key]: text.slice(0, 300) } }))
  }
  await show($)

  return saved
}

/** Runs a move on a batch and keeps what it changed, a refused move's escalation included. */
async function apply($: EngineInterface, key: string, move: (batch: Batch) => Move): Promise<Move | undefined> {
  const batch = await byKey($, key)
  if (batch === undefined) return undefined
  const result = move(batch)
  if (result.batch === batch) return result

  const before = batch.waiting
  const saved = await save($, result.batch)
  if (saved.waiting !== undefined && saved.waiting !== before) {
    $.ui.toast(`Foundry: waiting on you: ${WAIT_LABEL[saved.waiting.kind]}`)
  }

  return { ...result, batch: saved }
}

/** The log lines meant for the agent that this session has not passed on yet. */
async function undelivered($: EngineInterface, batch: Batch): Promise<string[]> {
  const key = batchKey(batch)
  const meta = await read($, metaAtom)
  if (meta.mine !== key) return []
  const notes = batch.log.filter(entry => entry.isForAgent === true)
  const count = meta.delivered[key] ?? 0
  // The log keeps its last lines only; a count past them starts over.
  const start = count > notes.length ? notes.length : count
  await update($, metaAtom, m => ({ ...m, delivered: { ...m.delivered, [key]: notes.length } }))

  return notes.slice(start).map(entry => entry.text)
}

/** Wakes the agent with what it has not heard, from a press or a timer. */
async function wake($: EngineInterface, batch: Batch | undefined): Promise<void> {
  if (batch === undefined) return
  const notes = await undelivered($, batch)
  if (notes.length > 0) await $.prompt.submit({ text: `Foundry, "${batch.title}":\n${notes.join('\n')}` })
}

/**
 * Reads every open batch from GitHub. A batch this session wrote whose
 * comment changed without a newer revision, or vanished, is restored from
 * this session's copy and flagged to the person.
 */
async function sync($: EngineInterface): Promise<void> {
  const repo = await currentRepo($)
  if (repo === undefined) return
  let remote: Batch[]
  try {
    remote = await loadBatches($, repo)
  } catch {
    return
  }
  const now = await $.clock.now()
  const meta = await read($, metaAtom)
  const local = await read($, batchesAtom)
  const merged: Batch[] = []
  const restore: Batch[] = []

  for (const theirs of remote) {
    const key = batchKey(theirs)
    const ours = local.find(b => batchKey(b) === key)
    const wrote = meta.written[key]
    if (ours !== undefined && wrote !== undefined && theirs.rev <= ours.rev && fingerprint(theirs) !== wrote) {
      restore.push(ours)
      merged.push(ours)
    } else {
      merged.push(ours !== undefined && ours.rev > theirs.rev ? ours : theirs)
    }
  }
  for (const ours of local) {
    const key = batchKey(ours)
    if (merged.some(b => batchKey(b) === key)) continue
    // This session's own batch that vanished from GitHub is put back; others' finished ones stay on the panel.
    if (ours.repo === repo && isActive(ours) && meta.mine === key && meta.written[key] !== undefined) restore.push(ours)
    if (ours.repo !== repo || !isActive(ours) || meta.mine === key) merged.push(ours)
  }

  await update($, batchesAtom, () => merged)
  await update($, metaAtom, m => ({ ...m, syncedAt: now }))
  for (const batch of restore) {
    const flagged: Batch =
      batch.waiting === undefined
        ? {
            ...batch,
            waiting: {
              kind: 'tamper',
              summary: "Foundry's state on GitHub was changed or removed outside the mod. It was restored from this session's copy.",
              at: now,
            },
          }
        : batch
    await save($, { ...flagged, log: [...flagged.log, { at: now, text: 'Restored the state comment after an outside edit.' }] })
  }
  await show($)
  await wake($, await mine($))
}

/** Reads this session's shipping pull request into its gates. */
async function pollShip($: EngineInterface): Promise<void> {
  const batch = await mine($)
  if (!isActive(batch) || batch.stage !== 'ship' || batch.ship === undefined) return
  const prior = batch.ship
  let pr
  try {
    pr = await fetchPr($, batch.repo, prior.pr)
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    await update($, metaAtom, m => ({ ...m, errors: { ...m.errors, [batchKey(batch)]: text.slice(0, 300) } }))

    return
  }
  const now = await $.clock.now()
  const reading = readShip(batch, prior, pr, now)
  let ship = reading.ship
  let next: Batch = { ...batch, ship }

  if (reading.isMerged) {
    next = {
      ...next,
      stage: 'done',
      waiting: undefined,
      log: [...next.log, { at: now, text: `Pull request #${pr.number} merged. The batch is done.`, isForAgent: true }],
    }
  } else {
    // The ship stage's own waits come and go with GitHub; a decision of another kind stays until the person makes it.
    const isShipWait = next.waiting === undefined || ['bot-timeout', 'bot-comment', 'merge'].includes(next.waiting.kind)
    if (isShipWait) {
      const keep = next.waiting !== undefined && next.waiting.kind === reading.waiting?.kind ? next.waiting.at : now
      next = { ...next, waiting: reading.waiting ? { ...reading.waiting, at: keep } : undefined }
    }
    if (reading.notice && reading.notice.key !== prior.notice) {
      ship = { ...ship, notice: reading.notice.key }
      next = { ...next, ship, log: [...next.log, { at: now, text: reading.notice.text, isForAgent: true }] }
    }
  }

  // Lights refresh in this session every minute; GitHub is written only when the record changes.
  const isChanged = fingerprint({ ...next, ship: { ...ship, checkedAt: 0 } }) !== fingerprint({ ...batch, ship: { ...prior, checkedAt: 0 } })
  if (!isChanged) {
    await update($, batchesAtom, list => list.map(b => (batchKey(b) === batchKey(next) ? next : b)))

    return
  }
  const before = batch.waiting?.kind
  const saved = await save($, next)
  if (saved.waiting !== undefined && saved.waiting.kind !== before) $.ui.toast(`Foundry: waiting on you: ${WAIT_LABEL[saved.waiting.kind]}`)
  await wake($, saved)
}

function statusText(batch: Batch | undefined): string | undefined {
  if (batch === undefined) return undefined
  if (batch.stage === 'done') return `foundry: ${batch.title} done`
  if (batch.waiting) return `foundry: waiting on you: ${WAIT_LABEL[batch.waiting.kind]}`

  return `foundry: ${TRACK[trackIndex(batch)]} · round ${currentRound(batch)}/${batch.maxRounds}`
}

async function show($: EngineInterface): Promise<void> {
  $.ui.status(statusText(await mine($)))
}

async function repoRoot($: EngineInterface): Promise<string> {
  const repo = await $.session.repo()

  return repo?.root ?? (await $.session.cwd())
}

async function commentIds($: EngineInterface): Promise<number[]> {
  return (await read($, batchesAtom)).flatMap(b => (b.commentId === undefined ? [] : [b.commentId]))
}

/** What the agent reads about a batch: where it stands and what to do next. */
function describe(batch: Batch): string {
  const round = batch.stage === 'done' ? '' : `, round ${currentRound(batch)} of ${batch.maxRounds}`
  const lines = [
    `Batch: ${batch.title} (${batch.repo}, lead issue #${batch.lead})`,
    `Issues: ${batch.issues.map(n => `#${n}`).join(', ')}`,
    `Stage: ${TRACK[trackIndex(batch)]}${round}`,
    `Required reviewers (every one must approve each loop stage): ${batch.reviewers.join(', ')}`,
  ]
  if (batch.waiting) lines.push(`WAITING ON THE PERSON: ${WAIT_LABEL[batch.waiting.kind]}. ${batch.waiting.summary}`)
  if (isLoopStage(batch.stage)) {
    for (const p of perspectiveStates(batch)) {
      const where = p.isVetoed
        ? 'vetoed by the person (counts as approved)'
        : p.latest
          ? `${p.latest.verdict} (round ${p.latest.round}, ${p.latest.reviewer})`
          : 'not reviewed'
      lines.push(`  - ${p.perspective}: ${where}`)
    }
    for (const r of extraReviews(batch)) lines.push(`  - ${r.perspective} (extra, does not count): ${r.verdict}`)
  }
  if (batch.tests) lines.push(`Tests: ${batch.tests.light} (${batch.tests.command})`)
  if (batch.ship) {
    const ship = batch.ship
    const failing = ship.checks.filter(c => c.light === 'fail').map(c => c.name)
    lines.push(`Pull request: ${ship.url}`, `CI: ${ship.ci}${failing.length > 0 ? ` (failing: ${failing.join(', ')})` : ''}`)
    lines.push(`Online reviewers: ${ship.bots.map(b => `${b.login} ${b.light}`).join(', ') || '(none configured)'}; open threads: ${ship.openThreads}`)
  }

  return lines.join('\n')
}

/** A person's decision from a press: applies it, then wakes the agent if this session runs the batch. */
async function pressDecide($: EngineInterface, key: string, decision: Decision): Promise<void> {
  const now = await $.clock.now()
  const result = await apply($, key, batch => decide(batch, decision, now))
  if (result === undefined || result.error) return
  await wake($, result.batch)
  if (decision.action === 'end') await releaseIfMine($, key)
  await afterShipDecision($, decision)
}

/** A ship decision (a dismissal, more waiting) re-reads the pull request at once, so the next wait shows now. */
async function afterShipDecision($: EngineInterface, decision: Decision): Promise<void> {
  if (decision.action === 'dismiss' || decision.action === 'keep-waiting') await pollShip($)
}

async function releaseIfMine($: EngineInterface, key: string): Promise<void> {
  await update($, metaAtom, meta => (meta.mine === key ? { ...meta, mine: null } : meta))
  await show($)
}

async function clearCard($: EngineInterface, key: string): Promise<void> {
  await update($, batchesAtom, list => list.filter(b => batchKey(b) !== key))
  await releaseIfMine($, key)
}

async function openPane($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: 'Foundry' })
}

// -------------------------------------------------------------------------
// The module.

export const register: Register = (on, options) => {
  const settings = settingsFrom(options as Options)
  const reviewers = settings.reviewers.join(', ')

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Foundry: status, approve, changes, veto <reviewer>, compromise, wait, dismiss <bot>, ack, end, sync, pane',
      argumentHint: '[status | approve | changes | veto <reviewer> | compromise | wait | dismiss <bot> | ack | end | sync | pane] [#lead]',
    })

    const tools: { name: string; description: string; properties: Record<string, unknown>; required: string[] }[] = [
      {
        name: 'batch_start',
        description:
          "Start a Foundry batch for related GitHub issues before planning them (the first issue is the lead; it holds the batch's state comment). The mod labels the issues and writes the state to GitHub. While the batch runs, its stage holds back edits, commits, claims, pushes and the pull request until the person signs off, and only the person signs off. Starting with a lead issue that already has a batch takes that batch over in this session.",
        properties: {
          title: { type: 'string', description: 'The pull request title the batch will ship.' },
          issues: { type: 'array', items: { type: 'integer' }, description: 'Issue numbers, lead first.' },
        },
        required: ['title', 'issues'],
      },
      {
        name: 'review_record',
        description: `Record one reviewer's verdict in the current loop stage (plan or build). Every one of these reviewers must approve (verdict ready): ${reviewers}. Another perspective is recorded and shown, never counted. A reviewer's second verdict in a round opens the next round; at ${settings.maxRounds} rounds the stage escalates to the person. Verdicts: ready (no change, or small items only), revise (the listed changes are enough), rethink (the approach has a problem).`,
        properties: {
          perspective: { type: 'string', description: `One of ${reviewers}, or another (shown, not counted).` },
          reviewer: { type: 'string', description: 'Who reviewed, e.g. "foundry:security" or a session name.' },
          verdict: { type: 'string', enum: [...VERDICTS] },
          summary: { type: 'string', description: 'The verdict and the findings that matter, in a few lines.' },
        },
        required: ['perspective', 'reviewer', 'verdict', 'summary'],
      },
      {
        name: 'conflict_raise',
        description:
          'Escalate a reviewer conflict to the person: two or more reviewers want things that cannot both hold. The person vetoes one or writes a compromise. End your turn after calling it.',
        properties: {
          perspectives: { type: 'array', items: { type: 'string' }, description: 'The reviewers in conflict.' },
          summary: { type: 'string', description: 'Markdown: what each wants, why both cannot hold, and your recommendation.' },
        },
        required: ['perspectives', 'summary'],
      },
      {
        name: 'tests_record',
        description: "Record a local test run of the batch, for the panel and the reviewers. Run the project's own test command first.",
        properties: {
          command: { type: 'string' },
          passed: { type: 'boolean' },
          summary: { type: 'string', description: 'Counts, and any failure in one line.' },
        },
        required: ['command', 'passed', 'summary'],
      },
      {
        name: 'signoff_request',
        description:
          'Ask the person to sign off the current loop stage (the plan, or the implementation) once every required reviewer approves. The summary is shown beside Approve and Request changes. End your turn after calling it; you will be told the decision.',
        properties: { summary: { type: 'string', description: 'Markdown: what the person signs off, how each review ended, what is still open.' } },
        required: ['summary'],
      },
      {
        name: 'pr_opened',
        description:
          'Record the pull request after the build sign-off. The mod then watches its ship gates: CI, and each online reviewer on the head commit. It tells you when CI fails, changes are requested, or it is ready to merge.',
        properties: { pr: { type: 'string', description: 'The pull request URL or number.' } },
        required: ['pr'],
      },
      {
        name: 'send_back',
        description: `Send a shipping batch back to the build loop to fix a CI failure or requested changes. It counts as a ship round (${settings.maxRounds} allowed). A plain rerun of a flaky test (\`gh run rerun <run-id> --failed\`) is not a round: rerun instead of sending back when the failure is flaky.`,
        properties: {
          reason: { type: 'string', enum: ['ci-failure', 'changes-requested'] },
          summary: { type: 'string', description: 'What failed or what was asked.' },
        },
        required: ['reason', 'summary'],
      },
      {
        name: 'batch_status',
        description:
          "Read this session's batch (stage, round, reviewer verdicts, tests, CI, online reviewers, what waits on the person) and the other open batches in the repository.",
        properties: {},
        required: [],
      },
    ]
    for (const tool of tools) {
      await $.tool.register({
        name: tool.name,
        description: tool.description,
        isDeferred: false,
        inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
      })
    }

    let ticks = 0
    $.clock.every(POLL_MS, () => {
      ticks += 1
      void pollShip($)
      if (ticks % SYNC_EVERY === 0) void sync($)
    })

    await sync($)
    if ((await mine($)) !== undefined) void openPane($)

    return next(e)
  })

  // -------------------------------------------------------------------------
  // The tools.

  on('tool.call', { tool: 'mcp__foundry__batch_start' }, async ($, e) => {
    const args = e as unknown as Record<string, unknown>
    const title = str(args['title'])
    const raw = Array.isArray(args['issues']) ? args['issues'] : []
    const issues = [...new Set(raw.filter((n): n is number => Number.isInteger(n) && n > 0))]
    if (!title || issues.length === 0) return { deny: 'batch_start needs a title and at least one issue number.' }

    const current = await mine($)
    if (isActive(current)) return { deny: `This session already runs "${current.title}". Finish it, or ask the person to end it.` }

    const repo = await currentRepo($)
    if (repo === undefined) return { deny: 'Foundry needs a GitHub repository: run it inside a clone with `gh` signed in.' }
    await sync($)
    const all = await read($, batchesAtom)
    const lead = issues[0] ?? 0
    const clash = all.find(b => b.repo === repo && isActive(b) && b.lead !== lead && b.issues.some(n => issues.includes(n)))
    if (clash) {
      const shared = clash.issues.filter(n => issues.includes(n)).map(n => `#${n}`).join(', ')

      return { deny: `Issue ${shared} is already in the batch "${clash.title}" (lead #${clash.lead}).` }
    }

    const owner = await $.session.id()
    const now = await $.clock.now()
    const existing = all.find(b => b.repo === repo && b.lead === lead && isActive(b))
    const batch: Batch =
      existing !== undefined
        ? { ...existing, owner, log: [...existing.log, { at: now, text: 'Taken over by another session.' }] }
        : newBatch({ repo, title, issues, owner }, settings, now)
    try {
      await ensureLabels($, repo)
    } catch {
      // Writing the state below reports the same error to the person.
    }
    const key = keyOf(repo, lead)
    await update($, metaAtom, meta => ({
      ...meta,
      mine: key,
      delivered: { ...meta.delivered, [key]: batch.log.filter(l => l.isForAgent).length },
    }))
    const saved = await save($, batch)
    void openPane($)
    const error = (await read($, metaAtom)).errors[key]
    const next =
      saved.stage === 'plan' && saved.waiting === undefined
        ? `write the plan, then spawn one reviewer sub-agent per required perspective (${saved.reviewers.join(', ')}) and record each verdict with review_record.`
        : 'carry on from the stage above.'

    return {
      result: `${existing ? 'Took over' : 'Started'} the batch.\n${describe(saved)}${error ? `\n\nCould not write the state to GitHub yet: ${error}` : ''}\n\nNext: ${next}`,
    }
  })

  on('tool.call', { tool: 'mcp__foundry__review_record' }, async ($, e) => {
    const args = e as unknown as Record<string, unknown>
    const verdict = VERDICTS.find(v => v === args['verdict'])
    const input = { perspective: str(args['perspective']), reviewer: str(args['reviewer']), summary: str(args['summary']) }
    if (!verdict || !input.perspective || !input.reviewer || !input.summary) {
      return { deny: 'review_record needs perspective, reviewer, verdict and summary.' }
    }
    const batch = await mine($)
    if (!isActive(batch)) return { deny: 'This session runs no Foundry batch. Call batch_start first.' }
    const now = await $.clock.now()
    const result = await apply($, batchKey(batch), b => recordReview(b, { ...input, verdict }, now))
    if (result?.error) return { deny: result.error }

    return { result: describe(result?.batch ?? batch) }
  })

  on('tool.call', { tool: 'mcp__foundry__conflict_raise' }, async ($, e) => {
    const args = e as unknown as Record<string, unknown>
    const raw = Array.isArray(args['perspectives']) ? args['perspectives'] : []
    const perspectives = raw.filter((p): p is string => typeof p === 'string')
    const summary = str(args['summary'])
    const batch = await mine($)
    if (!isActive(batch)) return { deny: 'This session runs no Foundry batch.' }
    if (!summary) return { deny: 'conflict_raise needs a summary.' }
    const now = await $.clock.now()
    const result = await apply($, batchKey(batch), b => raiseConflict(b, perspectives, summary, now))
    if (result?.error) return { deny: result.error }
    void openPane($)

    return { result: 'Escalated the conflict to the person. End your turn and tell them what you need decided.' }
  })

  on('tool.call', { tool: 'mcp__foundry__tests_record' }, async ($, e) => {
    const args = e as unknown as Record<string, unknown>
    const command = str(args['command'])
    const summary = str(args['summary'])
    const passed = args['passed']
    if (!command || typeof passed !== 'boolean') return { deny: 'tests_record needs command, passed and summary.' }
    const batch = await mine($)
    if (!isActive(batch)) return { deny: 'This session runs no Foundry batch.' }
    const now = await $.clock.now()
    await apply($, batchKey(batch), b => ({ batch: recordTests(b, { command, isPassing: passed, summary }, now) }))

    return { result: `Recorded: tests ${passed ? 'pass' : 'fail'}.` }
  })

  on('tool.call', { tool: 'mcp__foundry__signoff_request' }, async ($, e) => {
    const summary = str((e as unknown as Record<string, unknown>)['summary'])
    if (!summary) return { deny: 'signoff_request needs a summary.' }
    const batch = await mine($)
    if (!isActive(batch)) return { deny: 'This session runs no Foundry batch.' }
    const now = await $.clock.now()
    const result = await apply($, batchKey(batch), b => requestSignoff(b, summary, now))
    if (result?.error) return { deny: result.error }
    void openPane($)

    return {
      result:
        'Asked the person to sign off. End your turn now and tell them what they are signing off; they decide in the Foundry pane or with /foundry approve.',
    }
  })

  on('tool.call', { tool: 'mcp__foundry__pr_opened' }, async ($, e) => {
    const text = str((e as unknown as Record<string, unknown>)['pr'])
    const number = Number(/\/pull\/(\d+)/.exec(text)?.[1] ?? text.replace(/^#/, ''))
    if (!Number.isInteger(number) || number <= 0) return { deny: 'pr_opened needs the pull request URL or number.' }
    const batch = await mine($)
    if (!isActive(batch)) return { deny: 'This session runs no Foundry batch.' }
    const url = text.startsWith('http') ? text : `https://github.com/${batch.repo}/pull/${number}`
    const now = await $.clock.now()
    const result = await apply($, batchKey(batch), b => prOpened(b, number, url, now))
    if (result?.error) return { deny: result.error }
    await pollShip($)
    const after = await mine($)

    return {
      result: `Watching pull request #${number}.\n${after ? describe(after) : ''}\n\nWait for CI and the online reviewers; you will be told when something needs you. Do not merge: that is the person's.`,
    }
  })

  on('tool.call', { tool: 'mcp__foundry__send_back' }, async ($, e) => {
    const args = e as unknown as Record<string, unknown>
    const reason = args['reason'] === 'ci-failure' || args['reason'] === 'changes-requested' ? args['reason'] : undefined
    const summary = str(args['summary'])
    if (!reason || !summary) return { deny: 'send_back needs reason (ci-failure or changes-requested) and summary.' }
    const batch = await mine($)
    if (!isActive(batch)) return { deny: 'This session runs no Foundry batch.' }
    const now = await $.clock.now()
    const result = await apply($, batchKey(batch), b => sendBack(b, reason, summary, now))
    if (result?.error) return { deny: result.error }

    return {
      result: `Back in the build loop.\n${describe(result?.batch ?? batch)}\n\nFix it, run the tests, then every reviewer reviews the fix before the build sign-off.`,
    }
  })

  on('tool.call', { tool: 'mcp__foundry__batch_status' }, async $ => {
    await sync($)
    const own = await mine($)
    const others = (await read($, batchesAtom)).filter(b => b !== own && isActive(b))
    const lines = [own ? describe(own) : 'This session runs no Foundry batch.']
    if (others.length > 0) {
      lines.push('', 'Other open batches:')
      for (const b of others) lines.push(`- #${b.lead} ${b.title}: ${TRACK[trackIndex(b)]}${b.waiting ? ' (waiting on the person)' : ''}`)
    }

    return { result: lines.join('\n') }
  })

  // -------------------------------------------------------------------------
  // The guards. Each fails closed: if the check itself throws, the call is refused.

  const FAILED = 'Foundry: its guard failed, so the call was refused.'

  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit'] }, async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const path = str(input['file_path']) || str(input['notebook_path'])
    const content = [input['content'], input['new_string'], input['new_source']].filter((v): v is string => typeof v === 'string').join('\n')
    const script = scriptRefusal(path, content, await commentIds($), $.plugin.root)
    if (script) return { deny: script }

    const batch = await mine($)
    if (!isActive(batch)) return next(e)
    const why = editRefusal(batch, await repoRoot($), path)

    return why ? { deny: why } : next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: FAILED }))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const state = stateRefusal(e.command, await commentIds($))
    if (state) return { deny: state }

    const batch = await mine($)
    for (const action of bashActions(e.command)) {
      // Merging is the person's whether or not a batch runs here.
      const why = action === 'merge' || isActive(batch) ? refusal(batch ?? DONE, action) : undefined
      if (why) return { deny: why }
    }

    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: FAILED }))

  // Sign-offs are the person's: the agent may not run the command for them.
  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    const skill = str((e as unknown as Record<string, unknown>)['skill'])

    return /(^|:)foundry$/.test(skill) ? { deny: 'Foundry: /foundry is for the person. Use the mcp__foundry__ tools instead.' } : next(e)
  })

  // -------------------------------------------------------------------------
  // The person's command.

  on('command.run', { command: COMMAND }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(Boolean)
    const target = words.find(w => /^#\d+$/.test(w))
    const [verb = 'status', arg] = words.filter(w => w !== target)

    if (verb === 'pane') {
      await openPane($)

      return { text: 'Foundry pane opened.' }
    }
    if (verb === 'sync') {
      await sync($)

      return { text: 'Synced the batches from GitHub.' }
    }

    const all = await read($, batchesAtom)
    const own = await mine($)
    const batch = target ? all.find(b => b.lead === Number(target.slice(1)) && (own === undefined || b.repo === own.repo)) : own
    if (verb === 'status') return { text: batch ? describe(batch) : 'No Foundry batch here. Open the pane with /foundry pane to see every batch.' }
    if (!PERSON_ORIGINS.has(e.origin.kind)) return { text: 'Foundry: sign-offs come only from the person at the prompt.' }
    if (batch === undefined) return { text: 'No Foundry batch to act on. Name one by its lead issue, e.g. /foundry approve #45.' }

    const decision: Decision | undefined =
      verb === 'approve'
        ? { action: 'approve' }
        : verb === 'changes'
          ? { action: 'changes' }
          : verb === 'veto' && arg
            ? { action: 'veto', perspective: arg }
            : verb === 'compromise'
              ? { action: 'compromise' }
              : verb === 'wait'
                ? { action: 'keep-waiting' }
                : verb === 'dismiss' && arg
                  ? { action: 'dismiss', login: arg }
                  : verb === 'ack'
                    ? { action: 'acknowledge' }
                    : verb === 'end'
                      ? { action: 'end' }
                      : undefined
    if (decision === undefined) {
      return { text: 'Usage: /foundry [status | approve | changes | veto <reviewer> | compromise | wait | dismiss <bot> | ack | end | sync | pane] [#lead]' }
    }

    const key = batchKey(batch)
    const now = await $.clock.now()
    const result = await apply($, key, b => decide(b, decision, now))
    if (result?.error) return { text: result.error }
    // A command may not submit a prompt while it holds the command: its notes ride as context instead.
    const notes = result?.batch ? await undelivered($, result.batch) : []
    if (decision.action === 'end') await releaseIfMine($, key)
    await afterShipDecision($, decision)

    return notes.length > 0 ? { text: `Done: ${decision.action}.`, context: notes } : { text: `Done: ${decision.action}.` }
  })

  // -------------------------------------------------------------------------
  // The panel: one card per batch, moving down the stages.

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown, Link } = $.ui.resolve(e)
    const batches = await read($, batchesAtom)
    const meta = await read($, metaAtom)

    if (batches.length === 0) {
      return (
        <Box flexDirection="column">
          <Text bold>No Foundry batches</Text>
          <Text dimColor>Start one with /foundry:begin. Open batches in this repository appear here, whichever session runs them.</Text>
        </Box>
      )
    }

    const sorted = [...batches].sort(
      (a, b) => Number(batchKey(b) === meta.mine) - Number(batchKey(a) === meta.mine) || a.lead - b.lead,
    )

    return (
      <Box flexDirection="column">
        {sorted.map(batch => {
          const key = batchKey(batch)
          const id = `${batch.lead}`
          const at = trackIndex(batch)
          const waiting = batch.waiting
          const error = meta.errors[key]
          const ship = batch.ship

          return (
            <Box
              key={`card-${id}`}
              flexDirection="column"
              borderStyle="round"
              borderColor={waiting ? 'warning' : 'subtle'}
              paddingX={1}
              marginBottom={1}
            >
              <Text bold>{batch.title}</Text>
              <Text dimColor>
                {batch.issues.map(n => `#${n}`).join(' ')} · {meta.mine === key ? 'this session' : 'another session'}
              </Text>
              <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
                {TRACK.map((step, i) => (
                  <Text color={i === at ? 'claude' : i < at ? 'success' : 'subtle'} bold={i === at}>
                    {i < at ? '✓' : i === at ? '▶' : '·'} {step}
                  </Text>
                ))}
              </Box>
              {batch.stage !== 'done' && (
                <Text dimColor>
                  Round {currentRound(batch)} of {batch.maxRounds}
                </Text>
              )}

              {isLoopStage(batch.stage) && (
                <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
                  {perspectiveStates(batch).map(p => (
                    <Text color={p.isVetoed || !p.latest ? 'subtle' : VERDICT_COLOR[p.latest.verdict]}>
                      {p.isVetoed ? '⊘' : p.latest ? VERDICT_MARK[p.latest.verdict] : '○'} {p.perspective}
                    </Text>
                  ))}
                  {extraReviews(batch).map(r => (
                    <Text dimColor>
                      {VERDICT_MARK[r.verdict]} {r.perspective} (extra)
                    </Text>
                  ))}
                </Box>
              )}

              <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
                <Text color={LIGHT_COLOR[batch.tests?.light ?? 'none']}>{LIGHT_MARK[batch.tests?.light ?? 'none']} Tests</Text>
                <Text color={LIGHT_COLOR[ship?.ci ?? 'none']}>{LIGHT_MARK[ship?.ci ?? 'none']} CI</Text>
                {(ship?.bots ?? []).map(bot => {
                  const isGood = bot.light === 'reviewed' || bot.light === 'dismissed'
                  const isBad = bot.light === 'changes' || bot.light === 'timeout'

                  return (
                    <Text color={isGood ? 'success' : isBad ? 'error' : 'warning'}>
                      {isGood ? '✓' : bot.light === 'changes' ? '✗' : '…'} {bot.login} <Text dimColor>{bot.light}</Text>
                    </Text>
                  )
                })}
                {ship !== undefined && ship.openThreads > 0 && <Text color="error">{ship.openThreads} open threads</Text>}
              </Box>
              {ship !== undefined && <Link href={ship.url} label={`Pull request #${ship.pr}`} />}
              {ship !== undefined && ship.checks.some(c => c.light === 'fail') && (
                <Text color="error">
                  Failing: {ship.checks.filter(c => c.light === 'fail').map(c => c.name).join(', ')}
                </Text>
              )}

              {waiting !== undefined && (
                <Box flexDirection="column" borderStyle="bold" borderColor="warning" paddingX={1} marginTop={1}>
                  <Text bold color="warning">
                    ⚠ Waiting on you: {WAIT_LABEL[waiting.kind]}
                  </Text>
                  <Markdown text={waiting.summary} />
                  <Box flexDirection="row" flexWrap="wrap" gap={1}>
                    {choices(batch).flatMap(action => {
                      switch (action) {
                        case 'approve':
                          return [
                            <Button key={`${id}-approve`} label="Approve" variant="primary" onPress={() => pressDecide($, key, { action: 'approve' })} />,
                          ]
                        case 'changes': {
                          const label = waiting.kind === 'signoff' ? 'Request changes' : batch.stage === 'ship' ? 'Send back anyway' : 'Another round'

                          return [<Button key={`${id}-changes`} label={label} onPress={() => pressDecide($, key, { action: 'changes' })} />]
                        }
                        case 'veto':
                          return (waiting.perspectives ?? []).map(p => (
                            <Button key={`${id}-veto-${p}`} label={`Veto ${p}`} onPress={() => pressDecide($, key, { action: 'veto', perspective: p })} />
                          ))
                        case 'compromise':
                          return [
                            <Button key={`${id}-compromise`} label="I'll write a compromise" onPress={() => pressDecide($, key, { action: 'compromise' })} />,
                          ]
                        case 'keep-waiting':
                          return [<Button key={`${id}-wait`} label="Keep waiting" onPress={() => pressDecide($, key, { action: 'keep-waiting' })} />]
                        case 'dismiss':
                          return (waiting.bots ?? []).map(bot => (
                            <Button key={`${id}-dismiss-${bot}`} label={`Dismiss ${bot}`} onPress={() => pressDecide($, key, { action: 'dismiss', login: bot })} />
                          ))
                        case 'acknowledge':
                          return [<Button key={`${id}-ack`} label="OK" onPress={() => pressDecide($, key, { action: 'acknowledge' })} />]
                        case 'end':
                          return [<Button key={`${id}-end-now`} label="End batch" onPress={() => pressDecide($, key, { action: 'end' })} />]
                        default:
                          return []
                      }
                    })}
                  </Box>
                </Box>
              )}

              {error !== undefined && <Text color="error">GitHub: {error}</Text>}
              <Box flexDirection="row" marginTop={1}>
                {batch.stage === 'done' ? (
                  <Button key={`${id}-clear`} label="Clear" plain onPress={() => clearCard($, key)} />
                ) : (
                  <Button key={`${id}-end`} label="End batch" plain onPress={() => pressDecide($, key, { action: 'end' })} />
                )}
              </Box>
            </Box>
          )
        })}
      </Box>
    )
  })
}

// A batch that guards nothing, so the merge rule can be asked with no batch running.
const DONE: Batch = {
  repo: '',
  lead: 0,
  title: '',
  issues: [],
  stage: 'done',
  rounds: { plan: 1, build: 1, ship: 1 },
  epoch: 0,
  vetoes: [],
  reviews: [],
  log: [],
  reviewers: [],
  maxRounds: DEFAULT_MAX_ROUNDS,
  onlineReviewers: [],
  botTimeoutMinutes: DEFAULT_BOT_TIMEOUT_MINUTES,
  owner: '',
  rev: 0,
  startedAt: 0,
}
