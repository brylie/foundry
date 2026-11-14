# Security model

Foundry is a set of **guardrails** for an agent working on your repository under your GitHub account. This page covers what it protects, how, and where its limits are.

- [Where the state lives](#where-the-state-lives)
- [What the guards refuse](#what-the-guards-refuse)
- [Who can decide](#who-can-decide)
- [A guardrail, not a lock](#a-guardrail-not-a-lock)
- [Known limits](#known-limits)

## Where the state lives

Each batch's state lives in GitHub, so another session or another machine can pick the batch up.

- **A state comment** on the batch's lead issue holds a readable summary, then the full record as JSON.
- **Labels** go on every issue and the pull request: `foundry`, then `foundry:plan`, `foundry:build` or `foundry:ship`, and `foundry:waiting` while something waits on you.

The panel shows every open batch in the repository, whichever session runs it.

**Only the mod writes that state**, and it guards its own record:

- **Restores outside edits.** If the comment changes without a newer revision from the mod, or disappears, the mod restores its own copy and the card shows an alert. Only the session that runs the batch does this, and only when GitHub's copy differs from its own. Another session that once wrote the batch, before a takeover or through a press on its card, takes the owner's copy as it is.
- **Reads back only its own records.** A state comment counts only if the mod's own GitHub account wrote it and it names that repository and lead issue. The comment the mod already knows wins, so a copy someone else posts, or a second one beside it, is ignored.
- **Leaves other labels alone.** It adds and removes labels one by one, so labels other people set stay as they are.
- **Never double-posts.** A write that fails, during an outage for example, is reported and retried at the next sync, never posted twice.

## What the guards refuse

Each stage holds back the steps that belong to a later one (see [the stages](how-it-works.md#the-stages)). On top of that:

- **Foundry's state.** Any agent call that would touch the `foundry` labels or the state comment is refused. That covers:
  - `gh`, including `gh api` and GraphQL;
  - `curl` and `wget`;
  - inline `python -c` and `node -e` code;
  - script files written with Edit or Write.
- **Every route to a file.** Edits are judged by their real path, with symbolic links resolved, so a link inside a doc folder can't carry a write into the code. The guard also reads shell writes: redirections, `tee`, `sed -i`, `cp`, `mv` and `rm`.
  - `$PWD` resolves to the session's folder.
  - A target it can't place (another variable, `~`, a command substitution) is held like a write into the repository.
- **Reviewers stay reviewers.** A Foundry reviewer agent may edit only the plan-loop doc folders, and only while the batch is planning. It never commits, pushes or touches code.
- **Merging.** `gh pr merge` is always refused: the merge is yours.

## Who can decide

- **Sign-offs come from you, at your machine.** The panel's buttons, or your own `/foundry` command. A GitHub comment never counts as sign-off, even under your account, and neither does a message from another session, a channel or a plugin.
- **Only the allowlist gives feedback.** The ship gate and the agent take reviews and comments only from the [allowlist](configuration.md#the-allowlist). Anyone else's text is listed for you and never reaches the agent as an instruction.
- **The rules come from the default branch.** `foundry.yaml` is read from the default branch only, so a pull request can't change the rules it is judged by.

## A guardrail, not a lock

The agent uses your GitHub token, so GitHub itself would accept the writes the guard refuses, and a determined route around the guard is possible. The guard stops an agent following its instructions from skipping a stage, approving itself, or editing Foundry's state by mistake. It is not a sandbox against an adversary.

To make the state a lock, the mod could write it through a dedicated GitHub App or bot account that the agent's token can't touch. Then every state change would also show who made it.

## Known limits

- **Best-effort command reading.** The Bash guard reads each command in a chain and sees past `sudo`, `env` and `git -C`. A command built at run time inside a script it can't read is beyond it.
- **No CI means never green.** A repository with no CI checks never goes green; the pull request waits on CI.
- **Last write wins.** Two sessions acting on the same batch at the same moment can overwrite each other's change.
