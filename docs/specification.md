# Foundry: Plugin and Mod Spec

## Goal
Guide agents through a repeatable, gated process from GitHub issue to shipped code. Brylie monitors every stage and signs off at key points.

## Stages
1. **Intake:** Pull triaged issues from the current milestone in GitHub Projects. Order them by the Priority and Size fields. Group related issues into batches, so each batch gets one pull request.
2. **Plan loop:** An agent writes a plan for the batch. Before any code, a docs pass updates the documentation the plan rests on: the product owner maintains the product requirements, and architecture co-authors the specification with the product owner and records the decisions. Six specialist reviewers check the plan and those docs together: product owner, usability, accessibility, architecture, security, and documentation. The loop repeats until all six approve.
3. **Plan sign-off:** Brylie approves the plan and its docs.
4. **Build loop:** An agent implements and tests, and updates the user and reference docs with the code. The same six reviewers check the work. The loop repeats until all six approve.
5. **Build sign-off:** Brylie approves the implementation.
6. **Ship gates:** Open a pull request. CI must go green, with no change request or review thread open from the allowlist. Foundry doesn't wait for the online reviewers to review: what they find arrives as a change request or a thread. Failures or change requests send the work back to the build loop.

## Rules
- An oversight agent coordinates the stages.
- The round limit per stage is a setting, default 3. Hitting it escalates to Brylie.
- The round counter resets when work moves to the next stage.
- A CI failure counts as a round. A plain rerun for a flaky test does not.
- Reviewer conflicts escalate to Brylie, who uses a veto or finds a compromise.

## Documentation
Documentation is a first-class part of the work: a change is not done until what people read about it is true.
- **Requirements:** the product owner maintains the product requirements documents.
- **Specifications:** the product owner and architecture co-author them. Architecture also records significant decisions.
- **Docs first:** requirements, specifications and decision records are written in the plan loop, before any code, and Brylie's plan sign-off agrees them. Before that sign-off, only those documents may change.
- **Docs with the code:** user and reference docs, the README and the changelog change in the build loop, alongside the code they describe.
- **Documentation reviewer:** in the plan loop, it checks that the plan covers every document the change touches. In the build loop, it checks that those documents were updated and match the code.
- **Where docs live:** each project says where it keeps each kind of document.

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
- a link to the batch's plan: the plan is a file on the branch, `docs/plans/<lead>.md`, shown on the card

Brylie also decides away from the panel, which the mobile app doesn't show: Foundry asks in a question card when a batch starts waiting, and every `/foundry` decision can be typed, from a phone over Remote Control too. The agent names the command to type when it stops at a gate.

The agent's own tool call that opens a wait (a sign-off request, a conflict, a round limit) draws a decision card under its row in the conversation, on every surface the mobile app included. It offers the panel's buttons, and answers only the wait that call opened: once that wait is decided, it reads "decided" and offers nothing.

## Plugin parts
- **Sub-agents:** the six reviewers and the oversight agent. The product owner and architecture also author documentation in the plan loop.
- **Mod:** the panel and the gate logic.

## Project
- **Repository:** github.com/brylie/foundry
- **License:** Apache 2.0
- **Language:** TypeScript, using the Node .gitignore template
- **First step:** Check the current Claude mod and plugin docs before building.
