# foundry

A Claude plugin and mod that guides agents from GitHub issues to shipped code through gated, multi-perspective review loops.

An **oversight agent** takes a batch of related issues through six stages. **Six specialist reviewers** check the plan, then the work, until every one approves. **Documentation is first-class:** the product owner and architecture write the requirements, specification and decision records before any code, and a documentation reviewer checks that every doc matches what was built. **You** sign off after each loop, and the pull request ships only when its online reviewers pass and CI is green. The **Foundry mod** enforces each stage in Claude Code, keeps the state in GitHub, and shows every batch as a card in a side panel, with a clear alert whenever something waits on you.

## The stages

```
1 Intake ─▶ 2 Plan loop ─▶ 3 Plan sign-off ─▶ 4 Build loop ─▶ 5 Build sign-off ─▶ 6 Ship gates ─▶ merged
            (docs pass,       (you: plan        (6 reviewers,    (you)               (online reviewers
             6 reviewers,      and docs)         until all                             + CI; failures go
             until all                           approve)                              back to 4)
             approve)
```

| Stage | What happens | The mod holds back |
|---|---|---|
| **1. Intake** | Triaged issues from the current milestone, ordered by the project board's **Priority** and **Size**, grouped into batches, one PR each | |
| **2. Plan loop** | The plan, and the docs pass: requirements, specification and decision records. Reviewed together until all six approve | code (only the requirement, specification and decision folders may change), `git commit`, claiming issues |
| **3. Plan sign-off** | You approve the plan and its docs | everything, while you decide |
| **4. Build loop** | Build, test, and update the user docs with the code. Reviewed until all six approve | `git push`, `gh pr create` |
| **5. Build sign-off** | You approve the implementation | everything, while you decide |
| **6. Ship gates** | The PR's online reviewers pass and CI goes green; a failure or change request sends the work back to the build loop | edits and commits until the work is sent back |
| *(always)* | | `gh pr merge`: you merge |

An issue is **triaged** when the board has its Priority and Size set and its Status is the board's first option (Todo).

### The rules

- **Round limit.** The round limit per stage is a setting (default 3). Hitting it escalates to you.
- **Counters reset forward.** The round counter resets when work moves to the next stage.
- **CI failures count.** A CI failure or a change request on the PR counts as a ship round. A plain rerun of a flaky test does not.
- **Conflicts escalate.** When reviewers want things that cannot both hold, it escalates to you: you veto one, which then counts as approved for that stage, or you write a compromise.
- **Sign-off is yours alone.** Sign-offs come only from the panel's buttons or your own `/foundry` command. A GitHub comment never counts as one, even under your account (some reviewer bots post as you). Neither does a message from another session.

## Documentation

A change isn't done until what people read about it is true, so Foundry treats docs as part of the work.

- **The docs pass, in the plan loop, before any code.** The product owner updates the **requirements**: what users can do, and why. Then architecture writes the technical design into the **specification** beside the product owner's section, and adds a **decision record** for each significant choice. Every reviewer reviews the plan and that doc diff together, and your plan sign-off agrees both.
- **Only docs before the sign-off.** In the plan stage the mod lets the requirement, specification and decision folders change, and nothing else. A reviewer agent may edit those folders only while the batch is planning, and never commits, pushes or touches code.
- **Docs with the code, in the build loop.** The first commit is the docs you agreed. User and reference docs, help pages, the README and the changelog change in the same commits as the code they describe. If the code has to differ from the agreed spec, the agent stops and asks you.
- **A documentation reviewer, in both loops.** In the plan loop it checks that the plan names every doc the change touches. In the build loop it checks that each one was updated, matches the code, and that nothing went stale.

## The ship gates

The mod reads the PR every minute and judges it only on facts GitHub records:

- **CI:** every check passes. Codecov's status checks (`codecov/patch`) count as CI. No checks yet, right after a push, counts as pending, not green.
- **Online reviewers:** each one on the allowlist (`online_reviewers` in `foundry.yaml`, else the `onlineReviewers` setting) must review the **head commit**. Reviews and threads from anyone off the allowlist are ignored by the gate and listed for you. A review of an older commit doesn't count. Neither does a busy or rate-limited comment (coderabbit's "Review limit reached", gitar's "Gitar is working").
- **Nothing open:** no review requests changes, and no review thread is unresolved. The agent replies in threads and resolves them once fixed. An online reviewer's resolved thread still blocks until that reviewer has reviewed a commit newer than the one it was raised on, so resolving without a fix clears nothing.
- **Comment-only reviewers:** a bot that leaves only a comment on the head commit, like gitar-bot's summary, waits on you to read it and dismiss it in the panel.
- **Timeouts:** a reviewer silent for `botTimeoutMinutes` (30) after a push escalates to you. You keep waiting or dismiss it for that commit.

When all of it is green, the card says **Ready to merge**. The merge is yours; the mod sees it and closes the batch.

## State in GitHub

Each batch's state is a **state comment** on its lead issue: a readable summary, then the full record as JSON. Every issue and the PR also carry labels: `foundry`, `foundry:plan|build|ship`, and `foundry:waiting` while something waits on you. Another session, or another machine, picks the batch up from there, and the panel shows every open batch in the repository, whichever session runs it.

**Only the mod writes that state.** The guard refuses any agent call that would touch the `foundry` labels or the state comment. That covers `gh` (including `gh api` and GraphQL), `curl` and `wget`, inline `python -c` and `node -e` code, and script files written with Edit or Write. If the comment changes without a newer revision from the mod, or disappears, the mod restores its own copy and the card shows an alert. It reads back only state comments its own GitHub account wrote, naming that repository and lead issue, and it prefers the comment it already knows, so a copy someone else posts, or a second one beside it, is ignored. Labels are added and removed one by one, so labels other people set are left alone. A write that fails (an outage, say) is reported and retried at the next sync, never posted twice.

This is a **guardrail, not a lock.** The agent uses your GitHub token, so GitHub itself would accept the writes the guard refuses, and a determined route around the guard is possible. To make it a lock, the mod could write state through a dedicated GitHub App or bot account that the agent's token can't touch, so every state change also shows who made it.

## The panel

One card per batch, moving down the stages:

- **The track:** Plan ▸ Plan sign-off ▸ Build ▸ Build sign-off ▸ Ship ▸ Done.
- **The round counter.**
- **Status lights for each reviewer:** ✓ ready, ~ revise, ✗ rethink, ○ not reviewed, ⊘ vetoed.
- **Tests and CI lights,** plus each online reviewer and the open threads.
- **A "waiting on you" alert** with the buttons for your decision:

| Alert | Your buttons |
|---|---|
| Sign-off | Approve, Request changes |
| Round limit reached | Approve, Another round, Veto a reviewer (loops); Send back anyway, End batch (ship) |
| Reviewer conflict | Veto a reviewer, I'll write a compromise |
| Online reviewer silent | Keep waiting, Dismiss it |
| Online reviewer comment to read | Dismiss it |
| Ready to merge | (merge on GitHub) |
| State edited outside Foundry | OK |

## Plugin parts

| Part | What it is |
|---|---|
| `foundry:oversight` | The coordinator, run as the session's agent: `claude --agent foundry:oversight`. |
| `/foundry:begin [issues \| milestone \| theme \| dry run]` | Starts the same procedure from any session, including the desktop app. |
| `foundry:product-owner`, `foundry:usability`, `foundry:accessibility`, `foundry:architecture`, `foundry:security`, `foundry:documentation` | The six reviewer sub-agents. Architecture also owns correctness and tests. The product owner and architecture are also the doc authors in the plan loop's docs pass; otherwise every reviewer is read-only. |
| `foundry:reviewer` | A reviewer for any perspective you add to the `reviewers` setting. |
| The mod (`hooks/`) | The panel, the gate logic, the guards, GitHub state and PR polling. |
| `/foundry:review-plan`, `/foundry:review-code` | Stand-alone reviews of a plan or a change, sent to the agent that wrote it. |
| `/foundry:pair-driver`, `/foundry:pair-navigator` | Two-session pair programming on top of the same stages. |
| `/foundry:retro` | Turns leftovers from finished work into well-formed GitHub issues. |

The skills read the project's own rules (`AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`) for its check commands, spec conventions and style.

## The `/foundry` command

```
/foundry status                 this session's batch: stage, round, reviewers, CI
/foundry approve                sign off the plan or the implementation
/foundry changes                send it back for another round
/foundry veto <reviewer>        settle a conflict or a round limit
/foundry compromise             settle a conflict by writing a compromise
/foundry wait | dismiss <bot>   answer a silent or comment-only online reviewer
/foundry ack | end | sync | pane
```

Add `#<lead issue>` to act on another session's batch.

## Install

Foundry needs Claude Code 2.1.321 or later (function-hook mods), the GitHub CLI (`gh`) signed in with access to the repository and its project board, and Python 3 for the intake script.

At the prompt of a terminal session:

```
/plugin install foundry --marketplace brylie/foundry
```

From a shell:

```bash
claude plugin install foundry --marketplace brylie/foundry
```

In the desktop app: click + next to the prompt box, then Plugins, then Add marketplace with `brylie/foundry`, then Add plugin. Then run `/foundry:begin`.

### Options

| Option | Default | Meaning |
|---|---|---|
| `reviewers` | `product-owner,usability,accessibility,architecture,security` | Comma-separated review perspectives. Every one must approve before a sign-off goes to you. An empty list means the defaults. |
| `maxRounds` | `3` | Review rounds per stage before it escalates to you. CI reruns for flaky tests don't count. |
| `onlineReviewers` | `coderabbitai[bot]` | The automated reviewers that must review a PR's head commit. Codecov belongs in CI, as its status check. |
| `maintainers` | *(the signed-in account)* | People whose PR comments count as reviewer feedback, never as sign-off. |
| `botTimeoutMinutes` | `30` | How long to wait for an online reviewer after a push before it escalates to you. |

A batch takes the settings in force when it starts.

### Per repository: `foundry.yaml`

A repository can set its own values in a `foundry.yaml` at its root. Each field it sets wins over the plugin's settings; each it leaves out falls back to them. Foundry reads it from the **default branch only**, never the checkout, so a pull request can't change the rules it's judged by: an edit takes effect once it's merged.

```yaml
online_reviewers:        # must review the head commit; part of the allowlist
  - coderabbitai[bot]
  - gitar-bot[bot]
maintainers: [brylie]    # their comments count as feedback, never sign-off
reviewers: [product-owner, usability, accessibility, architecture, security, documentation]
max_rounds: 3
bot_timeout_minutes: 30
requirements: [docs/product]      # the product owner's
specifications: [docs/design]     # co-authored with architecture
decisions: [docs/adr]             # architecture's decision records
user_docs: [README.md, docs/guide, docs/modules]
```

The doc folders a file leaves out are found in the checkout: `docs/product`, `docs/requirements` or `docs/prd` for requirements; `docs/design` or `docs/specs` for specifications; `docs/adr` or `docs/decisions` for decision records; and the README, changelog and `docs/guide`, `docs/learn`, `docs/modules` and similar for user docs. A kind with no folder yet starts in the first of those.

The file is a small YAML subset: top-level `key: value` lines, `[a, b]` or `- item` lists, and `#` comments. Foundry reports an unknown key or a bad value when a batch starts, rather than guessing what was meant.

**The allowlist** is the online reviewers plus the maintainers. Only their reviews, threads and comments count toward the ship gate, and only theirs reach the agent. Anyone else's comment, however it's worded, neither blocks the gate nor reaches the agent as an instruction. The card lists them as "outside the allowlist" for you to read. This repository's own [`foundry.yaml`](foundry.yaml) is an example.

## Limits

- **Best-effort guards.** The Bash guard reads each command in a chain and sees past `sudo`, `env` and `git -C`. A command built at run time inside a script it can't read is beyond it.
- **No CI means never green.** A repository with no CI checks never goes green; the PR waits on CI.
- **Last write wins.** Two sessions acting on the same batch at the same moment can overwrite each other's change.

## Developing

```bash
claude plugin validate .
claude plugin test .
```

`tests/` covers:
- the stage rules, the guards and the ship gates, as pure functions;
- the whole path from intake to merge, driven through the engine's test kit against a pretend `gh`.

To load a working copy in a session, start it with `claude --plugin-dir <this folder>`.

## License

Apache-2.0
