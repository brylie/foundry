/**
 * A batch's stage. `plan` and `build` are review loops that end in the
 * person's sign-off; `ship` is the pull request's gates (online reviewers
 * and CI); `done` is merged.
 */
export type Stage = 'plan' | 'build' | 'ship' | 'done'

/** The two stages the reviewers loop over. */
export type LoopStage = 'plan' | 'build'

export type Verdict = 'ready' | 'revise' | 'rethink'

/** One reviewer's verdict in a loop stage's round. */
export type Review = {
  stage: LoopStage
  perspective: string
  reviewer: string
  verdict: Verdict
  summary: string
  round: number
  epoch: number
  at: number
}

/** What the person is asked to decide. */
export type WaitKind =
  | 'signoff'
  | 'conflict'
  | 'round-limit'
  | 'bot-timeout'
  | 'bot-comment'
  | 'merge'
  | 'tamper'

export type Waiting = {
  kind: WaitKind
  summary: string
  /** The reviewers in a conflict or at the round limit. */
  perspectives?: string[]
  /** The online reviewers that timed out or left a comment to read. */
  bots?: string[]
  at: number
}

export type Light = 'pass' | 'fail' | 'pending' | 'none'

/** The latest local test run the agent reported. */
export type Tests = { light: Light; command: string; summary: string; at: number }

export type BotLight =
  | 'waiting'
  | 'busy'
  | 'reviewed'
  | 'changes'
  | 'comment'
  | 'dismissed'
  | 'timeout'

/** Where one online reviewer stands on the pull request's head commit. */
export type BotState = { login: string; light: BotLight; detail?: string }

export type Check = { name: string; light: Light }

/** The pull request's gates, as the mod last read them from GitHub. */
export type Ship = {
  pr: number
  url: string
  head: string
  /** When the mod first saw this head commit: the online reviewers' clock starts here. */
  headSeenAt: number
  ci: Light
  checks: Check[]
  bots: BotState[]
  openThreads: number
  isMerged: boolean
  checkedAt: number
  /** `login@head` entries the person dismissed or skipped, each for one head commit. */
  dismissed: string[]
  /** The last ship event the agent was told about, so it is told once. */
  notice?: string
}

/** One line of a batch's history. `isForAgent` lines are delivered to the owning session. */
export type LogEntry = { at: number; text: string; isForAgent?: boolean }

/**
 * A batch: related issues on their way to one pull request. The record
 * lives in GitHub, in one state comment on the lead issue, with labels on
 * every issue and the pull request; the mod alone writes it.
 */
export type Batch = {
  repo: string
  /** The first issue: it holds the state comment and names the batch. */
  lead: number
  title: string
  issues: number[]
  stage: Stage
  /**
   * Each stage's round, from 1. A stage's counter resets when work moves on
   * to the next stage. A send-back from ship to build is a ship round, so the
   * ship counter keeps counting through the build loop it sends work back to.
   */
  rounds: Record<'plan' | 'build' | 'ship', number>
  /**
   * Raised whenever earlier reviews stop counting: a new stage, a send-back,
   * the person asking for changes. Only reviews of the current epoch count.
   */
  epoch: number
  /** Perspectives the person vetoed in the current stage: they count as approved. */
  vetoes: string[]
  waiting?: Waiting
  tests?: Tests
  ship?: Ship
  reviews: Review[]
  log: LogEntry[]
  /** The settings in force when the batch started. */
  reviewers: string[]
  maxRounds: number
  onlineReviewers: string[]
  botTimeoutMinutes: number
  /** The session that runs the batch. */
  owner: string
  /** The state comment's id, once written. */
  commentId?: number
  /** Raised on every write, so an edited comment can be told from a newer one. */
  rev: number
  startedAt: number
}

/** This session's own bookkeeping, never written to GitHub. */
export type Meta = {
  /** The key (`owner/repo#lead`) of the batch this session runs. */
  mine: string | null
  /** The state JSON this session last wrote, per batch, to spot edits made around the mod. */
  written: Record<string, string>
  /** How many log lines of its own batch this session has delivered to the agent. */
  delivered: Record<string, number>
  /** The last error reading or writing GitHub, per batch. */
  errors: Record<string, string>
  syncedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    foundry: { batches: Shaped<Batch[]>; meta: Shaped<Meta> }
  }
}
