#!/usr/bin/env python3
"""Foundry intake: the triaged issues of a milestone, ordered by the project board's
Priority and Size fields, and what was held back.

Usage: candidates.py [MILESTONE] [--repo OWNER/NAME] [--project N]

MILESTONE is a number, a title, or a title prefix like M2. The default is the
lowest-numbered open milestone that still has open issues. The repository
defaults to the one `gh` finds from the current directory; the project to the
one most of the repository's newest issues are on.

An issue is triaged when the board has both its Priority and Size set and its
Status is the board's first option (usually Todo) or unset. Priority sorts by
the order of the field's options (P0 first), then Size (XS first), then number.

It only reads from GitHub. Held-back issues are printed too, because a batch
can collide with them even though it cannot take them.
"""

import argparse
import json
import re
import subprocess
import sys
import time

RECENT_SECONDS = 3 * 24 * 60 * 60
MAX_FILES_SHOWN = 12
DEPENDS = re.compile(r"(?:depends on|blocked by)[^\n]*", re.IGNORECASE)
ISSUE_REF = re.compile(r"#(\d+)")
NOT_READY = re.compile(r"needs[ -_:]*(spec|design|decision|discussion)|blocked|on[ -_]hold|wontfix", re.IGNORECASE)
DECISION_RECORD = re.compile(r"^(adr|rfc|decision)$", re.IGNORECASE)


def gh(*args):
    result = subprocess.run(["gh", *args], text=True, capture_output=True)
    if result.returncode != 0:
        sys.exit(f"gh {' '.join(args[:3])}: {result.stderr.strip()}")
    return json.loads(result.stdout)


def graphql(query, **variables):
    args = ["api", "graphql", "-f", f"query={query}"]
    for key, value in variables.items():
        args += ["-F", f"{key}={value}"]
    return gh(*args)["data"]


def find_milestone(repo, wanted):
    milestones = sorted(gh("api", f"repos/{repo}/milestones?state=open&per_page=100"), key=lambda m: m["number"])
    if wanted is None:
        return next((m for m in milestones if m["open_issues"] > 0), None)
    for m in milestones:
        if str(m["number"]) == wanted or m["title"].lower().startswith(wanted.lower()):
            return m
    sys.exit(f"No open milestone matches {wanted!r}")


ISSUE_FIELDS = """
  number title body
  labels(first: 30) { nodes { name } }
  assignees(first: 10) { nodes { login } }
  closedByPullRequestsReferences(first: 5, includeClosedPrs: true) { nodes { number } }
  projectItems(first: 10) { nodes { project { number } fieldValues(first: 30) { nodes {
    ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } }
  } } } }
"""


def milestone_issues(owner, name, milestone):
    """Every open issue of the milestone (or of the repository), with its board fields."""
    issues, cursor = [], None
    while True:
        after = f', after: "{cursor}"' if cursor else ""
        if milestone:
            query = f"""query($owner: String!, $name: String!, $m: Int!) {{ repository(owner: $owner, name: $name) {{
              milestone(number: $m) {{ issues(first: 100, states: OPEN{after}) {{ pageInfo {{ hasNextPage endCursor }} nodes {{ {ISSUE_FIELDS} }} }} }} }} }}"""
            page = graphql(query, owner=owner, name=name, m=milestone["number"])["repository"]["milestone"]["issues"]
        else:
            query = f"""query($owner: String!, $name: String!) {{ repository(owner: $owner, name: $name) {{
              issues(first: 100, states: OPEN{after}) {{ pageInfo {{ hasNextPage endCursor }} nodes {{ {ISSUE_FIELDS} }} }} }} }}"""
            page = graphql(query, owner=owner, name=name)["repository"]["issues"]
        issues += page["nodes"]
        if not page["pageInfo"]["hasNextPage"]:
            return issues
        cursor = page["pageInfo"]["endCursor"]


def board_project(issues):
    """The project most of these issues are on, or None."""
    counts = {}
    for issue in issues:
        for item in issue["projectItems"]["nodes"]:
            number = item["project"]["number"]
            counts[number] = counts.get(number, 0) + 1
    return max(counts, key=counts.get) if counts else None


def field_options(owner, number):
    """Each single-select field of the project, as its options in board order."""
    query = """query($owner: String!, $n: Int!) { %s(login: $owner) { projectV2(number: $n) {
      fields(first: 50) { nodes { ... on ProjectV2SingleSelectField { name options { name } } } } } } }"""
    for kind in ("user", "organization"):
        result = subprocess.run(
            ["gh", "api", "graphql", "-f", f"query={query % kind}", "-F", f"owner={owner}", "-F", f"n={number}"],
            text=True, capture_output=True,
        )
        if result.returncode != 0:
            continue
        data = json.loads(result.stdout).get("data", {}).get(kind)
        if data and data.get("projectV2"):
            return {f["name"]: [o["name"] for o in f["options"]] for f in data["projectV2"]["fields"]["nodes"] if f}
    return {}


def board_fields(issue, project):
    for item in issue["projectItems"]["nodes"]:
        if item["project"]["number"] == project:
            return {v["field"]["name"]: v["name"] for v in item["fieldValues"]["nodes"] if v and v.get("field")}
    return None


def names(nodes, key):
    return [node[key] for node in nodes]


def line(issue, fields=None, note=""):
    labels = ",".join(names(issue["labels"]["nodes"], "name"))
    board = f"{fields.get('Priority', '-')}/{fields.get('Size', '-')} " if fields is not None else ""
    suffix = f"  <- {note}" if note else ""
    return f"#{issue['number']} {board}[{labels}] {issue['title']}{suffix}"


def git(path, *args):
    result = subprocess.run(["git", "-C", path, *args], text=True, capture_output=True)
    return result.stdout.strip() if result.returncode == 0 else ""


def other_worktrees(base):
    """Recent worktrees other than this one: a started session shows up here first."""
    here = git(".", "rev-parse", "--show-toplevel")
    paths = [t.removeprefix("worktree ") for t in git(".", "worktree", "list", "--porcelain").splitlines() if t.startswith("worktree ")]
    lines = []
    for path in paths:
        committed = git(path, "log", "-1", "--format=%ct")
        if path == here or not committed or time.time() - int(committed) > RECENT_SECONDS:
            continue
        branch = git(path, "branch", "--show-current") or "(detached)"
        ahead = git(path, "rev-list", "--count", f"origin/{base}..HEAD") or "?"
        files = set(git(path, "diff", "--name-only", f"origin/{base}...HEAD").splitlines())
        files |= {entry[3:] for entry in git(path, "status", "--porcelain").splitlines()}
        files.discard(".DS_Store")
        if not files and branch in (base, "(detached)"):
            continue
        shown = ", ".join(sorted(files)[:MAX_FILES_SHOWN])
        more = f", and {len(files) - MAX_FILES_SHOWN} more" if len(files) > MAX_FILES_SHOWN else ""
        lines.append(f"{branch}: {ahead} commits ahead, {len(files)} files changed: {shown or '(none)'}{more}")
    return lines


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("milestone", nargs="?")
    parser.add_argument("--repo")
    parser.add_argument("--project", type=int)
    args = parser.parse_args()

    view = gh("repo", "view", *([args.repo] if args.repo else []), "--json", "nameWithOwner,defaultBranchRef")
    repo = view["nameWithOwner"]
    owner, name = repo.split("/")
    base = (view.get("defaultBranchRef") or {}).get("name") or "main"

    milestone = find_milestone(repo, args.milestone)
    issues = milestone_issues(owner, name, milestone)
    project = args.project or board_project(issues)
    options = field_options(owner, project) if project else {}
    priority_order = options.get("Priority", [])
    size_order = options.get("Size", [])
    statuses = options.get("Status", [])
    ready_status = statuses[0] if statuses else None

    open_numbers = {i["number"] for i in gh("issue", "list", "--repo", repo, "--state", "open", "--limit", "1000", "--json", "number")}

    def rank(entry):
        issue, fields = entry
        p = fields.get("Priority") if fields else None
        s = fields.get("Size") if fields else None
        return (
            priority_order.index(p) if p in priority_order else len(priority_order),
            size_order.index(s) if s in size_order else len(size_order),
            issue["number"],
        )

    groups = {k: [] for k in ("triaged", "untriaged", "waiting", "assigned", "linked", "not_ready", "decision", "started")}
    entries = sorted(((i, board_fields(i, project) if project else None) for i in issues), key=rank)
    for issue, fields in entries:
        label_names = names(issue["labels"]["nodes"], "name")
        waits = sorted(
            {int(n) for text in DEPENDS.findall(issue["body"] or "") for n in ISSUE_REF.findall(text)}
            & open_numbers - {issue["number"]}
        )
        linked = names(issue["closedByPullRequestsReferences"]["nodes"], "number")
        assignees = names(issue["assignees"]["nodes"], "login")
        status = (fields or {}).get("Status")
        is_triaged = fields is not None and fields.get("Priority") and fields.get("Size") and status in (None, ready_status)
        if any(n == "foundry" or n.startswith("foundry:") for n in label_names):
            groups["started"].append(line(issue, fields, "already in a Foundry batch"))
        elif assignees:
            groups["assigned"].append(line(issue, fields, ",".join(assignees)))
        elif linked:
            groups["linked"].append(line(issue, fields, "PR " + ",".join(f"#{n}" for n in linked)))
        elif any(NOT_READY.search(n) for n in label_names):
            groups["not_ready"].append(line(issue, fields))
        elif any(DECISION_RECORD.match(n) for n in label_names):
            groups["decision"].append(line(issue, fields))
        elif waits:
            groups["waiting"].append(line(issue, fields, "waits on " + ", ".join(f"#{n}" for n in waits)))
        elif project and not is_triaged:
            missing = [f for f in ("Priority", "Size") if not (fields or {}).get(f)]
            why = f"no {' or '.join(missing)}" if missing else f"Status is {status}"
            groups["untriaged"].append(line(issue, fields, why))
        else:
            groups["triaged"].append(line(issue, fields))

    open_prs = gh("pr", "list", "--repo", repo, "--state", "open", "--limit", "100", "--json", "number,title,author")

    where = f"Milestone {milestone['number']}: {milestone['title']}" if milestone else "All open issues (no open milestone)"
    board = (
        f"project #{project}: Priority {'/'.join(priority_order) or '?'}, Size {'/'.join(size_order) or '?'}, ready Status {ready_status or 'any'}"
        if project
        else "no project board found: every issue counts as triaged, in number order"
    )
    print(f"{repo} (base {base}). {where} ({len(issues)} open). Board: {board}.")
    for title, key in (
        ("TRIAGED, by Priority then Size (Priority/Size shown before the labels)", "triaged"),
        ("NOT TRIAGED: Priority or Size unset, or not in the ready Status", "untriaged"),
        ("WAITING on an open issue (check it is a real dependency)", "waiting"),
        ("DECISION RECORD label (only if the decision is accepted and the spec agreed)", "decision"),
        ("HELD BACK: not ready, a spec or decision is open", "not_ready"),
        ("HELD BACK: assigned, so claimed", "assigned"),
        ("HELD BACK: a pull request links it", "linked"),
        ("HELD BACK: already in a Foundry batch", "started"),
    ):
        print(f"\n{title}: {len(groups[key])}")
        print("\n".join(groups[key]) or "(none)")
    print(f"\nOPEN PULL REQUESTS: {len(open_prs)}")
    for pr in open_prs:
        print(f"#{pr['number']} {pr['author']['login']}: {pr['title']}")
    worktrees = other_worktrees(base)
    print(f"\nOTHER RECENT WORKTREES (check for the same theme or files): {len(worktrees)}")
    print("\n".join(worktrees) or "(none)")


if __name__ == "__main__":
    main()
