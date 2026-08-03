"""AWE operational knowledge: what a run learned, kept for the next run.

The problem this solves is narrow and concrete. An agent works out how to log
into a portal, which selector finds the password field, that a site visit
hands off through an SSO interstitial before it settles -- and then the
session ends and the next agent works it all out again from scratch.

The layer holds that knowledge under four rules:

  * **Nothing is true because an agent said so.** A record needs evidence,
    and needs distinct executions to agree, before a later run will act on it
    unattended. See ``promotion``.
  * **Knowledge decays.** It goes stale, it expires, it gets superseded, and
    a single failure knocks a verified record straight back down. See
    ``lifecycle`` and ``validator``.
  * **No credentials, ever.** Every write is screened, and a write that
    carries something secret-shaped is refused rather than redacted. See
    ``evidence``.
  * **One tenant's knowledge is not another's.** The boundary is enforced on
    read, not filtered after. See ``store``.

Start at ``runtime.KnowledgeRun`` -- it is the loop everything else serves.
"""

from .evidence import (
    build_evidence,
    evidence_is_usable,
    redact,
    reject_secrets,
    scan_for_secrets,
)
from .lifecycle import (
    Contradiction,
    PendingChange,
    decide_pending,
    expire,
    find_contradictions,
    open_pending,
    propose_change,
    supersede,
)
from .models import (
    SCHEMA_VERSION,
    EvidenceRef,
    EvidenceRequired,
    KnowledgeDocument,
    KnowledgeError,
    KnowledgeRecord,
    MalformedKnowledge,
    RecordKind,
    SchemaMismatch,
    SecretRejected,
    SelectorStatus,
    TenantMismatch,
    TrustLevel,
)
from .promotion import (
    INVALIDATE_AFTER_FAILURES,
    VERIFY_THRESHOLD,
    TrustChange,
    confirm_invalid,
    observe,
    record_failure,
    record_success,
)
from .runtime import KnowledgeChangeReport, KnowledgeRun, Resolution, utc_clock
from .store import DEFAULT_ROOT, KnowledgeStore
from .validator import (
    DEFAULT_MAX_AGE_DAYS,
    ValidationReport,
    is_stale,
    validate_document,
    validate_record,
)

__all__ = [
    "SCHEMA_VERSION",
    "VERIFY_THRESHOLD",
    "INVALIDATE_AFTER_FAILURES",
    "DEFAULT_MAX_AGE_DAYS",
    "DEFAULT_ROOT",
    "Contradiction",
    "EvidenceRef",
    "EvidenceRequired",
    "KnowledgeChangeReport",
    "KnowledgeDocument",
    "KnowledgeError",
    "KnowledgeRecord",
    "KnowledgeRun",
    "KnowledgeStore",
    "MalformedKnowledge",
    "PendingChange",
    "RecordKind",
    "Resolution",
    "SchemaMismatch",
    "SecretRejected",
    "SelectorStatus",
    "TenantMismatch",
    "TrustChange",
    "TrustLevel",
    "ValidationReport",
    "build_evidence",
    "confirm_invalid",
    "decide_pending",
    "evidence_is_usable",
    "expire",
    "find_contradictions",
    "is_stale",
    "observe",
    "open_pending",
    "propose_change",
    "record_failure",
    "record_success",
    "redact",
    "reject_secrets",
    "scan_for_secrets",
    "supersede",
    "utc_clock",
    "validate_document",
    "validate_record",
]
