"""PDF splitting and merging -- the Acrobat portion of the SOP.

This module replaces these manual steps:

  * "Print to PDF 1st page of StandardIRReport.pdf and Save As Cover"
  * "Print to PDF remaining pages ... Save As StandardIRReport no cover"
  * "Combine all open .pdf files into 1 pdf in the following order: ..."

It is deliberately free of any portal or shared-drive dependency so it can run
and be tested anywhere.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from pypdf import PdfReader, PdfWriter


class AssemblyError(Exception):
    """Raised when the inputs for an assembly step are wrong or missing."""


def parse_page_range(spec: str, page_count: int) -> list[int]:
    """Turn a 1-based page spec into 0-based page indices.

    Accepts ``"1"``, ``"2-"`` (page 2 to the end), ``"3-5"``, and comma
    separated combinations such as ``"1,4-6"``.
    """
    spec = str(spec).strip()
    if not spec:
        raise AssemblyError("empty page range")

    indices: list[int] = []
    for chunk in spec.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        if "-" in chunk:
            start_text, _, end_text = chunk.partition("-")
            start = int(start_text) if start_text.strip() else 1
            end = int(end_text) if end_text.strip() else page_count
        else:
            start = end = int(chunk)

        if start < 1 or end < start:
            raise AssemblyError(f"invalid page range {chunk!r}")
        if start > page_count:
            raise AssemblyError(
                f"page range {chunk!r} starts past the end of a "
                f"{page_count}-page document"
            )
        end = min(end, page_count)
        indices.extend(range(start - 1, end))

    if not indices:
        raise AssemblyError(f"page range {spec!r} selected no pages")
    return indices


def split_pdf(source: Path, outputs: list[dict], out_dir: Path) -> list[Path]:
    """Split ``source`` into the named page ranges. Returns the files written."""
    source = Path(source)
    if not source.exists():
        raise AssemblyError(f"cannot split, file not found: {source}")

    reader = PdfReader(str(source))
    page_count = len(reader.pages)
    if page_count < 2:
        raise AssemblyError(
            f"{source.name} has {page_count} page(s); expected at least 2 so the "
            "cover can be separated from the body"
        )

    written = []
    for spec in outputs:
        name = spec["name"]
        writer = PdfWriter()
        for index in parse_page_range(spec["pages"], page_count):
            writer.add_page(reader.pages[index])
        destination = Path(out_dir) / name
        with destination.open("wb") as handle:
            writer.write(handle)
        written.append(destination)
    return written


@dataclass
class MergePlan:
    """The result of checking a folder against the required assembly order."""

    present: list[Path] = field(default_factory=list)
    missing: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.missing


def plan_merge(order: list[str], source_dir: Path) -> MergePlan:
    """Check that every document in the assembly order exists before merging.

    Reporting all missing pieces at once matters: a half-built report that
    silently drops a section is worse than one that refuses to build.
    """
    plan = MergePlan()
    for name in order:
        candidate = Path(source_dir) / name
        if candidate.exists():
            plan.present.append(candidate)
        else:
            plan.missing.append(name)
    return plan


def merge_pdfs(inputs: list[Path], output: Path) -> Path:
    """Concatenate ``inputs`` in the given order into ``output``."""
    if not inputs:
        raise AssemblyError("nothing to merge")

    writer = PdfWriter()
    for item in inputs:
        item = Path(item)
        if not item.exists():
            raise AssemblyError(f"cannot merge, file not found: {item}")
        try:
            reader = PdfReader(str(item))
        except Exception as exc:  # pypdf raises a variety of parse errors
            raise AssemblyError(f"{item.name} is not a readable PDF: {exc}") from exc
        if not reader.pages:
            raise AssemblyError(f"{item.name} contains no pages")
        for page in reader.pages:
            writer.add_page(page)

    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("wb") as handle:
        writer.write(handle)
    return output


def assemble(order: list[str], source_dir: Path, output: Path) -> Path:
    """Validate the full set is present, then merge it in the SOP's order."""
    plan = plan_merge(order, source_dir)
    if not plan.ok:
        raise AssemblyError(
            "cannot assemble the ESA report, missing "
            f"{len(plan.missing)} document(s):\n  - "
            + "\n  - ".join(plan.missing)
        )
    return merge_pdfs(plan.present, output)


def page_count(path: Path) -> int:
    """Page count of a PDF, for reporting and verification."""
    return len(PdfReader(str(path)).pages)
