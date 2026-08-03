"""The loop a live run actually drives.

This is where the pieces meet: a run opens the store, uses what is already
verified, notices when a piece of it stopped working, repairs *only* that
piece, and closes with a report of what changed and why.

The shape of one run::

    run = KnowledgeRun(store, "lippolis", "tegg-pro", "production",
                       execution_id="2026-07-31T…", clock=clock)
    run.open()                                  # load, validate, expire
    outcome = run.resolve("selector:login.username",
                          attempt=lambda payload: driver.fill(payload),
                          discover=lambda: driver.find_username_field())
    report = run.close(note="live login")

Three properties matter more than convenience:

  * **nothing is rediscovered that still works.** ``resolve`` only calls
    ``discover`` after the stored knowledge was tried and failed.
  * **failure is isolated.** One selector failing degrades one record. The
    other records in the document are untouched.
  * **time is injected.** Every timestamp comes from ``clock``, so a replay
    with a fixed clock produces a byte-identical document.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable

from .evidence import build_evidence
from .lifecycle import Contradiction, expire, propose_change, supersede
from .models import (
    EvidenceRef,
    KnowledgeDocument,
    KnowledgeError,
    KnowledgeRecord,
    RecordKind,
    TenantMismatch,
    TrustLevel,
)
from .promotion import TrustChange, record_failure, record_success
from .store import KnowledgeStore
from .validator import (
    DEFAULT_MAX_AGE_DAYS,
    ValidationReport,
    is_stale,
    validate_document,
    validate_record,
)


def utc_clock() -> str:
    """Wall-clock time, ISO-8601, UTC. Replaced by a fixed clock in tests."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass
class Resolution:
    """How one piece of knowledge was obtained during a run."""

    record_id: str
    #: verified | candidate | rediscovered | unusable | failed | absent
    source: str
    ok: bool
    payload: dict[str, Any] = field(default_factory=dict)
    detail: str = ""
    rediscovered: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class KnowledgeChangeReport:
    """What a run learned, in a form a human or a CI job can read."""

    tenant: str = ""
    integration: str = ""
    environment: str = ""
    execution_id: str = ""
    opened_at: str = ""
    closed_at: str = ""
    document_version: int = 0
    loaded_records: int = 0
    used: list[str] = field(default_factory=list)
    rediscovered: list[str] = field(default_factory=list)
    changes: list[dict[str, Any]] = field(default_factory=list)
    contradictions: list[dict[str, Any]] = field(default_factory=list)
    pending_approval: list[str] = field(default_factory=list)
    stale: list[str] = field(default_factory=list)
    expired: list[str] = field(default_factory=list)
    validation: dict[str, Any] = field(default_factory=dict)
    saved_to: str = ""
    note: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @property
    def learned_anything(self) -> bool:
        return bool(self.changes or self.contradictions or self.pending_approval)


class KnowledgeRun:
    """One execution's session against one tenant's knowledge document."""

    def __init__(
        self,
        store: KnowledgeStore,
        tenant: str,
        integration: str,
        environment: str,
        *,
        execution_id: str,
        clock: Callable[[], str] = utc_clock,
        allow_candidate: bool = False,
        max_age_days: int = DEFAULT_MAX_AGE_DAYS,
        artifact_root: Path | str | None = None,
    ) -> None:
        self.store = store
        self.tenant = tenant
        self.integration = integration
        self.environment = environment
        self.execution_id = execution_id
        self.clock = clock
        self.allow_candidate = allow_candidate
        self.max_age_days = max_age_days
        self.artifact_root = Path(artifact_root) if artifact_root else None
        self.document: KnowledgeDocument | None = None
        self.report = KnowledgeChangeReport(
            tenant=tenant,
            integration=integration,
            environment=environment,
            execution_id=execution_id,
        )
        self._changes: list[TrustChange] = []

    # -- opening ----------------------------------------------------------
    def open(self, *, base_url: str = "", strict: bool = True) -> ValidationReport:
        """Load the document, check it, and age out anything past its date.

        ``strict`` refuses to run against a document that fails validation.
        A malformed store is a reason to stop, not a reason to improvise.
        """
        now = self.clock()
        document = self.store.load_or_create(
            self.tenant, self.integration, self.environment, base_url=base_url
        )
        if (document.tenant, document.integration, document.environment) != (
            self.tenant, self.integration, self.environment,
        ):
            raise TenantMismatch(
                f"loaded {document.tenant}/{document.integration}/"
                f"{document.environment} for {self.tenant}/{self.integration}/"
                f"{self.environment}"
            )
        report = validate_document(
            document, now=_parse(now), max_age_days=self.max_age_days
        )
        if strict and not report.ok:
            raise KnowledgeError(
                "knowledge document is not usable: " + "; ".join(report.problems)
            )

        self.document = document
        self.report.opened_at = now
        self.report.loaded_records = len(document.records)
        self.report.stale = list(report.stale)
        self.report.validation = report.to_dict()

        for change in expire(document, now_iso=now, reason="past its expiry date"):
            self._changes.append(change)
            self.report.expired.append(change.record_id)
        return report

    # -- retrieval --------------------------------------------------------
    def get(self, record_id: str) -> KnowledgeRecord | None:
        """The record, whether or not it is usable. Deterministic by id."""
        return self.document.get(record_id) if self.document else None

    def usable(self, record_id: str) -> KnowledgeRecord | None:
        """The record only if a run may act on it right now."""
        record = self.get(record_id)
        if record is None:
            return None
        if not record.usable(self.clock(), allow_candidate=self.allow_candidate):
            return None
        if is_stale(record, _parse(self.clock()), self.max_age_days):
            return None
        return record

    def applicable(
        self, *, kind: RecordKind | None = None, prefix: str = ""
    ) -> list[KnowledgeRecord]:
        """Every usable record matching a kind or id prefix, id-sorted.

        Sorted by id rather than by score: two runs asking the same question
        of the same document must get the same answer in the same order.
        """
        if self.document is None:
            return []
        found = [
            r
            for r in self.document.records.values()
            if (kind is None or r.kind is kind)
            and (not prefix or r.record_id.startswith(prefix))
            and self.usable(r.record_id) is not None
        ]
        return sorted(found, key=lambda r: r.record_id)

    # -- the loop ---------------------------------------------------------
    def resolve(
        self,
        record_id: str,
        *,
        attempt: Callable[[dict[str, Any]], bool],
        discover: Callable[[], dict[str, Any] | None] | None = None,
        artifacts: Iterable[Path | str] = (),
        url: str = "",
        kind: RecordKind | None = None,
        name: str = "",
    ) -> Resolution:
        """Use stored knowledge for one thing, and repair only that thing.

        Order is deliberate: try what is known first, and reach for
        rediscovery only once the known thing has actually failed. A run that
        rediscovers first learns nothing about whether its knowledge decayed.
        """
        record = self.usable(record_id)

        if record is not None:
            if self._try(record, attempt, artifacts=artifacts, url=url):
                self.report.used.append(record_id)
                return Resolution(
                    record_id, record.trust.value.lower(), True,
                    dict(record.payload), "stored knowledge worked",
                )
            # It failed. Degrade *this* record, and nothing else.
            if discover is None:
                return Resolution(
                    record_id, "failed", False, dict(record.payload),
                    "stored knowledge failed and no rediscovery was offered",
                )

        if discover is None:
            return Resolution(
                record_id, "absent" if record is None else "failed", False, {},
                "no usable knowledge and no rediscovery was offered",
            )

        discovered = discover()
        if not discovered:
            return Resolution(
                record_id, "failed", False, {}, "rediscovery found nothing",
            )

        now = self.clock()
        existing = self.get(record_id)
        if existing is None:
            existing = self._new_record(record_id, discovered, kind=kind, name=name)
        else:
            pending, contradictions = propose_change(
                self.document, existing, discovered,
                reason="rediscovered after the stored value failed",
                at=now, execution_id=self.execution_id,
                evidence=self._evidence(artifacts=artifacts, url=url),
            )
            self._note_contradictions(contradictions)
            if pending is not None:
                self.report.pending_approval.append(record_id)
                return Resolution(
                    record_id, "unusable", False, dict(discovered),
                    "rediscovery contradicts verified knowledge; held for approval",
                    rediscovered=True,
                )

        if not self._try(existing, attempt, artifacts=artifacts, url=url):
            return Resolution(
                record_id, "failed", False, dict(existing.payload),
                "rediscovered value did not work either", rediscovered=True,
            )
        self.report.rediscovered.append(record_id)
        return Resolution(
            record_id, "rediscovered", True, dict(existing.payload),
            "repaired by rediscovery", rediscovered=True,
        )

    def _try(
        self,
        record: KnowledgeRecord,
        attempt: Callable[[dict[str, Any]], bool],
        *,
        artifacts: Iterable[Path | str] = (),
        url: str = "",
    ) -> bool:
        """Run one attempt and record its outcome against the record."""
        now = self.clock()
        try:
            ok = bool(attempt(dict(record.payload)))
            detail = "" if ok else "attempt returned false"
        except Exception as error:                      # noqa: BLE001
            ok, detail = False, f"{type(error).__name__}: {error}"
        if ok:
            self.succeeded(record.record_id, artifacts=artifacts, url=url)
        else:
            self.failed(record.record_id, detail or "attempt failed", at=now)
        return ok

    # -- outcome measurement ----------------------------------------------
    def succeeded(
        self,
        record_id: str,
        *,
        artifacts: Iterable[Path | str] = (),
        url: str = "",
        note: str = "",
        observed_at: str = "",
    ) -> TrustChange | None:
        """Record that this knowledge worked.

        ``observed_at`` is when the *portal* was seen doing it, which is not
        the same as when this was written down -- evidence ingested from a
        file kept yesterday should say yesterday.
        """
        record = self.get(record_id)
        if record is None:
            return None
        change = record_success(
            record,
            self._evidence(artifacts=artifacts, url=url, note=note,
                           observed_at=observed_at),
            at=self.clock(),
        )
        return self._remember(change)

    def failed(
        self,
        record_id: str,
        reason: str,
        *,
        at: str = "",
        confirmed_incompatible: bool = False,
    ) -> TrustChange | None:
        record = self.get(record_id)
        if record is None:
            return None
        change = record_failure(
            record, reason, at=at or self.clock(),
            execution_id=self.execution_id,
            confirmed_incompatible=confirmed_incompatible,
        )
        return self._remember(change)

    # -- contradiction by the live world ----------------------------------
    def contradicted(
        self,
        record_id: str,
        *,
        field: str,
        believed: Any,
        observed: Any,
        reason: str,
        note: str = "",
        artifacts: Iterable[Path | str] = (),
        url: str = "",
    ) -> dict[str, Any]:
        """Record that the live system disagrees with what a record claims.

        ``propose_change`` handles the case where a run *rediscovers a
        different value*. This handles the other one: the value is still what
        the record says, and it no longer works. That is not a competing
        payload to queue for approval, it is evidence against the record
        itself, so it lands as a structured contradiction **and** as a failure,
        which is what moves the trust level down.

        Deliberately does the demotion exactly once. A caller that keeps
        retrying a dead route would otherwise keep charging failures against
        it, which is how a single bad afternoon writes off a whole document.
        """
        record = self.get(record_id)
        now = self.clock()
        # Captured before the demotion: what is contradicted is the version
        # that was *applied*, not the version the demotion leaves behind.
        before = record.trust.value if record is not None else ""
        believed_version = record.version if record is not None else 0
        evidence = self._evidence(artifacts=artifacts, url=url, note=note)

        entry = Contradiction(
            record_id=record_id,
            field=field,
            believed=believed,
            observed=observed,
            execution_id=self.execution_id,
            at=now,
            note=note or reason,
        )
        self._note_contradictions([entry])

        change = None
        if record is not None and record.last_failure_execution != self.execution_id:
            change = self.failed(record_id, reason, at=now)

        return {
            "record_id": record_id,
            "field": field,
            "believed": believed,
            "believed_version": believed_version,
            "observed": observed,
            "reason": entry.to_dict()["note"],
            "execution_id": self.execution_id,
            "at": now,
            "trust_before": before,
            "trust_after": record.trust.value if record is not None else "",
            "demoted": change is not None,
            "evidence": evidence.to_dict(),
        }

    # -- replacing knowledge ----------------------------------------------
    def replace(
        self,
        old_id: str,
        *,
        kind: RecordKind,
        name: str,
        payload: dict[str, Any],
        reason: str,
        note: str = "",
    ) -> KnowledgeRecord:
        """Put a newly discovered procedure in place of one that stopped holding.

        The replacement enters at DISCOVERED like any other observation and
        earns its way up through the usual thresholds -- superseding something
        is not a shortcut to being trusted. What supersession *does* settle is
        which record is the live one and which is history: the old record is
        kept, marked INVALID, and linked to its replacement in both directions.

        Refuses a replacement that is not well formed. A record nothing can
        validate is worse than the stale one it would replace, because the
        stale one at least records what used to be true.
        """
        if self.document is None:
            raise KnowledgeError("replace() needs an open run")
        now = self.clock()
        record_id = KnowledgeRecord.make_id(kind, name)
        existing = self.get(record_id)

        if existing is None:
            record = self._new_record(
                record_id, payload, kind=kind, name=name, note=note or reason
            )
        else:
            record = existing
            pending, contradictions = propose_change(
                self.document, record, payload,
                reason=reason, at=now, execution_id=self.execution_id,
                evidence=self._evidence(note=note),
            )
            self._note_contradictions(contradictions)
            if pending is not None:
                self.report.pending_approval.append(record_id)
                return record

        problems = validate_record(record)
        if problems:
            raise KnowledgeError(
                f"refusing to supersede {old_id} with {record_id}: "
                + "; ".join(problems)
            )

        old = self.get(old_id)
        if old is not None and old.superseded_by != record_id:
            change = supersede(
                self.document, old_id, record,
                reason=reason, at=now, execution_id=self.execution_id,
            )
            self._remember(change)
        return record

    # -- capture ----------------------------------------------------------
    def observe(
        self,
        kind: RecordKind,
        name: str,
        payload: dict[str, Any],
        *,
        note: str = "",
        expires_at: str = "",
        approval_required: bool = False,
    ) -> KnowledgeRecord:
        """Write down something seen, at DISCOVERED. Never trusted on sight."""
        record_id = KnowledgeRecord.make_id(kind, name)
        existing = self.get(record_id)
        now = self.clock()
        if existing is not None:
            pending, contradictions = propose_change(
                self.document, existing, payload,
                reason=note or "observed during a run",
                at=now, execution_id=self.execution_id,
                evidence=self._evidence(note=note),
            )
            self._note_contradictions(contradictions)
            if pending is not None:
                self.report.pending_approval.append(record_id)
            return existing
        return self._new_record(
            record_id, payload, kind=kind, name=name, note=note,
            expires_at=expires_at, approval_required=approval_required,
        )

    def _new_record(
        self,
        record_id: str,
        payload: dict[str, Any],
        *,
        kind: RecordKind | None = None,
        name: str = "",
        note: str = "",
        expires_at: str = "",
        approval_required: bool = False,
    ) -> KnowledgeRecord:
        if kind is None or not name:
            derived_kind, _, derived_name = record_id.partition(":")
            kind = kind or RecordKind(derived_kind)
            name = name or derived_name
        now = self.clock()
        record = KnowledgeRecord(
            record_id=KnowledgeRecord.make_id(kind, name),
            kind=kind,
            name=name,
            tenant=self.tenant,
            integration=self.integration,
            environment=self.environment,
            payload=dict(payload),
            trust=TrustLevel.DISCOVERED,
            created_at=now,
            updated_at=now,
            notes=note,
            expires_at=expires_at,
            approval_required=approval_required,
        )
        self.document.put(record)
        self._changes.append(
            TrustChange(
                record_id=record.record_id, before="", after=TrustLevel.DISCOVERED.value,
                reason=note or "first observation", execution_id=self.execution_id,
                at=now,
            )
        )
        return record

    # -- closing ----------------------------------------------------------
    def close(self, *, note: str = "", save: bool = True) -> KnowledgeChangeReport:
        """Persist what changed and hand back the report."""
        now = self.clock()
        self.report.closed_at = now
        self.report.note = note
        self.report.changes = [c.to_dict() for c in self._changes]
        if self.document is None:
            return self.report
        self.report.pending_approval = sorted(set(self.report.pending_approval))
        if save:
            path = self.store.save(
                self.document, at=now, execution_id=self.execution_id,
                changes=self._changes, note=note,
            )
            self.report.saved_to = str(path)
        self.report.document_version = self.document.document_version
        return self.report

    # -- internals --------------------------------------------------------
    def _evidence(
        self,
        *,
        artifacts: Iterable[Path | str] = (),
        url: str = "",
        note: str = "",
        kind: str = "run",
        observed_at: str = "",
    ) -> EvidenceRef:
        paths = [
            (self.artifact_root / a if self.artifact_root and not Path(a).is_absolute()
             else Path(a))
            for a in artifacts
        ]
        return build_evidence(
            self.execution_id, observed_at or self.clock(), kind=kind, url=url,
            artifacts=paths, tenant=self.tenant, note=note,
        )

    def _remember(self, change: TrustChange | None) -> TrustChange | None:
        if change is not None:
            self._changes.append(change)
        return change

    def _note_contradictions(self, contradictions: list[Contradiction]) -> None:
        self.report.contradictions.extend(c.to_dict() for c in contradictions)


def _parse(iso: str) -> datetime:
    from .validator import parse_time

    return parse_time(iso) or datetime.now(timezone.utc)
