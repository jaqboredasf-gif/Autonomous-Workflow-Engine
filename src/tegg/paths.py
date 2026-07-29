"""Job folder layout on the TEGG shared drive.

Mirrors the manual step:

    z. TEGG Job Folders (Reports Only) / <Company> / <Site> / <Year>
"""

from __future__ import annotations

from pathlib import Path

from .config import Job


class JobFolder:
    """Resolves and creates the destination folder for one job."""

    def __init__(self, drive_root: Path, reports_root: str, job: Job) -> None:
        self.drive_root = Path(drive_root)
        self.reports_root = reports_root
        self.job = job

    @property
    def path(self) -> Path:
        return (
            self.drive_root
            / self.reports_root
            / self.job.company
            / self.job.site
            / self.job.year
        )

    def ensure(self) -> Path:
        """Create Company/Site/Year if any level is missing, and return it.

        Matches the SOP's "open existing ... or create new ..." behaviour: an
        existing folder is reused untouched, only missing levels are created.
        """
        target = self.path
        target.mkdir(parents=True, exist_ok=True)
        return target

    def created_levels(self) -> list[Path]:
        """Which levels do not exist yet (useful for a dry-run preview)."""
        missing = []
        current = self.drive_root / self.reports_root
        for component in (self.job.company, self.job.site, self.job.year):
            current = current / component
            if not current.exists():
                missing.append(current)
        return missing
