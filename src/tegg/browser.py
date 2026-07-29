"""Chromium launch helper.

Playwright normally downloads its own browser. Some environments ship a
pre-installed one instead, and the pip package's expected build often does not
match it, so the executable is resolved explicitly with a sensible search order
and can always be overridden with TEGG_CHROMIUM.
"""

from __future__ import annotations

import os
from glob import glob
from pathlib import Path

SEARCH = [
    # Linux / preinstalled
    "/opt/pw-browsers/chromium-*/chrome-linux/chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    # macOS
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    # Windows
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
]


def find_chromium() -> str | None:
    """Locate a usable Chromium/Chrome, or None to use Playwright's own."""
    override = os.environ.get("TEGG_CHROMIUM")
    if override:
        if not Path(override).exists():
            raise FileNotFoundError(f"TEGG_CHROMIUM does not exist: {override}")
        return override

    for pattern in SEARCH:
        for match in sorted(glob(pattern), reverse=True):
            if Path(match).exists():
                return match
    return None


def launch(playwright, headless: bool = True):
    """Launch Chromium, preferring a pre-installed binary when present."""
    options = {"headless": headless, "args": ["--no-sandbox"]}
    executable = find_chromium()
    if executable:
        options["executable_path"] = executable
    return playwright.chromium.launch(**options)
