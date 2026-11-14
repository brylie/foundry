#!/usr/bin/env python3
"""Print a repository's issue conventions for a retro: labels, milestones,
projects (with field options when --project is given), and open issue titles
for de-duplication. Uses the GitHub CLI (`gh`); run it inside the repository
or pass --repo owner/name."""

import argparse
import json
import subprocess
import sys


def gh(*args):
    result = subprocess.run(["gh", *args], check=False, capture_output=True, text=True)
    if result.returncode != 0:
        sys.exit(f"gh {' '.join(args[:3])}: {result.stderr.strip()}")
    return result.stdout


def issues_project(repo, sample=10):
    """The project number most of the repository's newest open issues are on, or None.

    A repository can belong to several projects of its owner, so the owner's
    project list alone does not say which one the issues use. The newest
    issues do: a project workflow adds each new issue to its board.
    """
    owner, name = repo.split("/")
    query = (
        "query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name)"
        "{issues(first:$n,states:OPEN,orderBy:{field:CREATED_AT,direction:DESC})"
        "{nodes{projectItems(first:10){nodes{project{number closed owner{...on User{login} ...on Organization{login}}}}}}}}}"
    )
    out = gh("api", "graphql", "-f", f"query={query}", "-F", f"owner={owner}", "-F", f"name={name}",
             "-F", f"n={sample}")
    # A project number names a project only under its owner, so count (owner, number) pairs.
    counts = {}
    for issue in json.loads(out)["data"]["repository"]["issues"]["nodes"]:
        for item in issue["projectItems"]["nodes"]:
            project = item["project"]
            if not project["closed"]:
                key = ((project.get("owner") or {}).get("login", owner), project["number"])
                counts[key] = counts.get(key, 0) + 1
    if not counts:
        return None
    return max(counts, key=counts.get)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", help="owner/name (default: the current repository)")
    parser.add_argument("--project", type=int, help="project number to list fields for")
    parser.add_argument("--owner", help="project owner (default: the repository owner)")
    args = parser.parse_args()

    repo = args.repo or json.loads(gh("repo", "view", "--json", "nameWithOwner"))["nameWithOwner"]
    owner = args.owner or repo.split("/")[0]
    print(f"# {repo}\n")

    print("## Labels")
    for label in json.loads(gh("label", "list", "--repo", repo, "--limit", "200", "--json", "name,description")):
        print(f"- {label['name']}: {label['description']}")

    print("\n## Milestones (open)")
    for m in json.loads(gh("api", f"repos/{repo}/milestones?state=open&per_page=100")):
        description = (m.get("description") or "").split("\n")[0]
        print(f"- {m['title']} ({m['open_issues']} open): {description}")

    print("\n## Projects")
    projects = json.loads(gh("project", "list", "--owner", owner, "--format", "json")).get("projects", [])
    for p in projects:
        if not p.get("closed"):
            print(f"- #{p['number']} {p['title']} ({p['items']['totalCount']} items) {p['url']}")

    found = (owner, args.project) if args.project is not None else issues_project(repo)
    if found is None:
        print("\nThis repository's newest open issues are on no project, so a plan needs no `project`.")
        project = None
    else:
        owner, project = found
        print(f"\nThis repository's issues are on {owner}'s project #{project}. Use "
              f'{{"owner": "{owner}", "number": {project}}} in the plan, '
              "and set every single-select field below that the board sorts by (Priority and Size).")
        print(f"\n## Project #{project} fields")
        fields = json.loads(gh("project", "field-list", str(project), "--owner", owner, "--format", "json"))
        for f in fields["fields"]:
            options = [o["name"] for o in f.get("options", [])]
            if options:
                print(f"- {f['name']}: {', '.join(options)}")

    print("\n## Open issues")
    issues = json.loads(gh("issue", "list", "--repo", repo, "--state", "open", "--limit", "500",
                           "--json", "number,title,labels,milestone"))
    if len(issues) == 500:
        print("(warning: this list stops at 500 open issues; before filing, also search with "
              "`gh issue list --search` for each candidate's keywords)")
    for i in sorted(issues, key=lambda i: i["number"]):
        labels = ",".join(label["name"] for label in i["labels"])
        milestone = (i.get("milestone") or {}).get("title", "-")
        print(f"- #{i['number']} {i['title']} [{labels}] ({milestone})")


if __name__ == "__main__":
    main()
