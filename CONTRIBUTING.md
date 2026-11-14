# Contributing to Foundry

Thanks for helping. This guide covers setting up, the shape of the code, the checks every change passes, and the conventions that keep Foundry trustworthy.

## Setting up

You need:

- **Claude Code 2.1.321 or later.** Foundry's mod uses function hooks, which earlier builds don't load. An older `claude` on your `PATH` warns that `types` is an unknown manifest field and validates against an older API, so check `claude --version`.
- **The GitHub CLI** (`gh`), signed in, to run Foundry against a real repository.
- **Python 3**, for the intake and retro scripts.
- **Node.js**, to type-check with `tsc`.

Load your working copy into a session with:

```bash
claude --plugin-dir /path/to/foundry
```

In an interactive session the folder is watched: saving a file reloads the mod. The first load also writes the engine's type declarations to `.claude-plugin/types/` (ignored by git), which the type-check below needs.

## Layout

```
.claude-plugin/   plugin.json (manifest, settings) and marketplace.json
agents/           the oversight agent and the reviewers
skills/           /foundry:begin and the review, pair and retro skills, with their scripts
hooks/            the mod
  register.tsx    events, tools, the /foundry command and the panel
  model.ts        stages, rounds, reviews and decisions, as pure functions
  guard.ts        what each stage and each agent may do
  ship.ts         the ship gates, read from a pull request
  state.ts        the state comment: render, parse, validate, migrate
  github.ts       every read and write to GitHub, through gh
  config.ts       foundry.yaml
types/            the mod's state contract
tests/            *.test.ts(x), run by claude plugin test
docs/             the specification and the guides
```

Keep `model.ts`, `guard.ts`, `ship.ts`, `state.ts` and `config.ts` free of `$` (the engine interface), so they stay pure and testable. Anything that touches the engine or GitHub belongs in `register.tsx` or `github.ts`.

## Checks

Every change passes all four:

```bash
claude plugin validate .        # the manifest and the mod, as the engine reads them
claude plugin test .            # the test suite
npx -p typescript tsc -p .      # types, against the engine's declarations
python3 -m py_compile skills/begin/scripts/*.py skills/retro/scripts/*.py
```

`tsconfig.json` includes the engine's core and built-in tool declarations, but not `.claude-plugin/types/claude-code-mcp/`. That folder declares every MCP tool your session has connected. With many servers, the union grows too large for TypeScript, and the result would differ between contributors.

`tests/` holds two kinds of test:

- **Pure tests** of the rules: stages, guards, ship gates, configuration and the state comment.
- **Flow tests** that drive the mod through the engine's test kit against a pretend `gh`, from intake to merge.

A test for a bug must fail without its fix. Before you trust a new test, switch the fix off and watch the test fail.

## Conventions

- **Docs first.** Foundry is built the way it builds: `docs/specification.md` is the specification, and a behaviour change updates it in the same pull request. User-facing changes update the README or the guides in `docs/`.
- **The changelog.** Every user-visible change gets a line in `CHANGELOG.md`.
- **Versions.** Releases follow [Semantic Versioning](https://semver.org/). Before 1.0, a minor version may change behaviour; say how in the changelog.
- **Stored shapes.** The mod's own state outlives a reload, and the state comment outlives a release. So:
  - **Session state:** when you change a stored value's fields, change its `shape` tag in `register.tsx`.
  - **The state comment:** when you change its format, add a step to `migrate()` in `state.ts`, so batches an earlier version started still read.
- **Fail closed.** A guard that can't decide refuses. A path it can't resolve counts as inside the repository.
- **Plain words.** Messages the agent or the maintainer reads say what happened and what to do next, in short sentences.

### Developing with Foundry loaded

If you run Foundry in the same session you develop it in, its guard watches your commands too. A shell command that mentions Foundry's labels or its state marker is refused, even when it only edits Foundry's own source, because the guard can't tell an edit script from a state write. Use the Edit and Write tools for those files instead: the guard exempts the plugin's own folder for them.

## Pull requests

- **One concern per pull request,** with the checks above passing.
- **Describe** what changed and why, what you tested, and anything you couldn't test, such as a live run against GitHub.
- **Online reviewers** review every pull request. Reply in each thread with what you changed, and resolve it once the fix is pushed.

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
