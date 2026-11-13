---
name: retro
description: Run a retrospective on recently completed work and turn what was left behind into well-formed GitHub issues: follow-up tasks, bugs found along the way, out-of-scope items, refactoring and tech debt, docs gaps, open spec questions. Manual checks go on one Manual QA issue per milestone, never on issues of their own. Each issue gets a priority, size, labels (including "good first issue", "help wanted", and "hacktoberfest" where they fit), milestone, and project fields. Use this whenever the user asks for a retro, a wrap-up, "what's left", "add follow-ups to the backlog", "file issues for the loose ends", "what did we skip", or wants recently merged PRs, a branch, or the current session's work mined for next steps, even if they don't say "retro".
---

# Retro: turn finished work into a good backlog

Finished work leaves a trail: things deliberately put out of scope, review comments deferred, manual checks nobody did, tests that were loosened, open questions written into specs, small bugs noticed in passing. A retro collects that trail before it is forgotten and files it as issues that someone else, human or agent, can pick up cold.

The value is in three things: finding the real leftovers (not inventing busywork), not duplicating what is already tracked, and writing each issue so it is actionable with the right priority, size, and labels for this repository.

## 1. Decide what "recently completed work" means

Use the narrowest scope that matches the request:

- **A Foundry batch:** if this session ran one, `mcp__foundry__batch_status` names its issues and pull request. Its state comment on the lead issue holds each reviewer's verdicts, the escalations and the send-backs. Each is a leftover to check: a `revise` finding the agent declined, a vetoed reviewer's concern, a question deferred to later.
- **This session:** if work was done earlier in the current conversation, that is the primary source. Reread it: PR descriptions you wrote, "out of scope" and "not done" notes, test failures you worked around, review comments, things you told the user you would leave for later.
- **Named PRs, issues, or a branch:** read them.
- **"Recent work" with nothing named:** recently merged PRs, for example `gh pr list --state merged --limit 10 --json number,title,mergedAt,author`. Prefer the user's own PRs, and say which ones you looked at.

## 2. Harvest candidates

For each piece of work, look in these places. Each tends to hold a different kind of leftover:

| Where | What it yields |
|---|---|
| PR description | "Out of scope", "Not done", "Follow-up", unchecked boxes in a manual checklist, "not run locally" |
| PR review comments and threads | Suggestions marked "later", "nit", "out of scope", or resolved without a code change |
| The diff | New `TODO`/`FIXME`/`XXX`, `#[ignore]`d or skipped tests, loosened tolerances, hard-coded constants with a comment about later, `unwrap()` left on a fallible path |
| Specs, ADRs, design docs touched by the work | "Open points", "Open questions", "Out of scope", "Draft" sections, criteria still unticked |
| CI results | Flaky or slow jobs, warnings |
| The conversation | Bugs noticed in passing, assumptions that need confirming, a "we should" that never happened |

Useful commands: `gh pr view N --json body,comments,reviews,files`, `gh api repos/OWNER/REPO/pulls/N/comments`, `gh pr diff N`, `git log`, `rg -n "TODO|FIXME" <changed files>`.

Classify each candidate as one of: **follow-up**, **bug**, **manual check** (only a person can do it, so it goes on the Manual QA issue), **out-of-scope feature**, **refactor or tech debt**, **test gap**, **docs**, **decision** (a question someone must answer before building).

## 3. Filter hard

A good retro files fewer, better issues. Drop or redirect candidates that:

- **are already tracked.** Search open issues (`gh issue list --state open --search "<keywords>"`; `scripts/repo_context.py` also lists open titles, up to 500, and warns when it stops there). If an existing issue covers it, draft a comment for that issue instead of filing a duplicate. The comment goes into the plan in step 8 and is posted only after the user approves it. Mention it in your report.
- **are trivial.** Fix them now, or leave them out.
- **only the user can do**, such as changing an account or app setting. Mention them in the report; an issue nobody can act on is noise.
- **are manual checks.** Never file one as its own issue. A check that code or a test could do is a test gap, so file that instead. What only a person can do goes on the milestone's Manual QA issue (step 7). *Why:* one issue per check makes the backlog grow fast and hides the work that code can finish.
- **overlap each other.** Merge them into one issue with a checklist.

Keep anything that a future contributor would need to know about, even if it is small, when forgetting it would cause a bug or a wrong decision later.

## 4. Learn this repository's conventions

Before writing anything, run:

```bash
python3 "${CLAUDE_SKILL_DIR}/scripts/repo_context.py"            # labels, milestones, projects, open issue titles
python3 "${CLAUDE_SKILL_DIR}/scripts/repo_context.py" --project N  # also the project's fields and options
```

The first command also says which project this repository's issues are on, found from its newest open issues, and lists that project's fields. Use that project in the plan. Skip `project` only when the output says the issues are on none.

Then read two or three recent issues (`gh issue view N`) to copy their body style: headings, footers, how they link requirements and specs. Read CONTRIBUTING.md or AGENTS.md if they exist, because they often define label meanings or a spec-first rule.

Use only labels, milestones, and field options that exist. Map your judgment onto the repository's vocabulary: if priority is a label (`priority:high`) rather than a project field, use the label. If the repo uses MoSCoW labels (`must`, `should`, `could`), set those as well as the priority.

**When the project has Priority and Size fields, every issue in the plan sets both.** The board sorts by them, so an issue without them sinks to the bottom of the list however important it is, and batching work needs Size to see what fits together. The filing script refuses a plan that leaves either empty. Copy the board's own convention where one shows, for example `must` and `should` work as P1 and `could` as P2, and refactoring that affects the quality of other work ranks with the work it affects, not below it.

## 5. Assign priority, size, labels, and milestone

**Priority.** Map onto whatever scale the repository uses. In P0/P1/P2 terms:

- **P0:** correctness, data loss, security, or a real user-facing break. Also work that blocks other planned work.
- **P1:** belongs in the current milestone. A visible gap, or a decision needed before nearby planned work.
- **P2:** worth doing later. Polish, hardening, and nice-to-haves.

**Size** (XS to XL). Use whatever the repository uses, otherwise this scale:

- **XS:** under about an hour, one file.
- **S:** about half a day, a few files.
- **M:** one to three days, one feature slice.
- **L:** about a week, several components.
- **XL:** too big for one issue. Split it, or make it an umbrella with sub-issues.

**good first issue:** self-contained, size XS or S, with a clear "done when", no design decision to make, and an existing pattern in the code to copy.

**help wanted:** well specified and open to outside contributors, even if larger or needing domain knowledge. Not for decisions only the maintainer can make.

**hacktoberfest:** only in October (check today's date), only if the label exists, and only on issues that are also good first issue or help wanted. *Why:* the label invites event participants, so it should only go on work they can actually pick up, during the event.

**Type and area labels:** pick the type (bug, feature, chore, docs, research, or the repo's equivalents) and the area labels the repo uses. If the repository marks work that needs a spec or design agreed first (for example `needs spec agreed`), add it to decisions and to features whose behaviour is not yet written down.

**Milestone:** the phase the work belongs to, from the milestone descriptions and the roadmap. Follow-ups to current work usually go in the current milestone; out-of-scope features usually go in a later one.

## 6. Write each issue

Write for someone who was not in the session:

- **Title:** the problem or outcome, in plain words. "Auto-layout uses a fixed column width, so wide panels can overlap" is better than "Layout fix".
- **Context:** what was built, with links to the PR, commit, file and line, or spec section. Explain why this was left over.
- **The problem or proposal:** what is wrong or missing, and options if a decision is needed.
- **Done when:** a concrete, checkable end state, including the test that proves it.
- **Links:** requirements, specs, related issues, and anything it blocks ("decide before #73").
- Follow the repository's footer and style. For good first issue and help wanted issues, include its newcomer note if it has one.

## 7. Add manual checks to the milestone's Manual QA issue

Each milestone has one issue, titled exactly `Manual QA: <milestone short name>`, such as `Manual QA: M2`. It holds a checklist of what only a person can check: how something feels, looks, or sounds, or behaviour on real hardware. It collects these for one round of testing later, so it is never split up, and it closes when the checklist is done.

**Plan the checks now; write nothing yet.** Everything in this step goes into the plan you show in step 8, and changes GitHub only after the user approves it there. A dry run never reaches the writes.

First look for the issue. This lookup only reads:

```bash
gh issue list --repo OWNER/REPO --state open --milestone "<milestone>" --search "\"Manual QA\" in:title" --json number,title
```

Draft the new checks for the existing body, keeping every box and heading already there. Group them under a heading that names the work, for example `## #609, #612: signal displays`. Each check is one line a person can do with no other context: what to do and what should happen. Check for the same check before adding it. If there is no Manual QA issue yet, plan to create one.

**After the user approves in step 8,** edit the existing issue, or create it if it was missing:

```bash
gh issue view N --repo OWNER/REPO --json body --jq .body > body.md   # edit: add the approved section
gh issue edit N --repo OWNER/REPO --body-file body.md
```

A new Manual QA issue starts with one sentence saying what it is for and how to run the app, then the checklist. Use the repository's labels for a chore, with the priority it uses for work due in that milestone. In `plan.json` it is an ordinary issue. Later runs edit it with the commands above, because `file_issues.py` skips a title that already exists and would not add the new checks.

## 8. Confirm, then file

Show the user the plan as a table before creating anything, because issues are public and hard to take back:

| # | Title | Type | Priority | Size | Milestone | Labels |
|---|---|---|---|---|---|---|

List separately: the checks you will add to the Manual QA issue, what you will add as comments on existing issues, and what you left out and why. Ask whether to file all, some, or a changed set, and apply their edits.

Then file with the bundled script. It creates the issues, adds them to the project (or finds the item if the project already added them automatically), sets the project fields by name, and skips titles that already exist. So it is safe to run again after a partial failure:

```bash
python3 "${CLAUDE_SKILL_DIR}/scripts/file_issues.py" plan.json --dry-run   # check first
python3 "${CLAUDE_SKILL_DIR}/scripts/file_issues.py" plan.json
```

`plan.json` format:

```json
{
  "repo": "owner/name",
  "project": {"owner": "owner", "number": 7},
  "issues": [
    {
      "title": "…",
      "body": "…markdown…",
      "labels": ["bug", "area:ui", "good first issue"],
      "milestone": "M2: Core features",
      "fields": {"Priority": "P1", "Size": "XS", "Status": "Todo"}
    }
  ]
}
```

Leave out `project` only if `repo_context.py` found no project for this repository's issues. Leave out `milestone` if there are none. When the project has `Priority` and `Size` fields, the script refuses an issue that lacks either, in the dry run and in the real run, so fix the plan rather than filing without them. A plan may set `"required_fields": []` to switch that off for a project that uses the fields differently.

## 9. Report

End with the filed issues as a table of links, priority, size, and milestone. Then add the checks you added to the Manual QA issue and its link, the comments you posted on existing issues, and the items you left out with one-line reasons. Keep it short: the issues hold the detail.

## Dry runs

If the user asks for a dry run, a preview, or "just show me", stop after step 8's table. Make no GitHub writes at all: no issues, no comments, no edits to the Manual QA issue, no project changes. Reading is fine. Write the plan to `plan.json` if a file is useful.

Before step 8's approval, a full run makes no writes either: every comment, edit and new issue waits in the plan until the user approves it.
