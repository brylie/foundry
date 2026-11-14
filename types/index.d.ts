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

/**
 * What the person is asked to decide. `bot-timeout` and `bot-comment` are
 * legacy: 0.2 raised them while it waited on the online reviewers. Nothing
 * raises them now; a record that still has one is cleared when it is read.
 */
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
  at: number
}

export type Light = 'pass' | 'fail' | 'pending' | 'none'

/** The latest local test run the agent reported. */
export type Tests = { light: Light; command: string; summary: string; at: number }

export type Check = { name: string; light: Light }

/** The pull request's gates, as the mod last read them from GitHub. */
export type Ship = {
  pr: number
  url: string
  head: string
  ci: Light
  checks: Check[]
  /** Review threads from the allowlist still open, or resolved but not yet re-reviewed. */
  openThreads: number
  isMerged: boolean
  checkedAt: number
  /** The last ship event the agent was told about, so it is told once. */
  notice?: string
  /** People not on the allowlist who reviewed or commented: shown to the person, never acted on. */
  outsiders: string[]
}

/**
 * One line of a batch's history. `isForAgent` lines are delivered to the
 * owning session. `n` counts from 1 and is never reused, so a delivery
 * cursor survives the log keeping only its last lines.
 */
export type LogEntry = { n: number; at: number; text: string; isForAgent?: boolean }

/**
 * Where a repository keeps each kind of documentation, as paths relative to
 * its root. Requirements, specifications and decisions are written in the
 * plan loop, before any code; user docs change with the code in the build.
 */
export type DocFolders = {
  /** Product requirements: the product owner maintains them. */
  requirements: string[]
  /** Specifications: architecture co-authors them with the product owner. */
  specifications: string[]
  /** Architecture decision records. */
  decisions: string[]
  /** Reference and user docs, the README, the changelog. */
  user: string[]
}

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
  /** The settings in force when the batch started (foundry.yaml first, then the plugin's). */
  reviewers: string[]
  maxRounds: number
  /**
   * The allowlist: the automated reviewers and the maintainers whose reviews,
   * threads and comments count as feedback (never as sign-off). Their change
   * requests and open threads hold the pull request; the gate doesn't wait
   * for them to review. Anyone else's comments are shown to the person and
   * neither block the gate nor reach the agent as instructions.
   */
  onlineReviewers: string[]
  maintainers: string[]
  /** The repository's doc folders: the plan loop may edit requirements, specifications and decisions. */
  docs: DocFolders
  /** The session that runs the batch. */
  owner: string
  /** The state comment's id, once written. */
  commentId?: number
  /**
   * The copy of the plan file on the lead issue, which the mod keeps for
   * reading anywhere: its comment's id and link, and the digest of the plan
   * text it holds, so it is rewritten only when the plan changes.
   */
  planCopy?: { id: number; url: string; digest: string }
  /** Raised on every write, so an edited comment can be told from a newer one. */
  rev: number
  startedAt: number
}

/** This session's own bookkeeping, never written to GitHub. */
export type Meta = {
  /** The key (`owner/repo#lead`) of the batch this session runs. */
  mine: string | null
  /**
   * Per batch, the last state JSON this session and GitHub agreed on: one it
   * wrote, or GitHub's copy it took. Its own copy grows from it, so a change
   * on GitHub at no newer revision is an edit made around the mod, and one at
   * a newer revision is another session's write.
   */
  written: Record<string, string>
  /** The `n` of the last log line of each batch this session delivered to the agent. */
  delivered: Record<string, number>
  /**
   * The last error writing a batch to GitHub. A batch listed here has a
   * write that did not land: the next sync retries it.
   */
  errors: Record<string, string>
  syncedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    /**
     * `plansShown`: the batches whose card shows its plan. `ending`: the batches whose card asks
     * to confirm ending them. Both by key, the panel's own, never written to GitHub.
     */
    foundry: { batches: Shaped<Batch[]>; meta: Shaped<Meta>; plansShown: Shaped<string[]>; ending: Shaped<string[]> }
  }
}
