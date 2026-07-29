"""Run log written alongside each finished report.

An ESA report can be referenced in a warranty or insurance dispute years after
it was produced, so each build records what went into it: which source file
became which section, how many pages each contributed, and when it was built.
"""

from __future__ import annotations

import getpass
import json
import platform
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

MANIFEST_NAME = "build-manifest.json"


def build(job, workflow, sections: list[dict[str, Any]], output: Path) -> dict:
    """Assemble the manifest payload for one run."""
    return {
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "built_by": _whoami(),
        "host": platform.node(),
        "tool_version": _version(),
        "job": {
            "company": job.company,
            "site": job.site,
            "year": job.year,
            "agreement": job.agreement,
            "site_visit": job.site_visit,
        },
        "output": {
            "filename": output.name,
            "pages": sum(s["pages"] for s in sections),
        },
        "sections": sections,
    }


def write(payload: dict, directory: Path) -> Path:
    path = Path(directory) / MANIFEST_NAME
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return path


def _whoami() -> str:
    try:
        return getpass.getuser()
    except Exception:
        return "unknown"


def _version() -> str:
    from . import __version__

    return __version__
