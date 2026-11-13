// A repository's foundry.yaml: per-project settings, read from the default
// branch only, so a pull request cannot change the rules it is judged by.
// Free of `$`, so tests check it directly.

import type { DocFolders } from '../types'
import type { Settings } from './model'
import { parseLogins, parseReviewers } from './model'

export const CONFIG_FILE = 'foundry.yaml'

/** What foundry.yaml may set. Each field it leaves out falls back to the plugin's settings. */
export type RepoConfig = {
  reviewers?: string[]
  maxRounds?: number
  onlineReviewers?: string[]
  maintainers?: string[]
  botTimeoutMinutes?: number
  docs?: Partial<DocFolders>
}

type Value = string | number | boolean | string[]

const KEYS: Record<string, keyof RepoConfig> = {
  reviewers: 'reviewers',
  max_rounds: 'maxRounds',
  online_reviewers: 'onlineReviewers',
  maintainers: 'maintainers',
  bot_timeout_minutes: 'botTimeoutMinutes',
}

/** The doc folder keys, each a list of paths relative to the repository root. */
const DOC_KEYS: Record<string, keyof DocFolders> = {
  requirements: 'requirements',
  specifications: 'specifications',
  decisions: 'decisions',
  user_docs: 'user',
}

/** A doc path inside the repository, without a leading `./` or a trailing `/`; undefined for one that leaves it. */
export function docPath(path: string): string | undefined {
  // `.` segments are dropped, so `./docs/./adr` is `docs/adr`; what is left must name something below the root.
  const parts = path
    .trim()
    .split('/')
    .filter(part => part !== '' && part !== '.')
  if (path.trim().startsWith('/') || path.trim().startsWith('~') || parts.includes('..')) return undefined
  // The root itself is no doc folder: as one, the plan stage would open the whole repository to edits.
  if (parts.length === 0) return undefined

  return parts.join('/')
}

function stripComment(line: string): string {
  let quote: string | undefined
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === quote) quote = undefined
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1] ?? ''))) {
      return line.slice(0, i)
    }
  }

  return line
}

function scalar(text: string): string | number | boolean {
  const t = text.trim()
  if (/^(['"]).*\1$/.test(t)) return t.slice(1, -1)
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
  if (/^(true|false)$/i.test(t)) return t.toLowerCase() === 'true'

  return t
}

/**
 * Reads the YAML subset foundry.yaml uses: top-level `key: value` pairs,
 * where a value is a scalar, a flow list (`[a, b]`) or a block list of
 * `- item` lines, with `#` comments. Anything else is reported, not guessed.
 */
export function parseYaml(text: string): { values: Record<string, Value>; problems: string[] } {
  const values: Record<string, Value> = {}
  const problems: string[] = []
  let listKey: string | undefined

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = stripComment(raw).replace(/\s+$/, '')
    if (line.trim() === '' || line.trim() === '---') return
    const where = `line ${index + 1}`

    const item = /^\s+-\s+(.*)$/.exec(line) ?? /^-\s+(.*)$/.exec(line)
    if (item) {
      const list = listKey === undefined ? undefined : values[listKey]
      if (!Array.isArray(list)) {
        problems.push(`${where}: a list item with no key above it`)

        return
      }
      list.push(String(scalar(item[1] ?? '')))

      return
    }

    const pair = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (!pair || /^\s/.test(line)) {
      problems.push(`${where}: not a top-level "key: value" line`)
      listKey = undefined

      return
    }
    const key = pair[1] ?? ''
    const rest = (pair[2] ?? '').trim()
    if (key in values) problems.push(`${where}: "${key}" is set twice; the later one wins`)
    if (rest === '') {
      values[key] = []
      listKey = key
    } else if (rest.startsWith('[')) {
      if (!rest.endsWith(']')) problems.push(`${where}: a "[" list must close on the same line`)
      const inner = rest.replace(/^\[/, '').replace(/\]$/, '').trim()
      values[key] = inner === '' ? [] : inner.split(',').map(part => String(scalar(part)))
      listKey = undefined
    } else {
      values[key] = scalar(rest)
      listKey = undefined
    }
  })

  return { values, problems }
}

function asList(value: Value | undefined): string[] | undefined {
  if (value === undefined) return undefined
  if (Array.isArray(value)) return value
  if (typeof value === 'string') return value.split(',').map(s => s.trim()).filter(Boolean)

  return undefined
}

/** foundry.yaml's settings, with a line for each problem: an unknown key, a wrong type, a bad value. */
export function readConfig(text: string): { config: RepoConfig; problems: string[] } {
  const { values, problems } = parseYaml(text)
  const config: RepoConfig = {}

  for (const [key, value] of Object.entries(values)) {
    const kind = DOC_KEYS[key]
    if (kind !== undefined) {
      const list = asList(value)
      if (list === undefined) {
        problems.push(`"${key}" must be a list of folders`)
        continue
      }
      const paths = list.map(docPath)
      const outside = list.filter((_, i) => paths[i] === undefined)
      if (outside.length > 0) {
        problems.push(`"${key}": ${outside.join(', ')} is not a folder or file inside the repository (the root itself is not allowed)`)
      }
      config.docs = { ...config.docs, [kind]: [...new Set(paths.filter((p): p is string => p !== undefined))] }
      continue
    }
    const field = KEYS[key]
    if (field === undefined) {
      problems.push(`unknown setting "${key}" (known: ${[...Object.keys(KEYS), ...Object.keys(DOC_KEYS)].join(', ')})`)
      continue
    }
    if (field === 'maxRounds' || field === 'botTimeoutMinutes') {
      const isWhole = field === 'maxRounds'
      if (typeof value !== 'number' || value <= 0 || (isWhole && !Number.isInteger(value))) {
        problems.push(`"${key}" must be a ${isWhole ? 'whole ' : ''}number above 0`)
        continue
      }
      config[field] = value
      continue
    }
    const list = asList(value)
    if (list === undefined) {
      problems.push(`"${key}" must be a list`)
      continue
    }
    const parsed = field === 'reviewers' ? parseReviewers(list.join(',')) : parseLogins(list.join(','))
    // An empty list of reviewers would let a gate pass with no reviews at all.
    if (field === 'reviewers' && parsed.length === 0) {
      problems.push('"reviewers" is empty; the plugin\'s reviewers apply')
      continue
    }
    config[field] = parsed
  }

  return { config, problems }
}

/** The settings a batch starts with: foundry.yaml first, then the plugin's settings. */
export function mergeSettings(plugin: Settings, repo: RepoConfig): Settings {
  return {
    reviewers: repo.reviewers ?? plugin.reviewers,
    maxRounds: repo.maxRounds ?? plugin.maxRounds,
    onlineReviewers: repo.onlineReviewers ?? plugin.onlineReviewers,
    maintainers: repo.maintainers ?? plugin.maintainers,
    botTimeoutMinutes: repo.botTimeoutMinutes ?? plugin.botTimeoutMinutes,
    docs: {
      requirements: repo.docs?.requirements ?? plugin.docs.requirements,
      specifications: repo.docs?.specifications ?? plugin.docs.specifications,
      decisions: repo.docs?.decisions ?? plugin.docs.decisions,
      user: repo.docs?.user ?? plugin.docs.user,
    },
  }
}
