#!/usr/bin/env python3
"""File the issues in a retro plan: create each issue with its labels and
milestone, add it to the project (or find the item if the project added it
automatically), and set single-select project fields by name.

Safe to run again: an issue whose title matches an open issue is not created
again; its project fields are still set. Use --dry-run to check the plan.

Plan format (JSON):
  {"repo": "owner/name",
   "project": {"owner": "owner", "number": 7},        # optional
   "required_fields": ["Priority", "Size"],         # optional; this is the default
   "issues": [{"title": "...", "body": "...", "labels": [...],
               "milestone": "...",                     # optional
               "fields": {"Priority": "P1", "Size": "S"}}]}

When the plan names a project and that project has a single-select field
named in required_fields, every issue must set it. An issue without
Priority or Size sorts to the bottom of the board and cannot be batched by
size, so the script refuses the plan instead of filing it half done.
"""

import argparse
import json
import subprocess
import sys
import tempfile
import time

DEFAULT_REQUIRED_FIELDS = ["Priority", "Size"]


def gh(*args, check=True):
    result = subprocess.run(["gh", *args], check=False, capture_output=True, text=True)
    if check and result.returncode != 0:
        sys.exit(f"gh {' '.join(args[:3])}: {result.stderr.strip()}")
    return result


def project_info(owner, number):
    """Project node ID, and {field name: (field ID, {option name: option ID})}."""
    projects = json.loads(gh("project", "list", "--owner", owner, "--format", "json").stdout)["projects"]
    project_id = next((p["id"] for p in projects if p["number"] == number), None)
    if project_id is None:
        sys.exit(f"no project #{number} for {owner}")
    fields = json.loads(gh("project", "field-list", str(number), "--owner", owner, "--format", "json").stdout)
    single_select = {
        f["name"]: (f["id"], {o["name"]: o["id"] for o in f["options"]})
        for f in fields["fields"]
        if f.get("options")
    }
    return project_id, single_select


def find_item(repo, issue_number, project_id):
    """The issue's item on the project, matched by the project's node ID: a
    project number names a project only under its owner, so another owner's
    project of the same number must not match."""
    owner, name = repo.split("/")
    query = (
        "query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name)"
        "{issue(number:$n){projectItems(first:20){nodes{id project{id}}}}}}"
    )
    out = gh("api", "graphql", "-f", f"query={query}", "-F", f"owner={owner}", "-F", f"name={name}",
             "-F", f"n={issue_number}").stdout
    for node in json.loads(out)["data"]["repository"]["issue"]["projectItems"]["nodes"]:
        if node["project"]["id"] == project_id:
            return node["id"]
    return None


def open_issues_by_title(repo):
    """Every open issue (not pull request) by title, all pages, so a rerun never files a duplicate."""
    out = gh("api", "--paginate", f"repos/{repo}/issues?state=open&per_page=100",
             "--jq", ".[] | select(.pull_request == null) | {number, title, url: .html_url}").stdout
    return {issue["title"]: issue for issue in (json.loads(line) for line in out.splitlines() if line.strip())}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("plan")
    parser.add_argument("--dry-run", action="store_true", help="validate and print, change nothing")
    args = parser.parse_args()

    with open(args.plan) as plan_file:
        plan = json.load(plan_file)
    repo = plan["repo"]
    project = plan.get("project")

    # Validate everything before changing anything.
    labels = {label["name"] for label in json.loads(gh("label", "list", "--repo", repo, "--limit", "300",
                                               "--json", "name").stdout)}
    milestones = {m["title"] for m in json.loads(gh("api", f"repos/{repo}/milestones?state=open&per_page=100").stdout)}
    project_id, fields = project_info(project["owner"], project["number"]) if project else (None, {})
    required = [f for f in plan.get("required_fields", DEFAULT_REQUIRED_FIELDS) if f in fields]
    problems = []
    for issue in plan["issues"]:
        for name in required:
            if not issue.get("fields", {}).get(name):
                problems.append(f"{issue['title']}: project field '{name}' is required and not set")
        for label in issue.get("labels", []):
            if label not in labels:
                problems.append(f"{issue['title']}: no label '{label}'")
        if issue.get("milestone") and issue["milestone"] not in milestones:
            problems.append(f"{issue['title']}: no open milestone '{issue['milestone']}'")
        for name, value in issue.get("fields", {}).items():
            if not project:
                problems.append(f"{issue['title']}: field '{name}' but no project in the plan")
            elif name not in fields:
                problems.append(f"{issue['title']}: no single-select project field '{name}'")
            elif value not in fields[name][1]:
                problems.append(f"{issue['title']}: field '{name}' has no option '{value}'")
    if problems:
        sys.exit("Plan has problems, nothing was changed:\n- " + "\n- ".join(problems))

    open_issues = open_issues_by_title(repo)
    for issue in plan["issues"]:
        summary = " | ".join(f"{k} {v}" for k, v in issue.get("fields", {}).items())
        if args.dry_run:
            state = "exists" if issue["title"] in open_issues else "new"
            print(f"[dry run, {state}] {issue['title']} | {', '.join(issue.get('labels', []))} | "
                  f"{issue.get('milestone', '-')} | {summary}")
            continue

        if issue["title"] in open_issues:
            number, url = open_issues[issue["title"]]["number"], open_issues[issue["title"]]["url"]
        else:
            with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as body:
                body.write(issue["body"])
            cmd = ["issue", "create", "--repo", repo, "--title", issue["title"], "--body-file", body.name]
            if issue.get("labels"):
                cmd += ["--label", ",".join(issue["labels"])]
            if issue.get("milestone"):
                cmd += ["--milestone", issue["milestone"]]
            url = gh(*cmd).stdout.strip().splitlines()[-1]
            number = int(url.rstrip("/").rsplit("/", 1)[1])

        if project:
            item = None
            # A project workflow may add new issues on its own, a moment later.
            for _ in range(5):
                item = find_item(repo, number, project_id)
                if item:
                    break
                added = gh("project", "item-add", str(project["number"]), "--owner", project["owner"],
                           "--url", url, "--format", "json", check=False)
                if added.returncode == 0:
                    item = json.loads(added.stdout)["id"]
                    break
                time.sleep(2)
            if item is None:
                sys.exit(f"#{number}: could not add it to project #{project['number']}")
            for name, value in issue.get("fields", {}).items():
                field_id, options = fields[name]
                gh("project", "item-edit", "--id", item, "--project-id", project_id,
                   "--field-id", field_id, "--single-select-option-id", options[value])
        print(f"#{number}\t{url}\t{issue['title']}\t{summary}")


if __name__ == "__main__":
    main()
