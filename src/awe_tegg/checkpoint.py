"""The durable record of one operator run.

A coworker starts this operation and may lose the terminal, the laptop lid, or
the network. What they must never lose is the answer to "how far did it get,
and is it safe to run again". So every verified step is written to disk the
moment it is verified, not at the end:

    work/operations/<run-id>/
        state.json      the ledger -- steps, status, results, resume point
        evidence/       screenshots and page captures from this run
        contradiction-<record>.json   structured evidence, when one is found

The ledger is written through a temporary file and renamed, so an interrupted
write leaves the previous ledger intact rather than a truncated one.

Two rules it holds to:

  * **A step is checkpointed only after it is verified.** "Reached the
    Documentation area" is written after the page markers held, never after the
    navigation was merely attempted.
  * **Nothing secret is written.** The ledger records which environment
    variable a credential came from, never what was in it, and a screen runs
    over every value before it reaches disk.
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1

#: The operation's steps, in the order they must happen. The ledger uses this
#: list to decide what a resume may skip, so it is the definition of the
#: workflow rather than a comment about it.
STEPS: tuple[str, ...] = (
    "open_knowledge",
    "sign_in",
    "locate_workspace",
    "reach_documentation",
    "verify_documentation",
    "list_records",
    "finish",
)

#: Steps whose result is a live browser session rather than a durable fact.
#: A resume re-establishes these instead of skipping them -- a session cannot
#: be checkpointed, and pretending otherwise is how a resume lies.
PRECONDITION_STEPS = frozenset({"sign_in", "locate_workspace"})

# Run status.
RUNNING = "running"
COMPLETED = "completed"
INTERRUPTED = "interrupted"
ESCALATED = "escalated"
FAILED = "failed"


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def make_run_id(operation: str, when: str | None = None) -> str:
    stamp = (when or utcnow()).replace(":", "").replace("-", "")
    return f"{operation}-{stamp}"


@dataclass
class Checkpoint:
    """One verified step, with what it proved and what it cost."""

    step: str
    at: str
    detail: str = ""
    data: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class RunLedger:
    """The durable state of one run, safe to read while the run is going."""

    def __init__(
        self,
        path: Path,
        data: dict[str, Any] | None = None,
        *,
        steps: tuple[str, ...] | None = None,
        precondition_steps: frozenset[str] | None = None,
    ) -> None:
        self.path = Path(path)
        self.data: dict[str, Any] = data if data is not None else {}
        # An operation brings its own step list. It is stored in the ledger as
        # well as held here, so a ``status`` command can read a run belonging
        # to an operation it was not told about and still order the steps.
        stored = self.data.get("step_names")
        self.steps: tuple[str, ...] = tuple(steps or stored or STEPS)
        self.precondition_steps: frozenset[str] = frozenset(
            precondition_steps
            if precondition_steps is not None
            else self.data.get("precondition_steps", PRECONDITION_STEPS)
        )

    # -- lifecycle --------------------------------------------------------
    @classmethod
    def create(
        cls,
        root: Path | str,
        run_id: str,
        *,
        operation: str,
        tenant: str,
        integration: str,
        environment: str,
        base_url: str,
        credential_source: str,
        steps: tuple[str, ...] | None = None,
        precondition_steps: frozenset[str] | None = None,
    ) -> "RunLedger":
        path = Path(root) / "operations" / run_id
        if (path / "state.json").exists():
            return cls.open(path, steps=steps, precondition_steps=precondition_steps)
        (path / "evidence").mkdir(parents=True, exist_ok=True)
        ledger = cls(
            path,
            {
                "schema_version": SCHEMA_VERSION,
                "run_id": run_id,
                "operation": operation,
                "status": RUNNING,
                "started_at": utcnow(),
                "updated_at": utcnow(),
                "tenant": tenant,
                "integration": integration,
                "environment": environment,
                "base_url": base_url,
                # The *name* of where credentials come from. Never a value.
                "credential_source": credential_source,
                "steps": [],
                "knowledge_used": [],
                "stale_knowledge": [],
                "corrected_knowledge": [],
                "contradictions": [],
                "records": [],
                "external_changes": [],
                "human_action_required": [],
                "resumes": 0,
                "notes": [],
                "step_names": list(steps or STEPS),
                "precondition_steps": sorted(
                    precondition_steps
                    if precondition_steps is not None
                    else PRECONDITION_STEPS
                ),
            },
            steps=steps,
            precondition_steps=precondition_steps,
        )
        ledger.save()
        return ledger

    @classmethod
    def open(
        cls,
        path: Path | str,
        *,
        steps: tuple[str, ...] | None = None,
        precondition_steps: frozenset[str] | None = None,
    ) -> "RunLedger":
        path = Path(path)
        state = path / "state.json"
        if not state.exists():
            raise FileNotFoundError(f"no run ledger at {state}")
        return cls(
            path,
            json.loads(state.read_text(encoding="utf-8")),
            steps=steps,
            precondition_steps=precondition_steps,
        )

    @classmethod
    def find(
        cls,
        root: Path | str,
        run_id: str,
        *,
        steps: tuple[str, ...] | None = None,
        precondition_steps: frozenset[str] | None = None,
    ) -> "RunLedger":
        return cls.open(
            Path(root) / "operations" / run_id,
            steps=steps, precondition_steps=precondition_steps,
        )

    @staticmethod
    def list_runs(root: Path | str) -> list[str]:
        directory = Path(root) / "operations"
        if not directory.is_dir():
            return []
        return sorted(
            d.name for d in directory.iterdir() if (d / "state.json").exists()
        )

    # -- paths ------------------------------------------------------------
    @property
    def state_path(self) -> Path:
        return self.path / "state.json"

    @property
    def evidence(self) -> Path:
        directory = self.path / "evidence"
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    @property
    def run_id(self) -> str:
        return str(self.data.get("run_id", self.path.name))

    @property
    def status(self) -> str:
        return str(self.data.get("status", RUNNING))

    # -- persistence ------------------------------------------------------
    def save(self) -> Path:
        """Write the ledger atomically, after screening it for secrets."""
        from awe_knowledge.evidence import reject_secrets

        self.data["updated_at"] = utcnow()
        payload = json.dumps(self.data, indent=2, sort_keys=True) + "\n"
        reject_secrets(self.data, context=f"run ledger {self.run_id}")
        self.path.mkdir(parents=True, exist_ok=True)
        handle = tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=str(self.path), delete=False
        )
        try:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        finally:
            handle.close()
        os.replace(handle.name, self.state_path)
        return self.state_path

    # -- steps ------------------------------------------------------------
    def completed_steps(self) -> list[str]:
        return [str(s["step"]) for s in self.data.get("steps", [])]

    def has(self, step: str) -> bool:
        return step in self.completed_steps()

    def checkpoint(self, step: str, detail: str = "", **data: Any) -> Checkpoint:
        """Record a step as verified, and make it durable before returning.

        The save happens inside this call on purpose: a caller that
        checkpointed and then crashed must still find the checkpoint.
        """
        if step not in self.steps:
            raise ValueError(f"{step!r} is not a step of this operation")
        mark = Checkpoint(step=step, at=utcnow(), detail=detail, data=data)
        # Re-running a step (a resume re-establishing a session) replaces its
        # checkpoint rather than appending a second one.
        self.data["steps"] = [
            s for s in self.data.get("steps", []) if s.get("step") != step
        ] + [mark.to_dict()]
        self.data["steps"].sort(key=lambda s: self.steps.index(s["step"]))
        self.save()
        return mark

    def next_step(self) -> str | None:
        """The first step this run has not verified yet."""
        done = set(self.completed_steps())
        for step in self.steps:
            if step not in done:
                return step
        return None

    def resume_point(self) -> str | None:
        """Where a resume starts: the first step that is not both done and durable.

        A precondition step is never skipped -- a browser session does not
        survive the process that held it -- but everything after the last
        durable checkpoint is what actually gets redone.
        """
        done = set(self.completed_steps())
        for step in self.steps:
            if step in self.precondition_steps or step not in done:
                return step
        return None

    def mark_resumed(self) -> None:
        self.data["resumes"] = int(self.data.get("resumes", 0)) + 1
        self.data["status"] = RUNNING
        self.save()

    # -- outcomes ---------------------------------------------------------
    def note(self, message: str) -> None:
        self.data.setdefault("notes", []).append({"at": utcnow(), "message": message})
        self.save()

    def used_knowledge(self, record_id: str, version: int, trust: str) -> None:
        entry = {"record_id": record_id, "version": version, "trust": trust}
        if entry not in self.data.setdefault("knowledge_used", []):
            self.data["knowledge_used"].append(entry)
        self.save()

    def record_contradiction(self, contradiction: dict[str, Any]) -> Path:
        """Keep structured contradiction evidence beside the run, durably."""
        self.data.setdefault("contradictions", []).append(contradiction)
        stale = self.data.setdefault("stale_knowledge", [])
        entry = {
            "record_id": contradiction.get("record_id", ""),
            "version": contradiction.get("believed_version", 0),
            "trust_before": contradiction.get("trust_before", ""),
            "trust_after": contradiction.get("trust_after", ""),
        }
        if entry not in stale:
            stale.append(entry)
        safe_name = str(contradiction.get("record_id", "record")).replace(":", "-")
        path = self.path / f"contradiction-{safe_name}.json"
        path.write_text(
            json.dumps(contradiction, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        self.save()
        return path

    def record_correction(self, record_id: str, version: int, trust: str,
                          supersedes: str = "") -> None:
        entry = {
            "record_id": record_id,
            "version": version,
            "trust": trust,
            "supersedes": supersedes,
        }
        corrections = self.data.setdefault("corrected_knowledge", [])
        if entry not in corrections:
            corrections.append(entry)
        self.save()

    def escalate(self, what: str) -> None:
        actions = self.data.setdefault("human_action_required", [])
        if what not in actions:
            actions.append(what)
        self.data["status"] = ESCALATED
        self.save()

    def fail(self, why: str) -> None:
        self.data["status"] = FAILED
        self.note(why)

    def interrupt(self, why: str) -> None:
        self.data["status"] = INTERRUPTED
        self.note(why)

    def complete(self) -> None:
        self.data["status"] = COMPLETED
        self.save()

    def resume_command(self) -> str:
        return f"python -m awe_tegg resume --run-id {self.run_id}"
