# Foundry: Plugin and Mod Spec

## Goal
Guide agents through a repeatable, gated process from GitHub issue to shipped code. Brylie monitors every stage and signs off at key points.

## Stages
1. **Intake:** Pull triaged issues from the current milestone in GitHub Projects. Order them by the Priority and Size fields. Group related issues into batches, so each batch gets one pull request.
2. **Plan loop:** An agent writes a plan for the batch. Five specialist reviewers check it: product owner, usability, accessibility, architecture, and security. The loop repeats until all five approve.
3. **Plan sign-off:** Brylie approves the plan.
4. **Build loop:** An agent implements and tests. The same five reviewers check the work. The loop repeats until all five approve.
5. **Build sign-off:** Brylie approves the implementation.
6. **Ship gates:** Open a pull request. The online reviewers must approve and CI must go green. Failures or change requests send the work back to the build loop.

## Rules
- An oversight agent coordinates the stages.
- The round limit per stage is a setting, default 3. Hitting it escalates to Brylie.
- The round counter resets when work moves to the next stage.
- A CI failure counts as a round. A plain rerun for a flaky test does not.
- Reviewer conflicts escalate to Brylie, who uses a veto or finds a compromise.

## GitHub context
- **Tooling:** Use the `gh` CLI for issues, pull requests, and CI reruns.
- **State:** All stage and round state lives in GitHub, for example as labels and comments on issues and pull requests.
- **Online reviewers:** A few automated reviewers comment on pull requests. Some review comments appear under Brylie's account. Treat those as reviewer feedback, not as sign-off.

## Mod panel
A side pane that shows each batch as a card moving down the stages. For each stage it shows:
- the round counter
- status lights for each reviewer
- test and CI status
- a clear "waiting on you" alert for sign-offs, conflicts, and round-limit escalations

## Plugin parts
- **Sub-agents:** the five reviewers and the oversight agent.
- **Mod:** the panel and the gate logic.

## Project
- **Repository:** github.com/brylie/foundry
- **License:** Apache 2.0
- **Language:** TypeScript, using the Node .gitignore template
- **First step:** Check the current Claude mod and plugin docs before building.
