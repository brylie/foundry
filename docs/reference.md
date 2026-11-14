# Reference

- [Agents](#agents)
- [Skills](#skills)
- [The `/foundry` command](#the-foundry-command)
- [The mod](#the-mod)

## Agents

| Agent | Role |
|---|---|
| `foundry:oversight` | The coordinator. It runs a batch from intake to merge, spawns the reviewers each round, and stops wherever you decide. Run it as the session's agent with `claude --agent foundry:oversight`, or start the same procedure with `/foundry:begin`. |
| `foundry:product-owner` | Maintains the requirements, co-authors the specification, and reviews against what each issue asks. |
| `foundry:architecture` | Co-authors the specification, records decisions, and reviews for correctness, tests and structure. |
| `foundry:usability` | Reviews what the person using the result sees and does. |
| `foundry:accessibility` | Reviews keyboard use, focus, screen readers, contrast and motion, against the standard the project follows (often WCAG 2.2 AA). |
| `foundry:security` | Reviews trust boundaries, untrusted input, secrets and what new dependencies can reach. |
| `foundry:documentation` | Checks in the plan loop that every affected doc is covered, and in the build loop that each one was updated and matches the code. |
| `foundry:reviewer` | A general reviewer, for any perspective a repository adds to its `reviewers` list. |

The product owner and architecture write docs during the plan loop's docs pass. Otherwise every reviewer is read-only: the mod refuses a reviewer's edits, commits and pushes.

## Skills

| Skill | What it does |
|---|---|
| `/foundry:begin [issues \| milestone \| theme \| dry run]` | Starts a batch: intake, the plan loop, sign-offs, the build loop and the ship gates. A dry run only shows the batch it would pick. |
| `/foundry:review-plan` | Reviews a plan against the repository's rules, specs, issues and code, for the agent that wrote it. |
| `/foundry:review-code [PR \| branch]` | Reviews a change and sends the review to the coding agent's session. |
| `/foundry:pair-driver`, `/foundry:pair-navigator` | Two-session pair programming on top of the same stages: the driver owns the branch, and the navigator reviews. |
| `/foundry:retro` | Turns the leftovers from finished work into well-formed GitHub issues. |

The skills read the project's own rules (`AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`) for its check commands, spec conventions and style.

## The `/foundry` command

`/foundry` is how you act on a batch from the prompt. Every panel button has a command here.

| Command | What it does |
|---|---|
| `/foundry status` | Shows this session's batch: stage, round, reviewers, tests, CI. |
| `/foundry pane` | Opens the Foundry panel. |
| `/foundry approve` | Signs off the plan or the implementation. |
| `/foundry changes [what to change]` | Sends it back for another round. What you write after it reaches the agent as yours. |
| `/foundry veto <reviewer>` | Settles a conflict or a round limit by overruling one reviewer for this stage. |
| `/foundry compromise [the compromise]` | Settles a conflict. Write the compromise after it, or in the chat. |
| `/foundry ack` | Acknowledges state that was restored after an outside edit. |
| `/foundry end` | Ends the batch: its gates stop guarding, and it can't be undone, so it asks you to type `/foundry end #<lead> confirm`. The card's **End batch…** asks too. |
| `/foundry sync` | Reads every open batch from GitHub now, and reports anything not yet saved. |

Add `#<lead issue>` to act on another session's batch, for example `/foundry approve #45`. The commands work from your phone too, over Remote Control: when a batch waits, the agent's message names the one to type. A decision you type wakes the agent, as a press on the card does.

Decisions count only from you, at the prompt. A run from another session, a channel or a plugin is refused, and the agent can't invoke the command.

## The mod

The mod lives in `hooks/` and is loaded with the plugin. It holds the panel, the stage rules, the guards, the batch state in GitHub, and the pull request polling. The tools the oversight agent moves a batch with are:

| Tool | Use |
|---|---|
| `batch_start` | Starts a batch, or takes one over in a new session. |
| `review_record` | Records one reviewer's verdict. |
| `conflict_raise` | Escalates a reviewer conflict to you. |
| `tests_record` | Records a local test run. |
| `signoff_request` | Asks you to sign off the current loop. |
| `pr_opened` | Records the batch's pull request: the draft in the build loop, so the build sign-off can link to it, then the ready one, whose ship gates it watches. |
| `send_back` | Returns a shipping batch to the build loop. |
| `batch_status` | Reads where the batch stands. |

For how the mod keeps its state and guards it, see [Security model](security.md).
