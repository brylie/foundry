import { describe, expect, test } from 'claude-code/testing'

import type { Batch } from '../types'
import {
  absoluteTarget,
  bashActions,
  editRefusal,
  isGuardedPath,
  isReviewerAgent,
  refusal,
  reviewerEditRefusal,
  scriptRefusal,
  shellWriteTargets,
  stateRefusal,
} from '../hooks/guard'
import { newBatch } from '../hooks/model'

const DOCS = { requirements: ['docs/product'], specifications: ['docs/design'], decisions: ['docs/adr'], user: ['README.md'] }
const SETTINGS = { reviewers: ['security'], maxRounds: 3, onlineReviewers: [], maintainers: [], botTimeoutMinutes: 30, docs: DOCS }
const plan = newBatch({ repo: 'o/r', title: 'T', issues: [1], owner: 's' }, SETTINGS, 0)
const at = (stage: Batch['stage'], extra: Partial<Batch> = {}): Batch => ({ ...plan, stage, ...extra })

describe('commands', () => {
  test('finds the guarded git and gh steps', async () => {
    expect(bashActions('git commit -m "Fix it (#12)"')).toEqual(['commit'])
    expect(bashActions('git -C /repo push -u origin HEAD')).toEqual(['push'])
    expect(bashActions('gh pr create --title t --body-file b.md')).toEqual(['open-pr'])
    expect(bashActions('gh -R o/r pr merge 5 --squash')).toEqual(['merge'])
    expect(bashActions('gh issue edit 7 --add-assignee @me')).toEqual(['claim'])
    expect(bashActions('gh api -X PUT repos/o/r/pulls/5/merge')).toEqual(['merge'])
    expect(bashActions('npm test && GIT_AUTHOR_NAME=x git commit -am wip; sudo git push')).toEqual(['commit', 'push'])
    expect(bashActions('echo "git push" && git status && gh run rerun 9 --failed')).toEqual([])
  })

  test('each stage allows only its own steps', async () => {
    expect(refusal(at('plan'), 'commit')).toContain('plan stage')
    expect(refusal(at('plan'), 'claim')).toContain('plan stage')
    expect(refusal(at('build'), 'commit')).toBeUndefined()
    expect(refusal(at('build'), 'push')).toContain('after the build sign-off')
    expect(refusal(at('ship'), 'push')).toBeUndefined()
    expect(refusal(at('ship'), 'open-pr')).toBeUndefined()
    expect(refusal(at('ship'), 'commit')).toContain('send_back')
    expect(refusal(at('done'), 'merge')).toContain('the person merges')
  })

  test('nothing moves while the person is asked', async () => {
    const waiting = at('build', { waiting: { kind: 'signoff', summary: 's', at: 1 } })
    expect(refusal(waiting, 'commit')).toContain('waiting on the person')
    expect(editRefusal(waiting, '/repo', '/repo/a.ts')).toContain('waiting on the person')
  })
})

describe('shell writes', () => {
  test('finds the files a command writes or removes', async () => {
    expect(shellWriteTargets('printf x > src/a.ts')).toEqual(['src/a.ts'])
    expect(shellWriteTargets('echo hi >> /repo/notes.txt 2>&1')).toEqual(['/repo/notes.txt'])
    expect(shellWriteTargets('npm test 2>/dev/null | tee out.log')).toEqual(['out.log'])
    expect(shellWriteTargets("sed -i '' 's/a/b/' src/x.ts")).toEqual(['src/x.ts'])
    expect(shellWriteTargets('cp -r a b && rm -rf build && touch c')).toEqual(['b', 'build', 'c'])
    expect(shellWriteTargets('echo "a > b" && git status')).toEqual([])
    expect(shellWriteTargets('printf x > "/repo/src/a.ts"')).toEqual(['/repo/src/a.ts'])
    expect(shellWriteTargets("echo 'x > y' >> 'notes with space.md'")).toEqual(['notes with space.md'])
    expect(shellWriteTargets('sed -n 1,5p src/x.ts')).toEqual([])
  })

  test('relative targets are read from the session folder; home is outside any repository', async () => {
    expect(absoluteTarget('src/a.ts', '/repo')).toBe('/repo/src/a.ts')
    expect(absoluteTarget('/tmp/x', '/repo')).toBe('/tmp/x')
    expect(absoluteTarget('~/notes', '/repo')).toBeUndefined()
  })
})

describe('docs first', () => {
  test('the plan loop writes requirements, specifications and decisions, but no code', async () => {
    expect(editRefusal(at('plan'), '/repo', '/repo/docs/product/requirements.md')).toBeUndefined()
    expect(editRefusal(at('plan'), '/repo', '/repo/docs/design/sub-patches.md')).toBeUndefined()
    expect(editRefusal(at('plan'), '/repo', '/repo/docs/adr/0042-slots.md')).toBeUndefined()
    // User docs change with the code, in the build loop.
    expect(editRefusal(at('plan'), '/repo', '/repo/README.md')).toContain('no approved plan')
    expect(editRefusal(at('plan'), '/repo', '/repo/src/slot.rs')).toContain('docs/product, docs/design, docs/adr')
    expect(editRefusal(at('plan'), '/repo', '/repo/docs/productivity.md')).toContain('no approved plan')
  })

  test('a reviewer agent edits only the plan-loop docs, and only while the batch is planning', async () => {
    expect(isReviewerAgent('foundry:product-owner')).toBe(true)
    expect(isReviewerAgent('foundry:oversight')).toBe(false)
    expect(isReviewerAgent('general-purpose')).toBe(false)

    expect(reviewerEditRefusal(at('plan'), '/repo', '/repo/docs/product/requirements.md')).toBeUndefined()
    expect(reviewerEditRefusal(at('plan'), '/repo', '/repo/src/slot.rs')).toContain("doesn't edit the repository")
    expect(reviewerEditRefusal(at('build'), '/repo', '/repo/docs/design/sub-patches.md')).toContain("doesn't edit the repository")
    const signoff = at('plan', { waiting: { kind: 'signoff', summary: 's', at: 1 } })
    expect(reviewerEditRefusal(signoff, '/repo', '/repo/docs/product/requirements.md')).toContain("doesn't edit the repository")
    // Its own notes outside the repository are its own business.
    expect(reviewerEditRefusal(at('build'), '/repo', '/tmp/review-notes.md')).toBeUndefined()
    // A path it can't place is judged as one inside the repository.
    expect(reviewerEditRefusal(at('build'), '/repo', 'src/slot.rs')).toContain("doesn't edit the repository")
  })

  test('$PWD is placed; any other variable, ~ or a substitution is not', async () => {
    expect(absoluteTarget('$PWD/src/a.ts', '/repo')).toBe('/repo/src/a.ts')
    expect(absoluteTarget('${PWD}/src/a.ts', '/repo')).toBe('/repo/src/a.ts')
    expect(absoluteTarget('$OUT/a.ts', '/repo')).toBeUndefined()
    expect(absoluteTarget('~/code/repo/a.ts', '/repo')).toBeUndefined()
    expect(absoluteTarget('$(pwd)/a.ts', '/repo')).toBeUndefined()
  })
})

describe('edits', () => {
  test('the plan and ship stages hold edits inside the repository only', async () => {
    expect(editRefusal(at('plan'), '/repo', '/repo/src/a.ts')).toContain('no approved plan')
    expect(editRefusal(at('plan'), '/repo', '/tmp/scratch/plan.md')).toBeUndefined()
    expect(editRefusal(at('plan'), '/repo', '/repo/.claude/plans/p.md')).toBeUndefined()
    expect(editRefusal(at('build'), '/repo', '/repo/src/a.ts')).toBeUndefined()
    expect(editRefusal(at('ship'), '/repo', '/repo/src/a.ts')).toContain('send_back')
    expect(isGuardedPath('/repo', '/repository/a.ts')).toBe(false)
    expect(isGuardedPath('/repo', '/repo/../elsewhere/a.ts')).toBe(false)
  })
})

describe("the state only the mod writes", () => {
  test('every route to the labels and the state comment is refused', async () => {
    const refused = [
      'gh issue edit 3 --remove-label foundry:plan',
      'gh issue edit 3 --add-label "foundry:build"',
      'gh pr edit 9 --remove-label foundry',
      'gh label delete foundry:waiting --yes',
      'gh api -X DELETE repos/o/r/issues/3/labels/foundry%3Aplan',
      'gh api -X PUT repos/o/r/issues/3/labels --input labels.json -f "labels[]=foundry:ship"',
      'curl -X POST -H "Authorization: token $T" https://api.github.com/repos/o/r/issues/3/labels -d \'{"labels":["foundry:ship"]}\'',
      'gh api -X PATCH repos/o/r/issues/comments/555 -f body=hello',
      "python3 -c 'import subprocess; subprocess.run([\"gh\",\"issue\",\"comment\",\"3\",\"-b\",\"<!-- foundry:state -->\"])'",
      'gh issue comment 3 --body "<!-- foundry:state --> forged"',
    ]
    for (const command of refused) expect(stateRefusal(command, [555])).toContain('only the Foundry mod')
  })

  test('reading them, ordinary labels, and replying to or resolving review threads stay allowed', async () => {
    const allowed = [
      'gh api graphql -f query=\'mutation { resolveReviewThread(input: {threadId: "x"}) { thread { id } } }\'',
      'gh api repos/o/r/pulls/9/comments/77/replies -f body="Fixed in abc123."',
      'gh issue list --label foundry --json number',
      'gh api repos/o/r/issues/3/comments',
      'grep -rn "foundry:state" hooks/',
      'gh issue edit 3 --add-label bug --body "Fix the foundry docs"',
      'gh pr create --title "Foundry: name the ports" --label enhancement',
    ]
    for (const command of allowed) expect(stateRefusal(command, [555])).toBeUndefined()
  })

  test('replacing or clearing every label of a tracked issue is refused, though it names no label', async () => {
    expect(stateRefusal('gh api -X DELETE repos/o/r/issues/3/labels', [], [3])).toContain("Foundry's labels")
    expect(stateRefusal('gh api --method PUT repos/o/r/issues/3/labels --input x.json', [], [3])).toContain("Foundry's labels")
    expect(stateRefusal('curl -X PUT https://api.github.com/repos/o/r/issues/3/labels -d @x.json', [], [3])).toContain("Foundry's labels")
    // An issue in no batch, or adding labels, stays allowed.
    expect(stateRefusal('gh api -X DELETE repos/o/r/issues/4/labels', [], [3])).toBeUndefined()
    expect(stateRefusal('gh api -X POST repos/o/r/issues/3/labels -f "labels[]=bug"', [], [3])).toBeUndefined()
    expect(stateRefusal('gh api -X DELETE repos/o/r/issues/3/labels/bug', [], [3])).toBeUndefined()
    expect(stateRefusal('gh api -XDELETE repos/o/r/issues/3/labels', [], [3])).toContain("Foundry's labels")
    expect(stateRefusal('curl -XDELETE https://api.github.com/repos/o/r/issues/3/labels', [], [3])).toContain("Foundry's labels")
    expect(stateRefusal('curl -XPUT -d@labels.json https://api.github.com/repos/o/r/issues/3/labels', [], [3])).toContain("Foundry's labels")
    expect(stateRefusal('curl -XGET https://api.github.com/repos/o/r/issues/3/labels', [], [3])).toBeUndefined()
  })

  test('a script that passes the method as list items is caught too', async () => {
    const script = 'import subprocess\nsubprocess.run(\n    ["gh", "api", "-X", "DELETE", "repos/o/r/issues/3/labels"],\n    check=True,\n)\n'
    expect(scriptRefusal('/repo/tools/clear.py', script, [], '/plugins/foundry', [3])).toContain("Foundry's labels")
    expect(scriptRefusal('/repo/tools/clear.py', script.replace('"DELETE"', '"GET"'), [], '/plugins/foundry', [3])).toBeUndefined()
    expect(scriptRefusal('/repo/tools/clear.py', script, [], '/plugins/foundry', [4])).toBeUndefined()
  })

  test('a script that would write them is refused, outside the plugin itself', async () => {
    const body = 'subprocess.run(["gh", "issue", "edit", "3", "--remove-label", "foundry:plan"])'
    expect(scriptRefusal('/repo/tools/fix.py', body, [], '/plugins/foundry')).toContain('only the Foundry mod')
    expect(scriptRefusal('/repo/notes.md', body, [], '/plugins/foundry')).toBeUndefined()
    expect(scriptRefusal('/plugins/foundry/hooks/github.ts', body, [], '/plugins/foundry')).toBeUndefined()
  })
})
