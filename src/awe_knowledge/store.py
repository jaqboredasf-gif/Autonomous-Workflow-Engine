"""Where operational knowledge lives on disk.

JSON, one document per tenant/integration/environment, with an append-only
JSONL history beside it. The format was chosen so that a change to what the
system believes shows up as a reviewable diff in a pull request rather than as
an opaque row in a database -- this is knowledge people are expected to argue
with.

The layout migrates cleanly to a central service later: the document is the
unit a service would serve, and the history is the event stream it would keep.

    data/operational_knowledge/<tenant>/<integration>/<environment>/
        knowledge.json     the current document
        history.jsonl      every save, with what changed and why
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any, Iterable

from .evidence import reject_secrets
from .models import (
    KnowledgeDocument,
    KnowledgeError,
    SCHEMA_VERSION,
    TenantMismatch,
)

DEFAULT_ROOT = Path(__file__).resolve().parents[2] / "data" / "operational_knowledge"


def _slug(value: str) -> str:
    """A path-safe form of a tenant or integration name."""
    safe = "".join(c if c.isalnum() or c in "-_" else "-" for c in value.strip())
    safe = "-".join(part for part in safe.split("-") if part)
    if not safe:
        raise KnowledgeError(f"{value!r} is not a usable tenant/integration name")
    return safe.lower()


class KnowledgeStore:
    """Reads and writes knowledge documents, and refuses unsafe writes."""

    def __init__(self, root: Path | str | None = None) -> None:
        self.root = Path(root) if root else DEFAULT_ROOT

    # -- locations --------------------------------------------------------
    def directory_for(self, tenant: str, integration: str, environment: str) -> Path:
        return self.root / _slug(tenant) / _slug(integration) / _slug(environment)

    def path_for(self, tenant: str, integration: str, environment: str) -> Path:
        return self.directory_for(tenant, integration, environment) / "knowledge.json"

    def history_path(self, tenant: str, integration: str, environment: str) -> Path:
        return self.directory_for(tenant, integration, environment) / "history.jsonl"

    def exists(self, tenant: str, integration: str, environment: str) -> bool:
        return self.path_for(tenant, integration, environment).exists()

    # -- reading ----------------------------------------------------------
    def load(self, tenant: str, integration: str, environment: str) -> KnowledgeDocument:
        path = self.path_for(tenant, integration, environment)
        if not path.exists():
            raise KnowledgeError(
                f"no knowledge for {tenant}/{integration}/{environment} at {path}"
            )
        raw = json.loads(path.read_text(encoding="utf-8"))
        document = KnowledgeDocument.from_dict(raw)
        # The tenant boundary is enforced on read, not filtered afterwards.
        if (document.tenant, document.integration, document.environment) != (
            tenant, integration, environment,
        ):
            raise TenantMismatch(
                f"{path} holds {document.tenant}/{document.integration}/"
                f"{document.environment}, not {tenant}/{integration}/{environment}"
            )
        return document

    def load_or_create(
        self, tenant: str, integration: str, environment: str, base_url: str = ""
    ) -> KnowledgeDocument:
        """Load the document, or start an empty one *only* if there is no file.

        The condition is deliberately "the file does not exist" rather than
        "loading raised something". Every other reason a load fails -- the
        document belongs to another tenant, it was written by a newer schema,
        a hand-edit corrupted a record -- describes a file that *is* there and
        holds something. Answering any of those with a fresh empty document
        hands the caller that slot, and the run's own save then overwrites
        whatever was in it. That is silent data loss dressed up as recovery,
        and it is worse than refusing.
        """
        if self.exists(tenant, integration, environment):
            return self.load(tenant, integration, environment)
        return KnowledgeDocument(
            tenant=tenant,
            integration=integration,
            environment=environment,
            base_url=base_url,
            schema_version=SCHEMA_VERSION,
        )

    def documents(self) -> list[tuple[str, str, str]]:
        """Every (tenant, integration, environment) the store holds."""
        found: list[tuple[str, str, str]] = []
        if not self.root.exists():
            return found
        for path in sorted(self.root.glob("*/*/*/knowledge.json")):
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                continue
            found.append((raw.get("tenant", ""), raw.get("integration", ""),
                          raw.get("environment", "")))
        return found

    # -- writing ----------------------------------------------------------
    def save(
        self,
        document: KnowledgeDocument,
        *,
        at: str,
        execution_id: str = "",
        changes: Iterable[Any] = (),
        note: str = "",
    ) -> Path:
        """Write the document, atomically, after screening it for secrets."""
        document.document_version += 1
        document.updated_at = at
        payload = document.to_dict()
        reject_secrets(payload, context=f"{document.tenant}/{document.integration}")

        directory = self.directory_for(
            document.tenant, document.integration, document.environment
        )
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / "knowledge.json"
        _atomic_write(path, json.dumps(payload, indent=2, sort_keys=True) + "\n")

        entry = {
            "at": at,
            "execution_id": execution_id,
            "document_version": document.document_version,
            "schema_version": document.schema_version,
            "note": note,
            "changes": [
                c.to_dict() if hasattr(c, "to_dict") else dict(c) for c in changes
            ],
        }
        with (directory / "history.jsonl").open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, sort_keys=True) + "\n")
        return path

    def history(
        self, tenant: str, integration: str, environment: str, limit: int = 0
    ) -> list[dict[str, Any]]:
        path = self.history_path(tenant, integration, environment)
        if not path.exists():
            return []
        entries = [
            json.loads(line)
            for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        return entries[-limit:] if limit else entries


def _atomic_write(path: Path, text: str) -> None:
    """Write via a temporary file so a crash cannot truncate knowledge."""
    handle = tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=str(path.parent), delete=False
    )
    try:
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())
    finally:
        handle.close()
    os.replace(handle.name, path)
