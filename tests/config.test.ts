import { describe, expect, test } from 'claude-code/testing'

import { mergeSettings, parseYaml, readConfig } from '../hooks/config'

const PLUGIN = {
  reviewers: ['product-owner', 'usability', 'accessibility', 'architecture', 'security'],
  maxRounds: 3,
  onlineReviewers: ['coderabbitai'],
  maintainers: [],
 
  docs: { requirements: ['docs/product'], specifications: [], decisions: [], user: [] },
}

describe('foundry.yaml', () => {
  test('reads scalars, flow lists, block lists and comments', async () => {
    const { values, problems } = parseYaml(`# Foundry for this repository
max_rounds: 2   # tighter here
reviewers: [architecture, security]
online_reviewers:
  - coderabbitai[bot]
  - "gitar-bot[bot]"
maintainers:
  - brylie
bot_timeout_minutes: 45
`)
    expect(problems).toEqual([])
    expect(values).toEqual({
      max_rounds: 2,
      reviewers: ['architecture', 'security'],
      online_reviewers: ['coderabbitai[bot]', 'gitar-bot[bot]'],
      maintainers: ['brylie'],
      bot_timeout_minutes: 45,
    })
  })

  test('its settings win over the plugin’s, field by field', async () => {
    const { config, problems } = readConfig('online_reviewers: [CodeRabbitAI[bot], gitar-bot]\nmaintainers: [Brylie]\n')
    expect(problems).toEqual([])
    const merged = mergeSettings(PLUGIN, config)
    expect(merged.onlineReviewers).toEqual(['coderabbitai', 'gitar-bot'])
    expect(merged.maintainers).toEqual(['brylie'])
    expect(merged.reviewers).toEqual(PLUGIN.reviewers)
    expect(merged.maxRounds).toBe(3)
  })

  test('doc folders are set per kind, inside the repository only', async () => {
    const { config, problems } = readConfig('requirements: [docs/prd/]\nspecifications:\n  - ./docs/specs\n  - ../elsewhere\ndecisions: [docs/adr]\n')
    expect(problems).toEqual(['"specifications": ../elsewhere is not a folder or file inside the repository (the root itself is not allowed)'])
    const merged = mergeSettings(PLUGIN, config)
    expect(merged.docs).toEqual({ requirements: ['docs/prd'], specifications: ['docs/specs'], decisions: ['docs/adr'], user: [] })
  })

  test('spacing around colons and dashes is free, and trailing space is dropped', async () => {
    const { values, problems } = parseYaml('max_rounds :2  \nreviewers:\n-   security\t\n    -\tarchitecture\n')
    expect(problems).toEqual([])
    expect(values).toEqual({ max_rounds: 2, reviewers: ['security', 'architecture'] })
  })

  test('a setting Foundry no longer reads is named as such, and changes nothing', async () => {
    const { config, problems } = readConfig('bot_timeout_minutes: 45\nmax_rounds: 2\n')
    expect(config).toEqual({ maxRounds: 2 })
    expect(problems).toEqual(['"bot_timeout_minutes" is no longer used: Foundry no longer waits on the online reviewers, so it has no timeout. You can remove it.'])
  })

  test("the README's example reads as written", async () => {
    const { config, problems } = readConfig('online_reviewers: [coderabbitai[bot]]\nmaintainers: [your-github-login]\nmax_rounds: 3\n')
    expect(problems).toEqual([])
    expect(config).toEqual({ onlineReviewers: ['coderabbitai'], maintainers: ['your-github-login'], maxRounds: 3 })
  })

  test('the repository root is no doc folder, however it is spelled', async () => {
    const { config, problems } = readConfig('requirements: [., ./, ././]\ndecisions: [./docs/./adr]\n')
    expect(problems).toEqual(['"requirements": ., ./, ././ is not a folder or file inside the repository (the root itself is not allowed)'])
    expect(config.docs).toEqual({ requirements: [], decisions: ['docs/adr'] })
  })

  test('mistakes are reported, not guessed, and never weaken the rules', async () => {
    const { config, problems } = readConfig('max_round: 3\nmax_rounds: zero\nreviewers: []\n  indented: x\n- stray\n')
    expect(config).toEqual({})
    expect(problems.join('\n')).toContain('unknown setting "max_round"')
    expect(problems.join('\n')).toContain('"max_rounds" must be a whole number above 0')
    expect(problems.join('\n')).toContain('"reviewers" is empty')
    expect(problems.join('\n')).toContain('not a top-level')
    expect(problems.join('\n')).toContain('list item with no key')
  })
})
