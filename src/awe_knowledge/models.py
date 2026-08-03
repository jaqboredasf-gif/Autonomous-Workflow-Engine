"""The record types an operational knowledge store is made of.

Everything here is data with no I/O, so a record can be built, validated and
reasoned about in a test without a store, a browser or a portal.

Two rules the model holds to:

  * A record carries its own trust level, its own evidence and its own
    history. Trust is never inferred from context at read time.
  * Nothing here generates a timestamp. Time arrives from the caller, which
    is what makes a replay deterministic.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from enum import Enum
from typing import Any

SCHEMA_VERSION = 1


def read_time(value: str) -> datetime | None:
    """An ISO-8601 stamp as an aware datetime, or None if it is unreadable.

    Times arrive from the caller, from disk and from other tools, so both
    ``Z`` and ``+00:00`` have to work, and a naive stamp is read as UTC
    rather than rejected.
    """
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


class TrustLevel(str, Enum):
    """How far a record may be trusted by a run that did not discover it.

    Trust is the *epistemic* axis and answers "how sure are we":

        DISCOVERED  an observation -- something a run saw once
        CANDIDATE   a hypothesis   -- it worked once, with evidence
        VERIFIED    a fact         -- distinct runs keep confirming it
        DEGRADED    a fact that stopped holding
        INVALID     written off

    ``RecordKind`` is the orthogonal *subject* axis (a selector, a procedure,
    a policy, a failure lesson). A policy can be a hypothesis; a selector can
    be a fact. The two axes are never collapsed.
    """

    DISCOVERED = "DISCOVERED"
    CANDIDATE = "CANDIDATE"
    VERIFIED = "VERIFIED"
    DEGRADED = "DEGRADED"
    INVALID = "INVALID"

    @property
    def usable_without_exploration(self) -> bool:
        return self is TrustLevel.VERIFIED

    @property
    def usable_with_validation(self) -> bool:
        return self in (TrustLevel.VERIFIED, TrustLevel.CANDIDATE)

    @property
    def needs_rediscovery(self) -> bool:
        return self in (TrustLevel.DEGRADED, TrustLevel.INVALID)


class RecordKind(str, Enum):
    """What a record is *about*, independent of how far it is trusted."""

    INTEGRATION = "integration"
    AUTH = "auth"
    NAVIGATION = "navigation"
    SELECTOR = "selector"
    PROCEDURE = "procedure"
    #: A standing rule a run must obey (safety limits, read-only boundaries).
    #: Policies are written by people, so they are never auto-promoted.
    POLICY = "policy"
    #: A failure lesson: what went wrong, why, and what repaired it.
    FAILURE = "failure"


class SelectorStatus(str, Enum):
    """A selector's own status, which mirrors but does not replace trust."""

    CANDIDATE = "candidate"
    VERIFIED = "verified"
    DEGRADED = "degraded"
    INVALID = "invalid"


@dataclass(frozen=True)
class EvidenceRef:
    """What proves a record. A promotion without one of these is refused."""

    execution_id: str
    observed_at: str
    kind: str = "run"
    url: str = ""
    artifacts: list[str] = field(default_factory=list)
    commit: str = ""
    code_version: str = ""
    tenant: str = ""
    note: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "EvidenceRef":
        known = {f for f in cls.__dataclass_fields__}
        return cls(**{k: v for k, v in raw.items() if k in known})


@dataclass
class KnowledgeRecord:
    """One durable operational fact, with its trust, evidence and history.

    ``payload`` holds the kind-specific detail -- a selector's fallbacks, a
    navigation path's steps, a procedure's ordered steps. It is deliberately
    open: the store is schema-versioned, and a new kind of fact should not
    require a migration to be written down.
    """

    record_id: str
    kind: RecordKind
    name: str
    tenant: str
    integration: str
    environment: str
    payload: dict[str, Any] = field(default_factory=dict)
    trust: TrustLevel = TrustLevel.DISCOVERED
    version: int = 1
    success_count: int = 0
    failure_count: int = 0
    consecutive_failures: int = 0
    verified_by_runs: list[str] = field(default_factory=list)
    evidence: list[EvidenceRef] = field(default_factory=list)
    created_at: str = ""
    updated_at: str = ""
    last_success: str = ""
    last_failure: str = ""
    #: Which execution reported the last failure. Invalidation counts failures
    #: across *distinct* executions, for the same reason promotion counts
    #: successes that way: one bad run is one opinion.
    last_failure_execution: str = ""
    last_verified: str = ""
    notes: str = ""
    previous_good: dict[str, Any] | None = None
    #: Set when a newer record replaced this one. A superseded record is kept,
    #: never deleted -- the history of what we used to believe is the point.
    superseded_by: str = ""
    #: The record this one replaced, if any.
    supersedes: str = ""
    #: Hard expiry. Past this instant the record is not usable at any trust
    #: level until a run re-confirms it. Empty means "age out on the default
    #: staleness rule instead".
    expires_at: str = ""
    #: True when a human (or an approving policy) must sign off before this
    #: record may be used unattended, whatever its trust level.
    approval_required: bool = False
    #: Who approved it, and when. Empty while approval is outstanding.
    approved_by: str = ""
    approved_at: str = ""

    # -- identity ---------------------------------------------------------
    @staticmethod
    def make_id(kind: RecordKind | str, name: str) -> str:
        kind_value = kind.value if isinstance(kind, RecordKind) else str(kind)
        return f"{kind_value}:{name}"

    def belongs_to(self, tenant: str, integration: str, environment: str) -> bool:
        return (
            self.tenant == tenant
            and self.integration == integration
            and self.environment == environment
        )

    # -- history ----------------------------------------------------------
    def snapshot(self) -> dict[str, Any]:
        """A copy of this record as it stands, for last-known-good storage."""
        raw = self.to_dict()
        raw.pop("previous_good", None)
        return raw

    def remember_good(self) -> None:
        """Keep the current state as the one to fall back to."""
        self.previous_good = self.snapshot()

    def restore_good(self) -> bool:
        """Return to the last known good state. False if there is none."""
        if not self.previous_good:
            return False
        restored = KnowledgeRecord.from_dict(copy.deepcopy(self.previous_good))
        keep_previous = self.previous_good
        for name in self.__dataclass_fields__:
            if name == "previous_good":
                continue
            setattr(self, name, getattr(restored, name))
        self.previous_good = keep_previous
        self.version += 1
        return True

    # -- serialisation ----------------------------------------------------
    def to_dict(self) -> dict[str, Any]:
        return {
            "record_id": self.record_id,
            "kind": self.kind.value,
            "name": self.name,
            "tenant": self.tenant,
            "integration": self.integration,
            "environment": self.environment,
            "payload": copy.deepcopy(self.payload),
            "trust": self.trust.value,
            "version": self.version,
            "success_count": self.success_count,
            "failure_count": self.failure_count,
            "consecutive_failures": self.consecutive_failures,
            "verified_by_runs": list(self.verified_by_runs),
            "evidence": [e.to_dict() for e in self.evidence],
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "last_success": self.last_success,
            "last_failure": self.last_failure,
            "last_failure_execution": self.last_failure_execution,
            "last_verified": self.last_verified,
            "notes": self.notes,
            "previous_good": copy.deepcopy(self.previous_good),
            "superseded_by": self.superseded_by,
            "supersedes": self.supersedes,
            "expires_at": self.expires_at,
            "approval_required": self.approval_required,
            "approved_by": self.approved_by,
            "approved_at": self.approved_at,
        }

    # -- usability --------------------------------------------------------
    @property
    def awaiting_approval(self) -> bool:
        return self.approval_required and not self.approved_by

    def is_expired(self, now_iso: str) -> bool:
        """True when a hard expiry has passed. Empty expiry never expires."""
        if not self.expires_at or not now_iso:
            return False
        now, expiry = read_time(now_iso), read_time(self.expires_at)
        if now is None or expiry is None:
            # An unreadable expiry is not a licence to keep using the record.
            return True
        return now >= expiry

    def usable(self, now_iso: str = "", *, allow_candidate: bool = False) -> bool:
        """Whether a run may act on this record right now.

        Four separate gates, all of which must pass: trust, supersession,
        expiry and approval. Any one of them alone is enough to refuse.
        """
        if self.superseded_by or self.awaiting_approval:
            return False
        if self.is_expired(now_iso):
            return False
        if self.trust is TrustLevel.VERIFIED:
            return True
        return allow_candidate and self.trust is TrustLevel.CANDIDATE

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "KnowledgeRecord":
        return cls(
            record_id=raw["record_id"],
            kind=RecordKind(raw["kind"]),
            name=raw["name"],
            tenant=raw["tenant"],
            integration=raw["integration"],
            environment=raw["environment"],
            payload=copy.deepcopy(raw.get("payload", {})),
            trust=TrustLevel(raw.get("trust", "DISCOVERED")),
            version=int(raw.get("version", 1)),
            success_count=int(raw.get("success_count", 0)),
            failure_count=int(raw.get("failure_count", 0)),
            consecutive_failures=int(raw.get("consecutive_failures", 0)),
            verified_by_runs=list(raw.get("verified_by_runs", [])),
            evidence=[EvidenceRef.from_dict(e) for e in raw.get("evidence", [])],
            created_at=raw.get("created_at", ""),
            updated_at=raw.get("updated_at", ""),
            last_success=raw.get("last_success", ""),
            last_failure=raw.get("last_failure", ""),
            last_failure_execution=raw.get("last_failure_execution", ""),
            last_verified=raw.get("last_verified", ""),
            notes=raw.get("notes", ""),
            previous_good=copy.deepcopy(raw.get("previous_good")),
            superseded_by=raw.get("superseded_by", ""),
            supersedes=raw.get("supersedes", ""),
            expires_at=raw.get("expires_at", ""),
            approval_required=bool(raw.get("approval_required", False)),
            approved_by=raw.get("approved_by", ""),
            approved_at=raw.get("approved_at", ""),
        )


@dataclass
class KnowledgeDocument:
    """Every record known about one integration, in one tenant, in one env.

    The tenant boundary is a property of the document, not a filter applied
    when reading: a document that does not match the caller's tenant is
    refused outright rather than returned empty.
    """

    tenant: str
    integration: str
    environment: str
    base_url: str = ""
    schema_version: int = SCHEMA_VERSION
    document_version: int = 1
    records: dict[str, KnowledgeRecord] = field(default_factory=dict)
    last_known_good: dict[str, Any] | None = None
    updated_at: str = ""
    #: Changes a run wanted to make but was not allowed to make on its own --
    #: contradictions of verified knowledge, and anything a policy holds for
    #: human sign-off. Each entry is a plain dict so the queue survives a
    #: schema change to the thing being proposed.
    pending: list[dict[str, Any]] = field(default_factory=list)

    def put(self, record: KnowledgeRecord) -> None:
        if not record.belongs_to(self.tenant, self.integration, self.environment):
            raise TenantMismatch(
                f"record {record.record_id} belongs to "
                f"{record.tenant}/{record.integration}/{record.environment}, not "
                f"{self.tenant}/{self.integration}/{self.environment}"
            )
        self.records[record.record_id] = record

    def get(self, record_id: str) -> KnowledgeRecord | None:
        return self.records.get(record_id)

    def by_kind(self, kind: RecordKind) -> list[KnowledgeRecord]:
        return [r for r in self.records.values() if r.kind is kind]

    def by_trust(self, *levels: TrustLevel) -> list[KnowledgeRecord]:
        wanted = set(levels)
        return [r for r in self.records.values() if r.trust in wanted]

    def remember_good(self) -> None:
        """Snapshot the whole document as the state worth returning to."""
        self.last_known_good = {
            "document_version": self.document_version,
            "records": {k: v.snapshot() for k, v in self.records.items()},
        }

    def restore_good(self) -> bool:
        if not self.last_known_good:
            return False
        self.records = {
            k: KnowledgeRecord.from_dict(copy.deepcopy(v))
            for k, v in self.last_known_good["records"].items()
        }
        self.document_version += 1
        return True

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "tenant": self.tenant,
            "integration": self.integration,
            "environment": self.environment,
            "base_url": self.base_url,
            "document_version": self.document_version,
            "updated_at": self.updated_at,
            "records": {k: v.to_dict() for k, v in sorted(self.records.items())},
            "last_known_good": copy.deepcopy(self.last_known_good),
            "pending": copy.deepcopy(self.pending),
        }

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "KnowledgeDocument":
        schema_version = int(raw.get("schema_version", 0))
        if schema_version != SCHEMA_VERSION:
            raise SchemaMismatch(
                f"knowledge document is schema version {schema_version}, "
                f"this code speaks version {SCHEMA_VERSION}"
            )
        document = cls(
            tenant=raw["tenant"],
            integration=raw["integration"],
            environment=raw["environment"],
            base_url=raw.get("base_url", ""),
            schema_version=schema_version,
            document_version=int(raw.get("document_version", 1)),
            updated_at=raw.get("updated_at", ""),
            last_known_good=copy.deepcopy(raw.get("last_known_good")),
            pending=copy.deepcopy(raw.get("pending", [])),
        )
        for key, value in raw.get("records", {}).items():
            # A record this code cannot parse is a corrupt store, not a crash.
            # Hand-editing knowledge.json is a supported thing to do -- the
            # whole format exists so people can argue with it in a diff -- so a
            # typo in it has to come back as a sentence naming the record and
            # the field, not as a traceback out of the enum constructor.
            try:
                document.records[key] = KnowledgeRecord.from_dict(value)
            except KnowledgeError:
                raise
            except (KeyError, ValueError, TypeError, AttributeError) as error:
                raise MalformedKnowledge(
                    f"record {key!r} in the knowledge document for "
                    f"{document.tenant}/{document.integration}/"
                    f"{document.environment} cannot be read: "
                    f"{type(error).__name__}: {error}"
                ) from error
        return document


class KnowledgeError(Exception):
    """Anything the knowledge layer refuses to do."""


class TenantMismatch(KnowledgeError):
    """A record or document was asked for under the wrong tenant."""


class SchemaMismatch(KnowledgeError):
    """The stored schema version is not the one this code understands."""


class MalformedKnowledge(KnowledgeError):
    """A stored record cannot be read back. Names the record and the fault."""


class SecretRejected(KnowledgeError):
    """A write was refused because it carried something secret-shaped."""


class EvidenceRequired(KnowledgeError):
    """A promotion was refused because nothing proved it."""
