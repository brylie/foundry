# Changelog

Foundry's notable changes, newest first. Versions follow [Semantic Versioning](https://semver.org/): before 1.0, a minor version can change behaviour.

## Unreleased

- **Decide from your phone.** When a batch starts waiting on you, Foundry asks in a question card as the agent's turn ends, so you can answer wherever you follow the session, the mobile app included, where the panel doesn't show. Words typed under "Other" ask for changes and reach the agent as yours. The agent's messages now name the exact command to type instead, such as `/foundry approve #12`, which already worked over Remote Control. An answer counts only for the wait it was asked about.
- **The plan has a home.** The oversight agent writes each batch's plan to `docs/plans/<lead>.md` and revises it there; the plan stage lets that file change. Each card's **Plan** button shows it, and it's committed with the agreed docs.
- **A change that waits its turn no longer undoes the one before it.** Changes to a batch run one at a time, but each read the batch as it stood when its press, command, tool call or poll began. One that waited behind another's GitHub write could decide on the older copy and save over the newer change: with three reviews recorded at once, the middle one was reported as recorded, then lost. Each change now reads the batch as it stands when its turn comes.
- **No more false "changed outside the mod" alerts.** A sync flagged an outside edit, and wrote its own copy back, in cases where nothing outside had changed:
  - It read the session's own write between the comment and the labels.
  - A session that wrote a batch before it was taken over kept comparing the new owner's state with its own last write, and flagged it after every one of the owner's writes.
  - A session whose write had failed restored its copy over another session's takeover.
  - A session whose writes were failing retried them over another session's takeover.
  - A takeover posted as a new comment, because the old one was gone, read as a moved comment: the session restored its copy, in a second state comment. With writes still failing, the session also kept its own copy after taking the takeover, and restored it at the next sync.

  Now each session compares GitHub with the last copy it and GitHub agreed on, not with its own last write. A change at no newer revision is an outside edit, even one that only renames the owner, and only the session that runs the batch restores it. A change at a newer revision that names another owner is a takeover, and stands. A batch that shows the alert from before keeps it until you acknowledge it.
- **Documentation reorganized.** The README is now a short introduction and quick start. The details moved to guides in `docs/`: [How it works](docs/how-it-works.md), [Configuration](docs/configuration.md), [Reference](docs/reference.md) and [Security model](docs/security.md). A new [CONTRIBUTING.md](CONTRIBUTING.md) covers development.
- **The guard reads long commands in linear time.** A command with a long run of spaces after `-X` could take the label check a minute: two adjacent `\s*` in one pattern backtracked quadratically. The `foundry.yaml` reader had the same pattern, on a file the repository trusts.
- **The guard sees more redirections.** A `>` straight after a word (`echo v42>file`), a descriptor of two digits (`10>file`), `>|` and `<>` each write a file, and the stages that hold edits now hold them too.
- **A failed panel press is shown.** Buttons on a card ran their work without anyone waiting for it, so a failure (GitHub unreachable, say) vanished. It now shows as a toast.
- **Linters.** `npm run check` type-checks, then lints the mod with ESLint (typescript-eslint, regexp and sonarjs rules) and the scripts with ruff. See [CONTRIBUTING.md](CONTRIBUTING.md#checks).
- **Type-checking** no longer includes the connected MCP tools' declarations, which could grow too large for TypeScript in a session with many servers.

## 0.2.0

Documentation is now a first-class part of the loop.

- **Docs pass in the plan loop.** Before any code, the product owner updates the requirements, then architecture co-authors the specification and records decisions. The reviewers review the plan and that doc diff together, and the plan sign-off agrees both.
- **Only docs before the plan sign-off.** In the plan stage, the guard lets the requirement, specification and decision folders change, and nothing else. A Foundry reviewer agent may edit those folders only while the batch is planning, and never commits, pushes or touches code.
- **Documentation reviewer.** `foundry:documentation` joins both loops as a required reviewer. In the plan it checks that every affected doc is covered; in the build, that each was updated and matches the code.
- **Doc folders in `foundry.yaml`:** `requirements`, `specifications`, `decisions` and `user_docs`. The ones a file leaves out are found in the checkout.
- **User docs with the code.** In the build loop, the first commit is the agreed docs, and user docs change in the same commits as the code they describe.

**Changed:** the default reviewers now include `documentation`, so a batch needs six approvals instead of five. To keep five for a repository, set `reviewers` in its `foundry.yaml`.

**Upgrading:** a batch 0.1.0 started still reads, with its stage, reviews and pending decision kept. It has no doc folders, so its plan stage stays closed to doc edits too. A batch started on 0.2.0 finds its folders.

**Guard:**
- Edits are judged by their real path, with symbolic links resolved, so a link inside a doc folder can't carry a write into the code.
- A shell write to `$PWD` is placed in the session's folder. A target the guard can't place, such as another variable, `~` or a command substitution, is held like a write into the repository.

## 0.1.0

The first release.

- **Stages.** Intake by the project board's Priority and Size, a plan loop, plan sign-off, a build loop, build sign-off, and the ship gates.
- **Agents.** Five reviewer sub-agents (product owner, usability, accessibility, architecture, security) and an oversight agent, started with `/foundry:begin` or `claude --agent foundry:oversight`.
- **The mod.** It enforces each stage, keeps each batch's state in GitHub as labels and a state comment, and shows every batch as a card in a side panel with "waiting on you" alerts. Only the maintainer signs off, from the panel or `/foundry`.
- **Ship gates.** Each allowlisted online reviewer must review the head commit, CI must be green, and no thread may be left open. Failures send the work back to the build loop.
- **Round limits.** Each stage has a round limit, and reaching it escalates to the maintainer. Reviewer conflicts escalate too, with veto and compromise.
- **Per-repository settings.** A `foundry.yaml`, read from the default branch only, sets the reviewers, round limit, online reviewers and maintainers.
- **Skills.** Review, pair-programming and retro skills, generalized for any repository.
