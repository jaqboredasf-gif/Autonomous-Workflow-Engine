"""Turning a job workspace into the finished ESA report.

This is the deterministic half of the tool: given a workspace with source
documents in it, produce one PDF in the exact business order, and prove what
went into it. No network, no browser -- so it is fully testable and it is the
part that can be trusted while the portal half is still being learned.

Invariants held here, because each one corresponds to a way a real report has
gone wrong before:

  * Source files are never modified or overwritten. Everything derived lands in
    ``converted/``; the finished report lands in ``output/``.
  * Every one of the ten sections must be present. A short report is worse than
    no report, so a missing section stops the build and names what is missing.
  * The same file is never inserted twice.
  * The final page count must equal the sum of its parts, and the result must
    re-open cleanly, or the build fails.
"""

from __future__ import annotations

import shutil
from dataclasses import dataclass, field
from pathlib import Path

from . import canonical, certdoc, draft, workspace as ws
from .assemble import AssemblyError, merge_pdfs, page_count, split_pdf
from .certificate import CertificateError

# The IR report is the only document that gets cut in two.
IR_SPLITS = [
    {"name": "Cover.pdf", "pages": "1", "key": canonical.COVER},
    {
        "name": "StandardIRReport no cover.pdf",
        "pages": "2-",
        "key": canonical.STANDARD_IR_NO_COVER,
    },
]


class PipelineError(Exception):
    """Raised when a build cannot proceed. Carries an operator-facing message."""


@dataclass
class Component:
    """One section of the finished report."""

    key: str
    path: Path
    pages: int = 0
    checksum: str = ""
    origin: str = ""

    def to_dict(self) -> dict:
        return {
            "section": canonical.title(self.key),
            "canonical_type": self.key,
            "source_file": self.path.name,
            "pages": self.pages,
            "checksum": self.checksum,
            "origin": self.origin,
        }


@dataclass
class BuildResult:
    output: Path | None = None
    pages: int = 0
    components: list[Component] = field(default_factory=list)
    missing: list[str] = field(default_factory=list)
    watermarked: bool = False
    review_required: bool = True
    review_reasons: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.output is not None and not self.missing


# ---------------------------------------------------------------------------
# Staging
# ---------------------------------------------------------------------------


def stage_static_assets(workspace: ws.Workspace, assets_dir: Path) -> list[str]:
    """Copy the two fixed documents into the workspace. Returns any missing."""
    assets_dir = Path(assets_dir)
    missing = []
    for key in (canonical.TABLE_OF_CONTENTS, canonical.CUSTOMER_INSTRUCTIONS):
        name = canonical.output_filename(key)
        source = assets_dir / name
        if not source.exists():
            missing.append(name)
            workspace.mark_failed(
                key, f"static asset not found: {source}", status=ws.FAILED
            )
            continue
        target = workspace.converted / name
        shutil.copy2(source, target)
        record = workspace.record(key)
        record.status = ws.VERIFIED
        record.source_filename = name
        record.local_path = workspace.relative(target)
        record.checksum = ws.checksum(target)
        record.conversion_status = "copied"
        workspace.put(record)
    return missing


def prepare_certificate(workspace: ws.Workspace) -> certdoc.CertificateOutcome:
    """Convert the downloaded certificate to PDF and judge whether it is safe.

    The certificate is never edited unless the control mapping is proven, so in
    practice this marks the job for review and carries the document through
    unchanged.
    """
    record = workspace.record(canonical.CERTIFICATE)
    if not record.local_path:
        raise PipelineError(
            "no certificate has been downloaded for this job yet. Run the "
            "portal fetch first, or place the .doc in the job's source/ folder."
        )
    source = workspace.resolve(record.local_path)
    if not source.exists():
        raise PipelineError(f"certificate is recorded but missing on disk: {source}")

    try:
        outcome = certdoc.prepare(source, workspace.converted)
    except CertificateError as exc:
        record.conversion_status = "failed"
        record.failure_reason = str(exc)
        record.status = ws.FAILED
        workspace.put(record)
        raise PipelineError(f"certificate conversion failed: {exc}") from exc

    record.conversion_status = "converted"
    record.converted_path = workspace.relative(outcome.pdf)
    record.status = ws.CONVERTED
    record.validation = "not edited; requires human check"
    workspace.put(record)
    workspace.require_review(outcome.reason)
    return outcome


def derive_ir_sections(workspace: ws.Workspace) -> list[str]:
    """Split the IR report into its cover and its body. Returns any missing."""
    record = workspace.record(canonical.STANDARD_IR)
    if not record.local_path:
        return [canonical.output_filename(canonical.STANDARD_IR)]
    source = workspace.resolve(record.local_path)
    if not source.exists():
        return [canonical.output_filename(canonical.STANDARD_IR)]

    try:
        written = split_pdf(source, IR_SPLITS, workspace.converted)
    except AssemblyError as exc:
        raise PipelineError(
            f"could not split {source.name} into a cover and a body: {exc}"
        ) from exc

    for spec, path in zip(IR_SPLITS, written):
        derived = workspace.record(spec["key"])
        derived.status = ws.VERIFIED
        derived.source_filename = path.name
        derived.local_path = workspace.relative(path)
        derived.checksum = ws.checksum(path)
        derived.conversion_status = f"split from {source.name} pages {spec['pages']}"
        derived.pages = page_count(path)
        workspace.put(derived)
    return []


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------


def collect(workspace: ws.Workspace) -> tuple[list[Component], list[str]]:
    """Gather the ten sections in business order. Reports everything missing."""
    components: list[Component] = []
    missing: list[str] = []
    seen: set[str] = set()

    for key in canonical.BUSINESS_ORDER:
        record = workspace.record(key)
        # The certificate is included as its converted PDF.
        relative = record.converted_path or record.local_path
        if not relative:
            missing.append(f"{canonical.title(key)} ({canonical.output_filename(key)})")
            continue
        path = workspace.resolve(relative)
        if not path.exists():
            missing.append(f"{canonical.title(key)} -- recorded but missing: {path}")
            continue
        if path.suffix.lower() != ".pdf":
            missing.append(
                f"{canonical.title(key)} -- {path.name} is not a PDF; it must be "
                "converted before assembly"
            )
            continue

        digest = ws.checksum(path)
        if digest in seen:
            raise PipelineError(
                f"refusing to insert the same file twice: {path.name} would "
                f"appear again as {canonical.title(key)}"
            )
        seen.add(digest)

        try:
            pages = page_count(path)
        except Exception as exc:
            missing.append(f"{canonical.title(key)} -- {path.name} is unreadable: {exc}")
            continue

        components.append(
            Component(
                key=key,
                path=path,
                pages=pages,
                checksum=digest,
                origin=record.conversion_status or "downloaded",
            )
        )

    return components, missing


def build(
    workspace: ws.Workspace,
    output_name: str,
    *,
    mark_draft: bool = True,
) -> BuildResult:
    """Assemble the report, validate it, and record exactly what went in."""
    components, missing = collect(workspace)
    result = BuildResult(missing=missing, components=components)

    if missing:
        workspace.data["build"] = {
            "status": "blocked",
            "missing": missing,
            "at": ws.utcnow(),
        }
        workspace.save()
        return result

    name = draft.draft_filename(output_name) if mark_draft else output_name
    merged = workspace.output / (
        f".merge-{name}" if mark_draft else name
    )
    merge_pdfs([c.path for c in components], merged)

    expected = sum(c.pages for c in components)

    if mark_draft:
        final = workspace.output / name
        final, stamped = draft.apply(merged, final)
        result.watermarked = stamped
        merged.unlink(missing_ok=True)
    else:
        final = merged

    # Validate: it must re-open, and the arithmetic must hold.
    try:
        actual = page_count(final)
    except Exception as exc:
        raise PipelineError(
            f"the assembled report could not be re-opened: {exc}"
        ) from exc
    if actual != expected:
        raise PipelineError(
            f"page count mismatch: the merged report has {actual} pages but its "
            f"{len(components)} components total {expected}. Not shipping this."
        )

    result.output = final
    result.pages = actual
    result.review_required = bool(workspace.data.get("review_required", True))
    result.review_reasons = list(workspace.data.get("review_reasons", []))

    workspace.data["build"] = {
        "status": "built",
        "at": ws.utcnow(),
        "output": final.name,
        "pages": actual,
        "checksum": ws.checksum(final),
        "watermarked": result.watermarked,
        "draft": mark_draft,
        "merge_order": [c.to_dict() for c in components],
    }
    workspace.save()
    return result
