"""Loading and normalizing the mock test matrix.

The cases are data (``config/mock_cases.yaml``) rather than code so that adding
coverage is an edit to a table, not a new branch in a runner. This module is the
only place that knows the file's shape, and it validates rather than trusts: an
unknown case kind, an unknown fault name or a canonical type that does not exist
is an error at load time. A typo that silently skipped a section would be
indistinguishable from a section that passed.

Nothing here touches a browser or the filesystem beyond reading the file, so the
whole normalization layer is testable on its own.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import yaml

from . import canonical, mockportal

PORTAL_REPORT = "portal_report"
CERTIFICATE = "certificate"
STATIC = "static"
DERIVED = "derived"
KINDS = frozenset({PORTAL_REPORT, CERTIFICATE, STATIC, DERIVED})

EXPECT_PASS = "pass"
EXPECT_FAIL = "fail"

DEFAULT_PATH = Path(__file__).resolve().parents[2] / "config" / "mock_cases.yaml"


class CaseError(Exception):
    """The case file is wrong. Raised at load time, never during a run."""


@dataclass
class Job:
    """The fictional job every case runs against."""

    customer: str = mockportal.CUSTOMER
    site: str = mockportal.SITE
    agreement: str = mockportal.AGREEMENT
    site_visit: str = mockportal.SITE_VISIT
    visit_date: str = mockportal.VISIT_DATE

    def field(self, name: str) -> str:
        try:
            return str(getattr(self, name))
        except AttributeError:
            raise CaseError(
                f"unknown job field {name!r}; choose from "
                f"{sorted(self.__dataclass_fields__)}"
            ) from None

    def job_id(self) -> str:
        from .workspace import slugify

        return slugify(f"mock-{self.site}-{self.site_visit}").lower()

    def to_dict(self) -> dict:
        return {
            "customer": self.customer,
            "site": self.site,
            "agreement": self.agreement,
            "site_visit": self.site_visit,
            "visit_date": self.visit_date,
        }


@dataclass
class Case:
    """One mock report case, fully resolved."""

    id: str
    kind: str
    canonical_type: str
    portal_label: str = ""
    derived_from: str = ""
    fault: str = ""
    expect: str = EXPECT_PASS
    expect_stage: str = ""
    expect_cause: str = ""
    min_pages: int = 1
    max_pages: int = 5000
    text_fields: list[str] = field(default_factory=list)
    human_review: bool = False
    finalization_blocked: bool = False
    blocker: str = ""

    @property
    def should_fail(self) -> bool:
        return self.expect == EXPECT_FAIL

    @property
    def output_filename(self) -> str:
        return canonical.output_filename(self.canonical_type)

    def expected_fields(self, job: Job) -> dict[str, str]:
        return {name: job.field(name) for name in self.text_fields}

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "kind": self.kind,
            "canonical_type": self.canonical_type,
            "portal_label": self.portal_label,
            "derived_from": self.derived_from,
            "fault": self.fault,
            "expect": self.expect,
            "expect_stage": self.expect_stage,
            "expect_cause": self.expect_cause,
            "min_pages": self.min_pages,
            "max_pages": self.max_pages,
            "text_fields": list(self.text_fields),
            "human_review": self.human_review,
            "finalization_blocked": self.finalization_blocked,
            "blocker": self.blocker,
        }


@dataclass
class Matrix:
    """Everything loaded from the case file."""

    job: Job
    cases: list[Case] = field(default_factory=list)
    faults: list[Case] = field(default_factory=list)
    source: str = ""

    def case(self, case_id: str) -> Case:
        for case in (*self.cases, *self.faults):
            if case.id == case_id:
                return case
        raise CaseError(f"no case named {case_id!r}")

    def sections(self) -> list[Case]:
        """The cases that contribute a section to the assembled report."""
        return [c for c in self.cases if not c.should_fail]

    def covered_types(self) -> set[str]:
        return {c.canonical_type for c in self.sections()}

    def missing_types(self) -> list[str]:
        """Business-order sections with no passing case. Must be empty."""
        return [k for k in canonical.BUSINESS_ORDER if k not in self.covered_types()]


def _one(raw: dict, *, index: int, where: str) -> Case:
    if not isinstance(raw, dict):
        raise CaseError(f"{where}[{index}] is not a mapping")

    case_id = str(raw.get("id") or "").strip()
    if not case_id:
        raise CaseError(f"{where}[{index}] has no id")

    kind = str(raw.get("kind") or "").strip()
    if kind not in KINDS:
        raise CaseError(
            f"case {case_id!r} has kind {kind!r}; choose from {sorted(KINDS)}"
        )

    # A case's canonical type defaults to its id, which is why the section cases
    # are named after the types they cover.
    ctype = str(raw.get("canonical_type") or case_id).strip()
    if ctype not in canonical.BY_KEY:
        raise CaseError(
            f"case {case_id!r} names canonical type {ctype!r}, which does not "
            f"exist. Known types: {', '.join(sorted(canonical.BY_KEY))}"
        )

    fault = str(raw.get("fault") or "").strip()
    if fault and fault not in mockportal.FAULT_NAMES:
        raise CaseError(
            f"case {case_id!r} injects unknown fault {fault!r}; choose from "
            f"{sorted(mockportal.FAULT_NAMES)}"
        )

    expect = str(raw.get("expect") or EXPECT_PASS).strip()
    if expect not in (EXPECT_PASS, EXPECT_FAIL):
        raise CaseError(
            f"case {case_id!r} expects {expect!r}; use "
            f"{EXPECT_PASS!r} or {EXPECT_FAIL!r}"
        )

    portal_label = str(raw.get("portal_label") or "").strip()
    if kind == PORTAL_REPORT and not portal_label:
        raise CaseError(f"case {case_id!r} is a portal report but names no label")

    derived_from = str(raw.get("derived_from") or "").strip()
    if kind == DERIVED and not derived_from:
        raise CaseError(f"case {case_id!r} is derived but names no source case")

    blocker = " ".join(str(raw.get("blocker") or "").split())
    finalization_blocked = bool(raw.get("finalization_blocked"))
    if finalization_blocked and not blocker:
        raise CaseError(
            f"case {case_id!r} blocks finalization but names no blocker. A "
            "blocker with no stated reason is not reviewable."
        )

    text_fields = list(raw.get("text_fields") or [])
    for name in text_fields:
        Job().field(name)  # validates the name now rather than mid-run

    return Case(
        id=case_id,
        kind=kind,
        canonical_type=ctype,
        portal_label=portal_label,
        derived_from=derived_from,
        fault=fault,
        expect=expect,
        expect_stage=str(raw.get("expect_stage") or "").strip(),
        expect_cause=str(raw.get("expect_cause") or "").strip(),
        min_pages=int(raw.get("min_pages", 1)),
        max_pages=int(raw.get("max_pages", 5000)),
        text_fields=text_fields,
        human_review=bool(raw.get("human_review")),
        finalization_blocked=finalization_blocked,
        blocker=blocker,
    )


def load(path: Path | None = None) -> Matrix:
    """Read and validate the case file."""
    path = Path(path) if path else DEFAULT_PATH
    if not path.exists():
        raise CaseError(f"no mock case file at {path}")
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as exc:
        raise CaseError(f"{path} is not valid YAML: {exc}") from exc
    if not isinstance(raw, dict):
        raise CaseError(f"{path} must contain a mapping at the top level")

    job_data = raw.get("job") or {}
    if not isinstance(job_data, dict):
        raise CaseError("the 'job' section must be a mapping")
    known = set(Job.__dataclass_fields__)
    unknown = set(job_data) - known
    if unknown:
        raise CaseError(f"unknown job field(s) {sorted(unknown)}")
    job = Job(**{k: str(v) for k, v in job_data.items()})

    cases = [
        _one(item, index=i, where="cases")
        for i, item in enumerate(raw.get("cases") or [])
    ]
    faults = [
        _one(item, index=i, where="faults")
        for i, item in enumerate(raw.get("faults") or [])
    ]

    seen: set[str] = set()
    for case in (*cases, *faults):
        if case.id in seen:
            raise CaseError(f"duplicate case id {case.id!r}")
        seen.add(case.id)

    for case in faults:
        if not case.should_fail:
            raise CaseError(
                f"case {case.id!r} is listed under 'faults' but expects "
                f"{EXPECT_PASS!r}. A fault case that is allowed to pass proves "
                "nothing."
            )

    by_id = {c.id: c for c in cases}
    for case in cases:
        if case.kind == DERIVED and case.derived_from not in by_id:
            raise CaseError(
                f"case {case.id!r} derives from {case.derived_from!r}, which is "
                "not a case in this file"
            )

    return Matrix(job=job, cases=cases, faults=faults, source=str(path))
