"""Backend-wide status of every Pulumi project, for status.sh to consume.

Prints one tab-separated record per line:
    row    <project> <workdir|-> <state> <detail>
    error  <context> <detail>

Exits non-zero only when the inventory itself could not be built; per-project
failures are reported as 'error' records and left for status.sh to act on.
"""
from __future__ import annotations

import os
import sys
from enum import Enum
from pathlib import Path

from PulumiProject import ProjectInventory, PulumiProject
from pulumi_cli import PulumiCLI


class State(str, Enum):
    # In the repository:
    DEPLOYED = "DEPLOYED"          # main stack has resources in state
    NOT_DEPLOYED = "NOT_DEPLOYED"  # not in the backend, or main stack empty
    # Deleted from the repository, still in the backend:
    ORPHANED = "ORPHANED"          # resources still in state, likely still running
    NOT_CREATED = "NOT_CREATED"    # nothing in state, only the stack is left behind


def classify(project: PulumiProject) -> tuple[State, str]:
    """The project's state, plus a short human-readable detail."""
    deployed, detail = deployment(project)
    if project.in_repository:
        return (State.DEPLOYED if deployed else State.NOT_DEPLOYED), detail
    return (State.ORPHANED if deployed else State.NOT_CREATED), detail


def deployment(project: PulumiProject) -> tuple[bool, str]:
    """Whether the main stack is deployed: it has resources in state.

    Decided by resourceCount from `stack ls --all`, which pulumi has reported for
    every stack in practice.
    """
    if not project.in_backend:
        return False, "not in the backend"
    main = project.main_stack
    if main is None:
        return False, "no 'main' stack"

    last = f", last update {main['lastUpdate']}" if main.get("lastUpdate") else ""
    resources = main.get("resourceCount")
    if resources is None:
        # Counted as deployed so a possible orphan is flagged rather than hidden.
        return True, f"resource count unknown{last}"
    if resources == 0:
        return False, f"no resources in state{last}"
    return True, f"{resources} resource(s){last}"


def emit(*fields: str) -> None:
    # Tabs and newlines would split a record when status.sh reads it back.
    print("\t".join(" ".join(str(f).split()) for f in fields), flush=True)


def display_path(path: Path | None, repo_root: Path) -> str:
    if path is None:
        return "-"
    try:
        return str(path.relative_to(repo_root))
    except ValueError:
        return str(path)


def check_inventory(inventory: ProjectInventory, repo_root: Path) -> int:
    """Print the existing/absent/orphaned split and verify it is consistent.

    Debug aid, run with `status.py --check`. Returns the number of problems.
    """
    groups = {
        "existing": inventory.existing,
        "absent": inventory.absent,
        "orphaned": inventory.orphaned,
    }
    for label, projects in groups.items():
        print(f"{label} ({len(projects)}):")
        for p in sorted(projects, key=lambda p: p.name):
            print(f"  {p.name:<30} {display_path(p.workdir, repo_root):<40} stacks={sorted(p.stacks)}")

    for w, name in inventory.deleted_workdirs.items():
        print(f"deleted workdir {display_path(w, repo_root)} -> assumed orphan {name!r}")

    problems = [
        f"{display_path(w, repo_root)}: not a directory, and no orphaned backend project named {w.name!r}"
        for w in inventory.missing_workdirs
    ]

    # The three groups must partition the inventory: every project in exactly one.
    counts: dict[str, int] = {}
    for projects in groups.values():
        for p in projects:
            counts[p.name] = counts.get(p.name, 0) + 1
    for name in inventory.projects:
        if counts.get(name, 0) != 1:
            problems.append(f"{name}: in {counts.get(name, 0)} groups, expected exactly 1")

    for p in inventory.absent:
        # Stacks come from `stack ls --all`, projects from `project list`: a stack
        # without its project means the two listings disagree.
        if p.stacks:
            problems.append(f"{p.name}: has backend stacks {sorted(p.stacks)} but is missing from `project list`")
    for p in inventory.existing + inventory.orphaned:
        if p.main_stack is None:
            problems.append(f"{p.name}: in the backend but has no 'main' stack (stacks={sorted(p.stacks)})")

    print(f"\n{len(inventory.projects)} projects, {len(problems)} problem(s)")
    for problem in problems:
        print(f"  !! {problem}")
    return len(problems)


def main() -> int:
    repo_root = Path(os.environ.get("REPO_ROOT") or os.environ.get("GITHUB_WORKSPACE") or ".").resolve()
    # Space-separated, as for plan/deploy/destroy; unset or blank means the whole checkout.
    workdirs = [Path(w) for w in os.environ.get("WORKDIRS", "").split()]
    cli = PulumiCLI()

    try:
        inventory = ProjectInventory.discover(cli, repo_root, workdirs)
    except (RuntimeError, ValueError) as error:
        emit("error", "inventory", str(error))
        return 1

    if "--check" in sys.argv[1:]:
        return 1 if check_inventory(inventory, repo_root) else 0

    for missing in inventory.missing_workdirs:
        emit("error", display_path(missing, repo_root),
             f"not a directory, and no orphaned backend project named {missing.name!r}")

    # Orphans found through a deleted workdir are reported against that workdir.
    deleted = {name: w for w, name in inventory.deleted_workdirs.items()}

    for project in sorted(inventory.projects.values(), key=lambda p: p.name):
        workdir = display_path(project.workdir or deleted.get(project.name), repo_root)
        state, detail = classify(project)
        emit("row", project.name, workdir, state.value, detail)

    return 0


if __name__ == "__main__":
    sys.exit(main())
