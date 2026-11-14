# Configuration

Foundry works with no configuration. Its settings come from two places, and the more specific one wins:

1. **`foundry.yaml`** at the root of a repository, for that repository.
2. **The plugin's settings**, for every repository you use Foundry in.

A batch takes the settings in force when it starts, so a change affects the next batch, not one already running.

- [Plugin settings](#plugin-settings)
- [`foundry.yaml`](#foundryyaml)
- [Doc folders](#doc-folders)
- [The allowlist](#the-allowlist)

## Plugin settings

| Setting | Default | Meaning |
|---|---|---|
| `reviewers` | `product-owner,usability,accessibility,architecture,security,documentation` | Comma-separated review perspectives. Every one must approve before a sign-off goes to you. An empty list means the defaults. |
| `maxRounds` | `3` | Review rounds per stage before it escalates to you. CI reruns for flaky tests don't count. |
| `onlineReviewers` | `coderabbitai[bot]` | The automated reviewers that must review a pull request's head commit. Codecov belongs in CI, as its status check. |
| `maintainers` | *(the signed-in account)* | People whose pull request comments count as reviewer feedback, never as sign-off. |
| `botTimeoutMinutes` | `30` | How long to wait for an online reviewer after a push before it escalates to you. |

## `foundry.yaml`

A repository sets its own values in a `foundry.yaml` at its root. Each field it sets wins over the plugin's settings, and each one it leaves out falls back to them.

Foundry reads the file from the **default branch only**, never the checkout. A pull request can't change the rules it's judged by: an edit takes effect once it's merged.

```yaml
# Who reviews the pull request, and whose comments count.
online_reviewers:        # must review the head commit; part of the allowlist
  - coderabbitai[bot]
  - gitar-bot[bot]
maintainers: [brylie]    # their comments count as feedback, never sign-off

# The review loops.
reviewers: [product-owner, usability, accessibility, architecture, security, documentation]
max_rounds: 3
bot_timeout_minutes: 30

# Where the docs live.
requirements: [docs/product]      # the product owner's
specifications: [docs/design]     # co-authored with architecture
decisions: [docs/adr]             # architecture's decision records
user_docs: [README.md, docs/guide, docs/modules]
```

| Key | Plugin setting it overrides | Value |
|---|---|---|
| `online_reviewers` | `onlineReviewers` | GitHub logins; `[bot]` is optional |
| `maintainers` | `maintainers` | GitHub logins |
| `reviewers` | `reviewers` | Review perspectives; a name outside the six runs as a general reviewer |
| `max_rounds` | `maxRounds` | A whole number above 0 |
| `bot_timeout_minutes` | `botTimeoutMinutes` | A number above 0 |
| `requirements`, `specifications`, `decisions`, `user_docs` | *(found in the checkout)* | Folders or files inside the repository; see [Doc folders](#doc-folders) |

The file uses a small YAML subset: top-level `key: value` lines, `[a, b]` or `- item` lists, and `#` comments. When a batch starts, Foundry reports an unknown key or a bad value rather than guessing what was meant. This repository's own [`foundry.yaml`](../foundry.yaml) is a working example.

## Doc folders

Foundry needs to know where each kind of documentation lives, because the plan loop writes some of it before any code.

| Kind | Written | Looked for, when `foundry.yaml` doesn't say |
|---|---|---|
| `requirements` | In the plan loop, by the product owner | `docs/product`, `docs/requirements`, `docs/prd` |
| `specifications` | In the plan loop, by the product owner and architecture | `docs/design`, `docs/specs`, `docs/specifications`, `docs/spec` |
| `decisions` | In the plan loop, by architecture | `docs/adr`, `docs/decisions` |
| `user_docs` | In the build loop, with the code | `README.md`, `CHANGELOG.md`, `docs/guide`, `docs/learn`, `docs/modules`, `docs/user`, `docs/manual`, `docs/reference` |

For the first three kinds, the first folder that exists wins; with none, the batch starts the first one listed. For user docs, every one that exists counts.

A doc path must name a folder or file inside the repository. The root itself (`.`) is refused: as a doc folder, it would open every file to edits in the plan stage.

## The allowlist

The **allowlist** is the online reviewers plus the maintainers. Only their reviews, threads and comments count toward the ship gate, and only theirs reach the agent.

Anyone else's comment, however it's worded, neither blocks the gate nor reaches the agent as an instruction. The panel lists them as "outside the allowlist", for you to read and act on yourself. So nobody outside the list can stall a pull request or slip instructions to the agent.

Maintainers' comments are feedback, never sign-off. Some reviewer bots post under your account, so Foundry takes sign-off only from the panel or your own `/foundry` command.
