"""The job workspace: one directory per report, with a manifest that survives.

Every run writes into ``work/jobs/<job-id>/`` and records what it did in
``manifest.json``. The manifest is the resume point *and* the audit trail, so
it is written after every state change rather than at the end -- a run that
dies partway through must leave behind enough to carry on from, not a folder of
files nobody can account for.

Nothing here touches the network or a browser, which keeps it fully testable.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 2
MANIFEST_NAME = "manifest.json"

# Document lifecycle.
PENDING = "pending"
DOWNLOADED = "downloaded"
CONVERTED = "converted"
VERIFIED = "verified"
FAILED = "failed"
UNAVAILABLE = "unavailable"
SKIPPED = "skipped"

# States that mean "already done, do not fetch again on resume".
SETTLED = {DOWNLOADED, CONVERTED, VERIFIED}

SUBDIRS = ("source", "converted", "output", "evidence", "logs")


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def checksum(path: Path) -> str:
    """SHA-256 of a file, so a re-download can be proven identical."""
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(131072), b""):
            digest.update(block)
    return digest.hexdigest()


_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")


def slugify(value: str, fallback: str = "job") -> str:
    """Make a value safe as a single path component."""
    cleaned = _UNSAFE.sub("-", str(value)).strip("-.")
    return cleaned or fallback


def make_job_id(site_visit: str, customer: str = "", when: str | None = None) -> str:
    """A stable, human-readable job id.

    The site visit identifier leads because that is what the operator actually
    has in hand, and it is what makes a resume unambiguous.
    """
    parts = [slugify(site_visit, "visit")]
    if customer:
        parts.append(slugify(customer)[:32])
    stamp = (when or utcnow())[:10].replace("-", "")
    parts.append(stamp)
    return "-".join(p for p in parts if p)


@dataclass
class DocumentRecord:
    """One required document's journey from the portal to the merge."""

    required_type: str
    status: str = PENDING
    discovered_name: str = ""
    source_filename: str = ""
    local_path: str = ""
    downloaded_at: str = ""
    checksum: str = ""
    conversion_status: str = ""
    converted_path: str = ""
    validation: str = ""
    pages: int | None = None
    failure_reason: str = ""
    portal_url: str = ""
    evidence: list[str] = field(default_factory=list)

    @property
    def settled(self) -> bool:
        return self.status in SETTLED

    def to_dict(self) -> dict[str, Any]:
        return {
            "required_type": self.required_type,
            "status": self.status,
            "discovered_name": self.discovered_name,
            "source_filename": self.source_filename,
            "local_path": self.local_path,
            "downloaded_at": self.downloaded_at,
            "checksum": self.checksum,
            "conversion_status": self.conversion_status,
            "converted_path": self.converted_path,
            "validation": self.validation,
            "pages": self.pages,
            "failure_reason": self.failure_reason,
            "portal_url": self.portal_url,
            "evidence": list(self.evidence),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "DocumentRecord":
        known = {f for f in cls.__dataclass_fields__}
        return cls(**{k: v for k, v in data.items() if k in known})


class Workspace:
    """A job folder plus its manifest."""

    def __init__(self, path: Path, data: dict[str, Any] | None = None) -> None:
        self.path = Path(path)
        self.data: dict[str, Any] = data if data is not None else {}

    # -- lifecycle --------------------------------------------------------
    @classmethod
    def create(
        cls,
        root: Path,
        job_id: str,
        *,
        customer: str = "",
        site: str = "",
        site_visit: str = "",
        site_visit_label: str = "",
        site_visit_url: str = "",
        portal_base_url: str = "",
    ) -> "Workspace":
        """Create (or reopen) a job workspace. Reopening never loses history."""
        path = Path(root) / "jobs" / slugify(job_id)
        existing = path / MANIFEST_NAME
        if existing.exists():
            workspace = cls.open(path)
            workspace.touch()
            return workspace

        path.mkdir(parents=True, exist_ok=True)
        for sub in SUBDIRS:
            (path / sub).mkdir(exist_ok=True)

        workspace = cls(
            path,
            {
                "schema_version": SCHEMA_VERSION,
                "job_id": job_id,
                "created_at": utcnow(),
                "updated_at": utcnow(),
                "customer": customer,
                "site": site,
                "site_visit": {
                    "identifier": site_visit,
                    "label": site_visit_label,
                    "url": site_visit_url,
                },
                "portal": {"base_url": portal_base_url},
                "documents": {},
                "events": [],
                "build": {},
                "review_required": True,
                "review_reasons": [],
            },
        )
        workspace.save()
        return workspace

    @classmethod
    def open(cls, path: Path) -> "Workspace":
        path = Path(path)
        manifest = path / MANIFEST_NAME
        if not manifest.exists():
            raise FileNotFoundError(f"no manifest in {path}")
        data = json.loads(manifest.read_text(encoding="utf-8"))
        for sub in SUBDIRS:
            (path / sub).mkdir(exist_ok=True)
        return cls(path, data)

    @classmethod
    def find(cls, root: Path, job_id: str) -> "Workspace":
        return cls.open(Path(root) / "jobs" / slugify(job_id))

    @staticmethod
    def list_jobs(root: Path) -> list[str]:
        jobs = Path(root) / "jobs"
        if not jobs.is_dir():
            return []
        return sorted(
            d.name for d in jobs.iterdir() if (d / MANIFEST_NAME).exists()
        )

    # -- paths ------------------------------------------------------------
    @property
    def source(self) -> Path:
        return self.path / "source"

    @property
    def converted(self) -> Path:
        return self.path / "converted"

    @property
    def output(self) -> Path:
        return self.path / "output"

    @property
    def evidence(self) -> Path:
        return self.path / "evidence"

    @property
    def logs(self) -> Path:
        return self.path / "logs"

    @property
    def manifest_path(self) -> Path:
        return self.path / MANIFEST_NAME

    @property
    def job_id(self) -> str:
        return self.data.get("job_id", self.path.name)

    # -- persistence ------------------------------------------------------
    def save(self) -> Path:
        self.data["updated_at"] = utcnow()
        self.path.mkdir(parents=True, exist_ok=True)
        # Write via a temp file so an interrupted save cannot truncate the
        # manifest and strand the job.
        tmp = self.manifest_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(self.data, indent=2) + "\n", encoding="utf-8")
        tmp.replace(self.manifest_path)
        return self.manifest_path

    def touch(self) -> None:
        self.save()

    # -- documents --------------------------------------------------------
    def record(self, required_type: str) -> DocumentRecord:
        raw = self.data.setdefault("documents", {}).get(required_type)
        if raw is None:
            return DocumentRecord(required_type=required_type)
        return DocumentRecord.from_dict(raw)

    def put(self, record: DocumentRecord) -> None:
        self.data.setdefault("documents", {})[record.required_type] = record.to_dict()
        self.save()

    def records(self) -> list[DocumentRecord]:
        return [
            DocumentRecord.from_dict(v)
            for v in self.data.get("documents", {}).values()
        ]

    def needs(self, required_type: str, force: bool = False) -> bool:
        """Whether this document still has to be fetched.

        This is the whole of the resume rule: a document that is settled and
        whose file is still on disk is not fetched again unless forced.
        """
        if force:
            return True
        record = self.record(required_type)
        if not record.settled:
            return True
        if not record.local_path:
            return True
        return not (self.path / record.local_path).exists()

    def mark_downloaded(
        self,
        required_type: str,
        path: Path,
        *,
        discovered_name: str = "",
        portal_url: str = "",
    ) -> DocumentRecord:
        path = Path(path)
        record = self.record(required_type)
        record.status = DOWNLOADED
        record.discovered_name = discovered_name or record.discovered_name
        record.source_filename = path.name
        record.local_path = self.relative(path)
        record.downloaded_at = utcnow()
        record.checksum = checksum(path)
        record.failure_reason = ""
        record.portal_url = portal_url or record.portal_url
        self.put(record)
        return record

    def mark_failed(
        self, required_type: str, reason: str, *, status: str = FAILED,
        evidence: list[str] | None = None,
    ) -> DocumentRecord:
        record = self.record(required_type)
        record.status = status
        record.failure_reason = reason
        if evidence:
            record.evidence.extend(evidence)
        self.put(record)
        return record

    def relative(self, path: Path) -> str:
        """Store paths relative to the job folder so it can be moved."""
        path = Path(path)
        try:
            return str(path.resolve().relative_to(self.path.resolve()))
        except ValueError:
            return str(path)

    def resolve(self, relative: str) -> Path:
        candidate = Path(relative)
        return candidate if candidate.is_absolute() else self.path / candidate

    # -- review + events --------------------------------------------------
    def require_review(self, reason: str) -> None:
        self.data["review_required"] = True
        reasons = self.data.setdefault("review_reasons", [])
        if reason not in reasons:
            reasons.append(reason)
        self.save()

    def log_event(self, kind: str, message: str, **extra: Any) -> None:
        self.data.setdefault("events", []).append(
            {"at": utcnow(), "kind": kind, "message": message, **extra}
        )
        self.save()

    # -- reporting --------------------------------------------------------
    def summary(self) -> str:
        visit = self.data.get("site_visit", {})
        lines = [
            f"job          {self.job_id}",
            f"customer     {self.data.get('customer') or '(unknown)'}",
            f"site         {self.data.get('site') or '(unknown)'}",
            f"site visit   {visit.get('identifier') or '(unknown)'}"
            + (f"  [{visit.get('label')}]" if visit.get("label") else ""),
            f"folder       {self.path}",
            "",
            "documents",
        ]
        documents = self.data.get("documents", {})
        if not documents:
            lines.append("  (none recorded yet)")
        for key, raw in documents.items():
            record = DocumentRecord.from_dict(raw)
            detail = record.source_filename or record.failure_reason or ""
            lines.append(f"  {record.status:<12} {key:<28} {detail}")
        build = self.data.get("build") or {}
        if build:
            lines += [
                "",
                f"build        {build.get('status', 'unknown')}"
                f"  {build.get('output', '')}"
                + (f"  ({build['pages']}p)" if build.get("pages") else ""),
            ]
        if self.data.get("review_required"):
            lines += ["", "HUMAN REVIEW REQUIRED"]
            for reason in self.data.get("review_reasons", []):
                lines.append(f"  - {reason}")
        return "\n".join(lines)
