"""Loading and validation for the workflow and job files."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml


class ConfigError(Exception):
    """Raised when a workflow or job file is malformed."""


# Characters that are illegal in Windows paths, plus the ones that reliably
# cause trouble when these folders sync to the shared drive.
_ILLEGAL = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def sanitize_component(value: str) -> str:
    """Make a company/site/year value safe to use as a single folder name."""
    cleaned = _ILLEGAL.sub("-", str(value)).strip().strip(".")
    cleaned = re.sub(r"\s+", " ", cleaned)
    if not cleaned:
        raise ConfigError(f"path component is empty after sanitizing: {value!r}")
    return cleaned


@dataclass(frozen=True)
class Job:
    """The per-run inputs an operator supplies."""

    company: str
    site: str
    year: str
    agreement: str
    site_visit: str

    @classmethod
    def from_file(cls, path: Path) -> "Job":
        data = _read_yaml(path)
        missing = [
            f for f in ("company", "site", "year", "agreement", "site_visit")
            if not data.get(f)
        ]
        if missing:
            raise ConfigError(
                f"{path}: missing required field(s): {', '.join(missing)}"
            )
        return cls(
            company=sanitize_component(data["company"]),
            site=sanitize_component(data["site"]),
            year=sanitize_component(data["year"]),
            agreement=str(data["agreement"]),
            site_visit=str(data["site_visit"]),
        )

    def as_context(self) -> dict[str, str]:
        """Values available for `{placeholder}` substitution in workflow.yaml."""
        return {
            "company": self.company,
            "site": self.site,
            "year": self.year,
            "agreement": self.agreement,
            "site_visit": self.site_visit,
        }


@dataclass(frozen=True)
class Workflow:
    """The fixed definition of how an ESA report gets built."""

    raw: dict[str, Any]

    @classmethod
    def from_file(cls, path: Path) -> "Workflow":
        data = _read_yaml(path)
        for section in ("documents", "assembly", "splits", "certificate"):
            if section not in data:
                raise ConfigError(f"{path}: missing '{section}' section")
        if not data["assembly"].get("order"):
            raise ConfigError(f"{path}: assembly.order is empty")
        return cls(raw=data)

    @property
    def documents(self) -> list[dict[str, Any]]:
        return self.raw["documents"]

    @property
    def splits(self) -> list[dict[str, Any]]:
        return self.raw["splits"]

    @property
    def certificate(self) -> dict[str, Any]:
        return self.raw["certificate"]

    @property
    def assembly_order(self) -> list[str]:
        return self.raw["assembly"]["order"]

    @property
    def static_assets(self) -> list[str]:
        return self.raw.get("static_assets", [])

    def output_name(self, job: Job) -> str:
        template = self.raw["assembly"]["output_template"]
        return template.format(**job.as_context())

    def resolve_params(self, document: dict[str, Any], job: Job) -> dict[str, str]:
        """Fill `{agreement}` / `{site_visit}` style placeholders for one document."""
        ctx = job.as_context()
        resolved = {}
        for key, value in (document.get("params") or {}).items():
            try:
                resolved[key] = str(value).format(**ctx)
            except KeyError as exc:
                raise ConfigError(
                    f"document '{document.get('key')}' param '{key}' "
                    f"references unknown placeholder {exc}"
                ) from exc
        return resolved


def portal_credentials() -> tuple[str, str]:
    """Read portal credentials from the environment.

    Credentials are deliberately never read from a config file so that they
    cannot be committed by accident.
    """
    user = os.environ.get("TEGG_USERNAME")
    password = os.environ.get("TEGG_PASSWORD")
    if not user or not password:
        raise ConfigError(
            "TEGG_USERNAME and TEGG_PASSWORD must be set in the environment. "
            "See docs/GAPS.md -> 'Credential handling'."
        )
    return user, password


def _read_yaml(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise ConfigError(f"file not found: {path}")
    with path.open("r", encoding="utf-8") as handle:
        data = yaml.safe_load(handle)
    if not isinstance(data, dict):
        raise ConfigError(f"{path}: expected a YAML mapping at the top level")
    return data
