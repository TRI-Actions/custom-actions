from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class CommandResult:
    args: tuple[str, ...]
    returncode: int
    stdout: str
    stderr: str

    @property
    def succeeded(self) -> bool:
        return self.returncode == 0


class PulumiCommandError(RuntimeError):
    def __init__(self, result: CommandResult) -> None:
        self.result = result
        detail = result.stderr.strip() or result.stdout.strip()
        super().__init__(detail or f"Pulumi exited with {result.returncode}")


class PulumiCLI:
    def run(
        self,
        *args: str,
        cwd: Path | None = None,
    ) -> CommandResult:
        command = ("pulumi", *args)

        completed = subprocess.run(
            command,
            cwd=cwd,
            env={**os.environ, "CI": "1"},
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )

        return CommandResult(
            args=command,
            returncode=completed.returncode,
            stdout=completed.stdout,
            stderr=completed.stderr,
        )

    def run_json(
        self,
        *args: str,
        cwd: Path | None = None,
    ) -> Any:
        result = self.run(*args, cwd=cwd)

        if not result.succeeded:
            raise PulumiCommandError(result)

        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError as error:
            raise RuntimeError(
                f"Pulumi returned invalid JSON for {' '.join(result.args)}: {error}"
            ) from error

    def list_projects(self) -> list[dict[str, Any]]:
        return self.run_json(
            "project",
            "list",
            "--output",
            "json",
            "--non-interactive",
        )

    def list_all_stacks(self) -> list[dict[str, Any]]:
        return self.run_json(
            "stack",
            "ls",
            "--all",
            "--output",
            "json",
            "--non-interactive",
        )


if __name__ == "__main__":
    import sys
    if sys.argv[1:] == ["list-projects"]:
        print(json.dumps(PulumiCLI().list_projects(), indent=2))
    if sys.argv[1:] == ["list-stacks"]:
        print(json.dumps(PulumiCLI().list_all_stacks(), indent=2))
