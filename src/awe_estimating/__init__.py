"""Estimating as a reusable AWE capability.

An estimate has the same shape whether the work is repairing switchgear,
replacing a roof or migrating a database: scope, priced lines, adjustments,
assumptions, exclusions, a range, and somebody who has to approve it. So none
of that lives in a workflow package.

What a workflow contributes is one adapter: a way to turn its own findings into
:class:`~awe_estimating.model.ScopeItem` objects. Everything after that --
pricing, confidence, approval gates, proposal drafting, calibration -- is
shared, configured, and tested here.

Two rules the package exists to enforce, and enforces in code rather than in
documentation:

  * **Money comes only from approved configuration.** A rate has to name the
    config key it came from, or it cannot price anything.
  * **A model's suggestion is not evidence.** An AI proposal is carried as an
    open question until configuration, a comparable job or a named person
    confirms it. See :mod:`awe_estimating.evidence`.
"""

from .evidence import (
    Assumption,
    Clarification,
    EvidenceClass,
    Provenance,
    from_config,
    from_history,
    from_human,
    from_report,
    from_technician,
    proposed_by_ai,
)
from .model import (
    ESTIMATE_SCHEMA_VERSION,
    Adjustment,
    AdjustmentKind,
    Alternate,
    Approval,
    ApprovalStatus,
    Confidence,
    Estimate,
    Exclusion,
    LineItem,
    LineKind,
    ScopeItem,
    money,
    to_cents,
)

__all__ = [
    "ESTIMATE_SCHEMA_VERSION",
    "Adjustment", "AdjustmentKind", "Alternate", "Approval", "ApprovalStatus",
    "Assumption", "Clarification", "Confidence", "Estimate", "EvidenceClass",
    "Exclusion", "LineItem", "LineKind", "Provenance", "ScopeItem",
    "from_config", "from_history", "from_human", "from_report",
    "from_technician", "money", "proposed_by_ai", "to_cents",
]
