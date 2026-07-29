"""Match real downloaded files to the documents the workflow expects.

Files exported from the portal by hand rarely land with the exact name the SOP
uses. Browsers add ` (1)`, report viewers append timestamps, and people rename
things. Requiring an exact filename match would make the tool unusable in
practice, so matching runs in tiers, cheapest and safest first.

The tiers, in order:

  1. exact name
  2. same name ignoring case
  3. same name ignoring case, spaces and punctuation
  4. normalized *prefix*, which absorbs suffixes like " (1)" or "_20260514"

Exact matches across all wanted documents are claimed before any fuzzy
matching runs, so a loose prefix rule can never steal a file that is another
document's exact match.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

_NON_ALNUM = re.compile(r"[^a-z0-9]+")


def normalize(name: str) -> str:
    """Reduce a filename stem to comparable letters and digits."""
    return _NON_ALNUM.sub("", Path(name).stem.lower())


@dataclass
class Resolution:
    """How one wanted document was (or was not) matched on disk."""

    wanted: str
    path: Path | None = None
    how: str = "missing"
    alternates: list[Path] = field(default_factory=list)

    @property
    def found(self) -> bool:
        return self.path is not None

    @property
    def ambiguous(self) -> bool:
        return bool(self.alternates)

    def describe(self) -> str:
        if not self.found:
            return f"MISSING  {self.wanted}"
        line = f"{self.how:<10} {self.wanted}"
        if self.path.name != self.wanted:
            line += f"  <- {self.path.name}"
        if self.ambiguous:
            line += f"  ({len(self.alternates)} other candidate(s), used newest)"
        return line


def _candidates(search_dirs: list[Path]) -> list[Path]:
    """Every PDF and DOCX under the search directories, newest first."""
    seen: dict[Path, None] = {}
    for directory in search_dirs:
        directory = Path(directory)
        if not directory.is_dir():
            continue
        for item in sorted(directory.iterdir()):
            if item.is_file() and item.suffix.lower() in {".pdf", ".docx"}:
                seen[item.resolve()] = None
    return sorted(seen, key=lambda p: p.stat().st_mtime, reverse=True)


def _pick(matches: list[Path]) -> tuple[Path, list[Path]]:
    """Choose the newest match and return the rest as alternates."""
    ordered = sorted(matches, key=lambda p: p.stat().st_mtime, reverse=True)
    return ordered[0], ordered[1:]


def resolve_all(wanted: list[str], search_dirs: list[Path]) -> list[Resolution]:
    """Resolve every wanted document against the files actually on disk."""
    pool = _candidates(search_dirs)
    claimed: set[Path] = set()
    results: dict[str, Resolution] = {name: Resolution(wanted=name) for name in wanted}

    def unclaimed() -> list[Path]:
        return [p for p in pool if p not in claimed]

    # Tier 1 and 2 are precise enough to claim files up front.
    for name in wanted:
        exact = [p for p in unclaimed() if p.name == name]
        if not exact:
            exact = [p for p in unclaimed() if p.name.lower() == name.lower()]
            how = "ci-name"
        else:
            how = "exact"
        if exact:
            chosen, alternates = _pick(exact)
            claimed.add(chosen)
            results[name] = Resolution(name, chosen, how, alternates)

    # Tier 3 and 4 only see what is left over.
    for name in wanted:
        if results[name].found:
            continue
        target = normalize(name)

        same = [p for p in unclaimed() if normalize(p.name) == target]
        if same:
            chosen, alternates = _pick(same)
            claimed.add(chosen)
            results[name] = Resolution(name, chosen, "normalized", alternates)
            continue

        prefixed = [
            p for p in unclaimed()
            if normalize(p.name).startswith(target) and target
        ]
        if prefixed:
            chosen, alternates = _pick(prefixed)
            claimed.add(chosen)
            results[name] = Resolution(name, chosen, "prefix", alternates)

    return [results[name] for name in wanted]


def missing(resolutions: list[Resolution]) -> list[str]:
    return [r.wanted for r in resolutions if not r.found]


def resolve_one(wanted: str, search_dirs: list[Path]) -> Resolution:
    """Resolve a single document, e.g. the IR report before splitting it."""
    return resolve_all([wanted], search_dirs)[0]
