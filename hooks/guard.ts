// What the agent's tool calls would do that a Foundry stage holds back, and
// the state only the mod may write. A guard rail for an agent following the
// skills: the agent still holds the person's GitHub token, so GitHub itself
// would accept what these rules refuse.

import type { Batch } from '../types'
import { WAIT_LABEL } from './model'

/** An outward step a stage holds back. */
export type Action = 'commit' | 'claim' | 'push' | 'open-pr' | 'merge'

const ACTION_WORDS: Record<Action, string> = {
  commit: 'commit',
  claim: 'claim issues',
  push: 'push',
  'open-pr': 'open a pull request',
  merge: 'merge',
}

// Words that run the command after them, so `sudo git push` is still a push.
const WRAPPERS = new Set(['sudo', 'env', 'command', 'exec', 'time', 'nohup', 'nice'])
// git's global options that take a separate value (`git -C dir push`).
const GIT_VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'])
// gh's global options that take a separate value (`gh -R o/r pr create`).
const GH_VALUED = new Set(['-R', '--repo', '--hostname'])

function words(segment: string): string[] {
  return segment
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(word => word.replace(/^['"]|['"]$/g, ''))
}

function program(tokens: string[]): number {
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i] ?? ''
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || WRAPPERS.has(token)) {
      i += 1
      continue
    }
    break
  }

  return i
}

function afterOptions(tokens: string[], start: number, valued: Set<string>): number {
  let i = start
  while (i < tokens.length) {
    const token = tokens[i] ?? ''
    if (!token.startsWith('-')) break
    i += valued.has(token) ? 2 : 1
  }

  return i
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function segments(command: string): string[][] {
  return command.split(/&&|\|\||[;|\n&]|\$\(|`|[()]/).map(words)
}

function segmentActions(tokens: string[]): Action[] {
  const at = program(tokens)
  const name = baseName(tokens[at] ?? '')

  if (name === 'git') {
    const sub = tokens[afterOptions(tokens, at + 1, GIT_VALUED)]
    if (sub === 'commit') return ['commit']
    if (sub === 'push') return ['push']

    return []
  }

  if (name === 'gh') {
    const i = afterOptions(tokens, at + 1, GH_VALUED)
    const noun = tokens[i]
    const verb = tokens[i + 1]
    const rest = tokens.slice(i + 2)
    if (noun === 'pr' && verb === 'create') return ['open-pr']
    if (noun === 'pr' && verb === 'merge') return ['merge']
    if (noun === 'issue' && verb === 'edit' && rest.some(t => t.startsWith('--add-assignee'))) return ['claim']
    if (noun === 'api' && tokens.some(t => /\/pulls\/\d+\/merge\b/.test(t))) return ['merge']

    return []
  }

  return []
}

/**
 * The guarded actions a Bash command takes, best effort: it splits on the
 * shell's separators and reads each command's program and subcommand. Quoted
 * text never starts a command, so `echo "git push"` is not a push.
 */
export function bashActions(command: string): Action[] {
  const found = new Set<Action>()
  for (const tokens of segments(command)) for (const action of segmentActions(tokens)) found.add(action)

  return [...found]
}

/** Which actions each stage allows, while nothing waits on the person. */
const ALLOWED: Record<Batch['stage'], ReadonlySet<Action>> = {
  plan: new Set(),
  build: new Set(['commit', 'claim']),
  ship: new Set(['claim', 'push', 'open-pr']),
  done: new Set(['commit', 'claim', 'push', 'open-pr']),
}

const NEXT_STEP: Record<Batch['stage'], string> = {
  plan: 'Finish the plan loop (every reviewer approves), then call mcp__foundry__signoff_request and end your turn.',
  build: 'Pushing and the pull request come after the build sign-off: finish the build loop and call mcp__foundry__signoff_request.',
  ship: 'To change the code, call mcp__foundry__send_back first: fixes happen in the build loop.',
  done: '',
}

/** Why `action` is refused now, or undefined when the batch allows it. */
export function refusal(batch: Batch, action: Action): string | undefined {
  if (action === 'merge') return 'Foundry: the person merges, not the agent. Tell them the pull request is ready and stop.'
  if (batch.stage === 'done') return undefined
  if (batch.waiting !== undefined && batch.waiting.kind !== 'merge') {
    return `Foundry: "${batch.title}" is waiting on the person (${WAIT_LABEL[batch.waiting.kind]}), so you cannot ${ACTION_WORDS[action]} now. End your turn.`
  }
  if (ALLOWED[batch.stage].has(action)) return undefined

  return `Foundry: "${batch.title}" is in the ${batch.stage} stage, so you cannot ${ACTION_WORDS[action]} yet. ${NEXT_STEP[batch.stage]}`
}

// ---------------------------------------------------------------------------
// File edits.

function normal(path: string): string {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }

  return `/${parts.join('/')}`
}

export function isInside(root: string, path: string): boolean {
  const base = normal(root)
  const file = normal(path)

  return file === base || file.startsWith(`${base}/`)
}

/**
 * Whether a stage holds back an edit of `path`: anything inside the
 * repository, except its `.claude/` folders (plans, local settings). Paths
 * outside it, such as a scratchpad, are never held.
 */
export function isGuardedPath(root: string, path: string): boolean {
  if (!path.startsWith('/')) return true
  if (!isInside(root, path)) return false

  return !normal(path).slice(normal(root).length).split('/').includes('.claude')
}

export function editRefusal(batch: Batch, root: string, path: string): string | undefined {
  if (batch.stage === 'done' || !isGuardedPath(root, path)) return undefined
  if (batch.waiting !== undefined && batch.waiting.kind !== 'merge') {
    return `Foundry: "${batch.title}" is waiting on the person (${WAIT_LABEL[batch.waiting.kind]}); files in the repository stay unchanged until they decide.`
  }
  if (batch.stage === 'build') return undefined
  if (batch.stage === 'plan') {
    return `Foundry: "${batch.title}" has no approved plan yet, so files in the repository stay unchanged. Notes outside it, or under its .claude/ folder, are fine.`
  }

  return `Foundry: "${batch.title}" is shipping. To change code, call mcp__foundry__send_back first: fixes happen in the build loop.`
}

// ---------------------------------------------------------------------------
// The state only the mod writes: the `foundry` labels and the state comment.
// Review threads are the agent's to reply to and resolve; the ship gate
// keeps an online reviewer's resolved thread blocking until it re-reviews.

export const STATE_MARKER = '<!-- foundry:state -->'

const PROTECTED: { pattern: RegExp; what: string }[] = [
  { pattern: /foundry:state/i, what: "Foundry's state comment" },
  { pattern: /foundry(?::|%3a)(plan|build|ship|waiting)\b/i, what: "Foundry's stage labels" },
  // The `foundry` label itself, however it is named: a flag, a REST path, a JSON body, `gh label`.
  { pattern: /--(?:add-|remove-)?labels?(?:=|\s+)['"]?[^\s'"]*\bfoundry\b/i, what: "Foundry's labels" },
  { pattern: /\/labels\/foundry\b/i, what: "Foundry's labels" },
  { pattern: /\blabels?(?:\[\])?["']?\s*[:=]\s*\[?[^\]\n]{0,80}\bfoundry\b/i, what: "Foundry's labels" },
  { pattern: /\blabel\s+(?:create|edit|delete|clone)\s+['"]?foundry\b/i, what: "Foundry's labels" },
]

/** Whether a command writes somewhere: a gh write, curl with a body or method, or inline code. */
function isWriting(command: string): boolean {
  for (const tokens of segments(command)) {
    const at = program(tokens)
    const name = baseName(tokens[at] ?? '')
    const rest = tokens.slice(at + 1)
    if (name === 'gh') {
      const i = afterOptions(tokens, at + 1, GH_VALUED)
      const noun = tokens[i]
      const verb = tokens[i + 1] ?? ''
      if (noun === 'label') return true
      if ((noun === 'issue' || noun === 'pr') && ['edit', 'comment', 'close', 'reopen', 'delete'].includes(verb)) return true
      if (noun === 'api') {
        const isWrite = rest.some((t, j) => /^(-X|--method)$/.test(t) && !/^GET$/i.test(rest[j + 1] ?? '')) ||
          rest.some(t => /^(-f|-F|--field|--raw-field|--input)$/.test(t) || /^(--method=|-X)(?!GET\b)\w+/i.test(t))
        if (isWrite || tokens.some(t => /graphql/.test(t))) return true
      }
    }
    if (name === 'curl' || name === 'wget' || name === 'http' || name === 'https' || name === 'xh') {
      if (
        rest.some(
          t =>
            /^(-X|--request|-d|--data.*|-F|--form|--json|-T|--upload-file|--post-data|--method)$/.test(t) ||
            /^--(data|json|form|request)=/.test(t) ||
            // The method attached to its flag (`-XDELETE`), and a body attached to `-d` (`-d@file`).
            /^-X(?!GET\b)\w+/i.test(t) ||
            /^-d./.test(t),
        )
      ) {
        return true
      }
    }
    if (/^(python[0-9.]*|node|deno|bun|ruby|perl|php|bash|sh|zsh|osascript)$/.test(name)) {
      if (rest.some(t => /^(-c|-e|--eval|-)$/.test(t)) || rest.length === 0) return true
    }
  }

  return false
}

// A whole issue's labels, replaced (PUT) or cleared (DELETE): that drops Foundry's labels without naming them.
const BULK_LABELS = /issues\/(\d+)\/labels(?![/\w%])/gi
// The method as a shell flag (`-X DELETE`, `-XPUT`, `--method=PUT`), as list items in a script
// (`"-X", "DELETE"`), or as a client call or option (`requests.put`, `method: 'DELETE'`).
const REPLACING =
  /(?:^|[^\w-])(?:-X|--method|--request)['"]?\s*[,=]?\s*['"]?(?:PUT|DELETE)\b|\b(?:requests|axios|http)\.(?:put|delete)\b|method\s*[:=]\s*['"](?:PUT|DELETE)['"]/i

function protectedThing(text: string, commentIds: number[], tracked: number[]): string | undefined {
  for (const { pattern, what } of PROTECTED) if (pattern.test(text)) return what
  for (const id of commentIds) {
    if (new RegExp(`comments/${id}\\b`).test(text)) return "Foundry's state comment"
  }
  if (REPLACING.test(text)) {
    for (const match of text.matchAll(BULK_LABELS)) {
      if (tracked.includes(Number(match[1]))) return "Foundry's labels (replacing or clearing every label of a tracked issue)"
    }
  }

  return undefined
}

/**
 * Why a Bash command is refused for touching what only the mod writes.
 * `tracked` lists the issues and pull requests of the open batches.
 */
export function stateRefusal(command: string, commentIds: number[], tracked: number[] = []): string | undefined {
  if (!isWriting(command)) return undefined
  const what = protectedThing(command, commentIds, tracked)
  if (what === undefined) return undefined

  return `Foundry: only the Foundry mod changes ${what}. Use the mcp__foundry__ tools; the person decides gates in the Foundry pane.`
}

const SCRIPT = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|mts|rb|pl|php|ps1)$/i

/** Why writing a script is refused: a script could touch the protected state where the Bash guard cannot see. */
export function scriptRefusal(
  path: string,
  content: string,
  commentIds: number[],
  pluginRoot: string,
  tracked: number[] = [],
): string | undefined {
  if (!SCRIPT.test(path) || isInside(pluginRoot, path)) return undefined
  const what = protectedThing(content, commentIds, tracked)
  if (what === undefined) return undefined

  return `Foundry: that script would change ${what}, which only the Foundry mod writes. Use the mcp__foundry__ tools.`
}

// ---------------------------------------------------------------------------
// Files a shell command writes, best effort, so the stages that hold edits
// hold them from Bash too.

const QUOTED = /'([^']*)'|"((?:[^"\\]|\\.)*)"/g
// `> file`, `>> file`, `1> file`, `&> file`, the file quoted or not; never `2>&1`.
// Quoted text is set aside as numbered placeholders first, so a `>` inside a
// string is no redirection while a quoted target still is one.
const REDIRECT = /(?:^|[^<>&\d])(?:\d|&)?>>?(?!&)\s*(\u0000\d+\u0000|[^\s;&|<>()\u0000]+)/g
const WRITES_ARGS = new Set(['tee', 'touch', 'rm', 'rmdir', 'truncate', 'mkdir', 'unlink'])
const WRITES_LAST = new Set(['cp', 'mv', 'install', 'ln', 'rsync'])

/**
 * The paths a command writes or removes: redirections, `tee`, `touch`, `rm`,
 * `truncate`, `mkdir`, the destination of `cp`, `mv`, `install`, `ln` and
 * `rsync`, and the file `sed -i` or `perl -i` edits in place. A write a
 * script or a program makes on its own is beyond it.
 */
export function shellWriteTargets(command: string): string[] {
  const targets: string[] = []
  const quoted: string[] = []
  const bare = command.replace(QUOTED, (_, single?: string, double?: string) => {
    quoted.push(single ?? double ?? '')

    return `\u0000${quoted.length - 1}\u0000`
  })
  for (const match of bare.matchAll(REDIRECT)) {
    const target = match[1] ?? ''
    const placeholder = /^\u0000(\d+)\u0000$/.exec(target)
    targets.push(placeholder ? (quoted[Number(placeholder[1])] ?? '') : target)
  }

  for (const tokens of segments(command)) {
    const at = program(tokens)
    const name = baseName(tokens[at] ?? '')
    const args = tokens.slice(at + 1).filter(t => !t.startsWith('-'))
    if (WRITES_ARGS.has(name)) targets.push(...args)
    if (WRITES_LAST.has(name) && args.length >= 2) targets.push(args[args.length - 1] ?? '')
    const inPlace = tokens.slice(at + 1).some(t => /^-[a-zA-Z]*i/.test(t) || t === '--in-place')
    if ((name === 'sed' || name === 'perl') && inPlace && args.length >= 2) targets.push(args[args.length - 1] ?? '')
  }

  return [...new Set(targets.filter(t => t && !t.startsWith('/dev/') && !t.startsWith('&')))]
}

/** A shell target as an absolute path: relative ones are read from the session's folder; `~` is outside any repository. */
export function absoluteTarget(target: string, cwd: string): string | undefined {
  if (target.startsWith('~') || target.startsWith('$')) return undefined

  return target.startsWith('/') ? target : `${cwd}/${target}`
}
