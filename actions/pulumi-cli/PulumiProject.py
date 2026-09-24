from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from pulumi_cli import PulumiCLI
import re


class ProjectDiscoveryError(RuntimeError):
    pass

# Constants
# 'fixtures' holds test projects: real Pulumi.yaml files that are never deployed.
IGNORED_DIRS = {".git", "node_modules", ".venv", "fixtures"}
PROJECT_NAME_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+$")
PROJECT_LINE_PATTERN = re.compile(
    r"^name:\s*([A-Za-z0-9_.-]+)\s*(?:#.*)?$"
)


def read_project_name(pulumi_yaml: Path) -> str:
    """Read a plain, top-level project name from a Pulumi project file."""
    try:
        lines = pulumi_yaml.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        raise ProjectDiscoveryError(
            f"could not read {pulumi_yaml}: {error}"
        ) from error

    for line in lines:
        match = PROJECT_LINE_PATTERN.fullmatch(line)
        if match:
            return match.group(1)

    raise ProjectDiscoveryError(
        f"{pulumi_yaml} must contain an unindented plain project name, "
        "for example: 'name: my-project'"
    )


def split_stack_name(qualified: str) -> tuple[str, str]:
    """Extract project and stack from project/stack or org/project/stack."""
    parts = qualified.split("/")

    if len(parts) < 2 or any(not part for part in parts):
        raise ValueError(
            f"cannot extract project and stack from {qualified!r}"
        )

    return parts[-2], parts[-1]


@dataclass
class PulumiProject:
    """One Pulumi project, known from the checkout, the backend, or both."""

    name: str
    cli: PulumiCLI = field(repr=False)
    workdir: Path | None = None
    backend: dict[str, Any] | None = None
    # Keyed by short stack name ('main'), not the fully-qualified one.
    stacks: dict[str, dict[str, Any]] = field(default_factory=dict)

    @property
    def in_repository(self) -> bool:
        return self.workdir is not None

    @property
    def in_backend(self) -> bool:
        return self.backend is not None

    @property
    def main_stack(self) -> dict[str, Any] | None:
        return self.stacks.get("main")


@dataclass
class ProjectInventory:
    """Projects in the checkout and in the backend, joined by project name.

    Scoped to the given workdirs. Backend-only (orphaned) projects are included
    when a workdir covers the whole checkout, or when a requested workdir no
    longer exists and is assumed to have held the backend project of the same
    name - an assumption, since a directory and its project can be named apart.
    """

    projects: dict[str, PulumiProject] = field(default_factory=dict)
    # Missing workdir -> the orphaned project assumed to have lived there.
    deleted_workdirs: dict[Path, str] = field(default_factory=dict)
    # Missing workdirs with no backend project of the same name to explain them.
    missing_workdirs: list[Path] = field(default_factory=list)

    @classmethod
    def discover(
        cls, cli: PulumiCLI, repo_root: Path, workdirs: list[Path] | None = None
    ) -> ProjectInventory:
        repo_root = repo_root.resolve()
        roots = [(repo_root / w).resolve() for w in (workdirs or [Path(".")])]
        whole_checkout = repo_root in roots
        missing = [r for r in roots if not r.is_dir()]

        repository = cls._repository_projects([r for r in roots if r.is_dir()])
        backend = cls._backend_projects(cli)
        stacks = cls._backend_stacks(cli)

        names = set(repository) | set(backend) if whole_checkout else set(repository)

        inventory = cls()
        if missing:
            # Searched in full so a project that moved rather than was deleted is not
            # reported as orphaned just because its old directory name is gone.
            checkout = repository if whole_checkout else cls._repository_projects([repo_root])
            for workdir in missing:
                if workdir.name in backend and workdir.name not in checkout:
                    inventory.deleted_workdirs[workdir] = workdir.name
                    names.add(workdir.name)
                else:
                    inventory.missing_workdirs.append(workdir)

        for name in names:
            inventory.projects[name] = PulumiProject(
                name=name,
                cli=cli,
                workdir=repository.get(name),
                backend=backend.get(name),
                stacks=stacks.get(name, {}),
            )
        return inventory

    @staticmethod
    def _repository_projects(roots: list[Path]) -> dict[str, Path]:
        projects: dict[str, Path] = {}
        # Overlapping roots ('.' and 'infra') find the same file twice; that is not a duplicate.
        seen: set[Path] = set()
        for root in roots:
            for path in root.rglob("Pulumi.yaml"):
                if path in seen or IGNORED_DIRS & set(path.relative_to(root).parts):
                    continue
                seen.add(path)
                name = read_project_name(path)
                if name in projects:
                    raise ProjectDiscoveryError(
                        f"project {name!r} is declared in both {projects[name]} and {path.parent}"
                    )
                projects[name] = path.parent
        return projects

    @staticmethod
    def _backend_projects(cli: PulumiCLI) -> dict[str, dict[str, Any]]:
        projects = {}
        for entry in cli.list_projects():
            projects[entry["name"]] = entry
        return projects

    @staticmethod
    def _backend_stacks(cli: PulumiCLI) -> dict[str, dict[str, dict[str, Any]]]:
        projects = {}
        for entry in cli.list_all_stacks():
            project, stack = split_stack_name(entry["name"])
            if project not in projects:
                projects[project] = {}
            projects[project][stack] = entry

        return projects

    @property
    def existing(self) -> list[PulumiProject]:
        return [p for p in self.projects.values() if p.in_repository and p.in_backend]

    @property
    def absent(self) -> list[PulumiProject]:
        """In the checkout, never deployed to the backend."""
        return [p for p in self.projects.values() if p.in_repository and not p.in_backend]

    @property
    def orphaned(self) -> list[PulumiProject]:
        """In the backend, no longer in the checkout."""
        return [p for p in self.projects.values() if p.in_backend and not p.in_repository]
