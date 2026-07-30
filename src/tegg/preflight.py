"""What must be true before the controlled mock run is worth starting.

Every check here answers a question that, unanswered, turns into a confusing
failure ten minutes into a run: a missing browser looks like a login bug, an
unwritable output directory looks like an assembly bug, and a missing static
asset looks like a report that never generated.

Two of these are safety checks rather than readiness checks. ``target_is_local``
refuses to proceed if anything points the run at a host that is not loopback,
because the whole premise of the mock run is that it touches no production
system. ``credentials_are_environment_only`` reports whether live credentials
are present *without reading their values*, so the answer can be printed.

Nothing here launches a run, writes into the workspace, or contacts a network
host. The reachability check starts the mock portal on 127.0.0.1, asks it one
question, and stops it again.
"""

from __future__ import annotations

import os
import socket
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

# The static sections are supplied locally rather than generated, so their
# absence is a setup problem, not a run failure.
REQUIRED_ASSETS = (
    "ESA Table of Contents.pdf",
    "TEGGPro View Customer Instructions.pdf",
)

# Live credentials. The mock run does not need them; a live run cannot start
# without them. Presence is reported, values are never read.
LIVE_CREDENTIAL_VARS = ("TEGG_USERNAME", "TEGG_PASSWORD")

# Anything outside this set means the run is not pointed at a local mock.
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1", "[::1]"})

OK = "ok"
WARN = "warn"
FAIL = "fail"


@dataclass
class Item:
    """One prerequisite and its verdict.

    ``WARN`` exists so that a condition which is *informative* for a mock run
    but *blocking* for a live one -- absent live credentials, most of all --
    can be reported honestly without failing a run that does not need them.
    """

    name: str
    status: str
    detail: str = ""

    @property
    def blocking(self) -> bool:
        return self.status == FAIL

    def to_dict(self) -> dict:
        return {"name": self.name, "status": self.status, "detail": self.detail}

    def __str__(self) -> str:
        return f"[{self.status.upper():<4}] {self.name}: {self.detail}"


@dataclass
class Preflight:
    """The full set of verdicts."""

    items: list[Item] = field(default_factory=list)

    def add(self, item: Item) -> Item:
        self.items.append(item)
        return item

    @property
    def ok(self) -> bool:
        return not any(i.blocking for i in self.items)

    @property
    def blockers(self) -> list[Item]:
        return [i for i in self.items if i.blocking]

    @property
    def warnings(self) -> list[Item]:
        return [i for i in self.items if i.status == WARN]

    def to_dict(self) -> dict:
        return {
            "ok": self.ok,
            "blockers": [i.name for i in self.blockers],
            "items": [i.to_dict() for i in self.items],
        }

    def __str__(self) -> str:
        return "\n".join(str(i) for i in self.items)


# --- individual checks -----------------------------------------------------


def credentials_are_environment_only() -> Item:
    """Report whether live credentials are set, never what they are.

    A mock run needs none, which is why an absence is a warning. The value is
    deliberately not read: only ``os.environ`` membership is consulted, so no
    code path here can put a secret into a log or a result file.
    """
    present = [name for name in LIVE_CREDENTIAL_VARS if os.environ.get(name)]
    missing = [name for name in LIVE_CREDENTIAL_VARS if name not in present]
    if not missing:
        return Item(
            "credentials",
            OK,
            f"{', '.join(LIVE_CREDENTIAL_VARS)} are set in the environment "
            "(values not read); the mock run does not use them",
        )
    return Item(
        "credentials",
        WARN,
        f"not set: {', '.join(missing)}. The controlled mock run does not need "
        "them -- it signs in to a local mock with a fake account -- but a live "
        "run cannot start without them.",
    )


def dotenv_is_ignored(repo_root: Path) -> Item:
    """A committed ``.env`` is the usual way a credential escapes."""
    gitignore = Path(repo_root) / ".gitignore"
    if not gitignore.is_file():
        return Item("dotenv_ignored", FAIL, "no .gitignore in the repository root")
    patterns = {
        line.strip()
        for line in gitignore.read_text(encoding="utf-8", errors="replace").splitlines()
    }
    if ".env" in patterns or ".env*" in patterns:
        return Item("dotenv_ignored", OK, ".env is gitignored")
    return Item(
        "dotenv_ignored",
        FAIL,
        ".gitignore does not ignore .env, so a credential file could be committed",
    )


def browser_runtime() -> Item:
    """Playwright importable and a Chromium actually installed."""
    try:
        from playwright.sync_api import sync_playwright  # noqa: F401
    except ImportError as exc:
        return Item(
            "browser_runtime",
            FAIL,
            f"playwright is not importable ({exc}); run 'pip install playwright'",
        )

    try:
        from .browser import launch
    except ImportError as exc:  # pragma: no cover - the package is our own
        return Item("browser_runtime", FAIL, f"tegg.browser is unusable: {exc}")

    from playwright.sync_api import sync_playwright

    try:
        with sync_playwright() as playwright:
            browser = launch(playwright, headless=True)
            version = browser.version
            browser.close()
    except Exception as exc:
        return Item(
            "browser_runtime",
            FAIL,
            f"chromium would not launch ({str(exc).splitlines()[0][:160]}); "
            "run 'playwright install chromium'",
        )
    return Item("browser_runtime", OK, f"chromium {version} launches headless")


def static_assets(assets_dir: Path) -> Item:
    assets_dir = Path(assets_dir)
    if not assets_dir.is_dir():
        return Item("static_assets", FAIL, f"not a directory: {assets_dir}")
    missing = [n for n in REQUIRED_ASSETS if not (assets_dir / n).is_file()]
    if missing:
        return Item(
            "static_assets",
            FAIL,
            f"missing from {assets_dir}: {', '.join(missing)}",
        )
    empty = [
        n for n in REQUIRED_ASSETS if (assets_dir / n).stat().st_size == 0
    ]
    if empty:
        return Item("static_assets", FAIL, f"present but empty: {', '.join(empty)}")
    return Item(
        "static_assets",
        OK,
        f"{len(REQUIRED_ASSETS)} fixed section(s) present in {assets_dir}",
    )


def case_file(cases_path: Path | None) -> Item:
    """The case file loads *and* covers every section of the business order."""
    from . import canonical, mockcases

    try:
        matrix = mockcases.load(cases_path)
    except mockcases.CaseError as exc:
        return Item("case_file", FAIL, str(exc))
    except FileNotFoundError as exc:
        return Item("case_file", FAIL, f"case file not found: {exc}")

    missing = matrix.missing_types()
    if missing:
        return Item(
            "case_file",
            FAIL,
            f"{matrix.source} does not cover: {', '.join(missing)}",
        )
    return Item(
        "case_file",
        OK,
        f"{len(matrix.cases)} case(s) and {len(matrix.faults)} fault(s) covering "
        f"all {len(canonical.BUSINESS_ORDER)} sections",
    )


def output_writable(work_root: Path) -> Item:
    """The work root exists (or can be made) and accepts a write."""
    work_root = Path(work_root)
    try:
        work_root.mkdir(parents=True, exist_ok=True)
        probe = work_root / ".preflight-write-probe"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
    except OSError as exc:
        return Item("output_writable", FAIL, f"{work_root} is not writable: {exc}")
    return Item("output_writable", OK, f"{work_root} is writable")


def converter_available() -> Item:
    """LibreOffice, needed only to turn the legacy certificate into a PDF."""
    from .certificate import find_soffice

    binary = find_soffice()
    if binary is None:
        return Item(
            "document_converter",
            FAIL,
            "LibreOffice (soffice) was not found; the certificate section is a "
            "legacy .doc and cannot be converted without it",
        )
    return Item("document_converter", OK, f"LibreOffice found at {binary}")


def target_is_local(url: str) -> Item:
    """Refuse to proceed against anything that is not loopback.

    This is the check that keeps 'controlled mock run' true. It is deliberately
    a whitelist of loopback hosts rather than a blacklist of known production
    hosts, so a new production hostname cannot pass by not being on a list.
    """
    from urllib.parse import urlparse

    if not url:
        return Item(
            "target_is_local",
            OK,
            "no target configured; the run starts its own mock on 127.0.0.1",
        )
    host = urlparse(url).hostname or ""
    if host in LOOPBACK_HOSTS:
        return Item("target_is_local", OK, f"{url} is loopback")
    return Item(
        "target_is_local",
        FAIL,
        f"{url} is not a loopback address. The controlled mock run must not be "
        "pointed at a non-local host.",
    )


def portal_reachable(timeout: float = 5.0) -> Item:
    """Start the mock portal, ask it for its sign-in page, stop it.

    Proves the whole local stack -- socket bind, handler, routing -- before a
    run depends on it, and proves it without leaving anything listening.
    """
    from . import mockportal

    try:
        with mockportal.MockPortal() as portal:
            request = urllib.request.Request(
                f"{portal.url}/auth/login", method="GET"
            )
            with urllib.request.urlopen(request, timeout=timeout) as response:
                status = response.status
                body = response.read(2048)
    except (OSError, urllib.error.URLError, socket.timeout) as exc:
        return Item(
            "portal_reachable",
            FAIL,
            f"the local mock portal did not answer: {exc}",
        )

    if status != 200:
        return Item(
            "portal_reachable", FAIL, f"the mock sign-in page returned {status}"
        )
    if b"contractorConnection" not in body:
        return Item(
            "portal_reachable",
            FAIL,
            "the mock answered but did not serve the expected sign-in form",
        )
    return Item(
        "portal_reachable",
        OK,
        "the local mock portal starts, serves the sign-in page, and stops",
    )


# --- the whole thing -------------------------------------------------------


def run(
    *,
    repo_root: Path,
    work_root: Path,
    assets_dir: Path,
    cases_path: Path | None = None,
    target_url: str = "",
    check_browser: bool = True,
    check_portal: bool = True,
) -> Preflight:
    """Every prerequisite, in the order a run would need them."""
    checks = Preflight()
    checks.add(target_is_local(target_url))
    checks.add(credentials_are_environment_only())
    checks.add(dotenv_is_ignored(Path(repo_root)))
    checks.add(static_assets(assets_dir))
    checks.add(case_file(cases_path))
    checks.add(output_writable(work_root))
    checks.add(converter_available())
    if check_browser:
        checks.add(browser_runtime())
    if check_portal:
        checks.add(portal_reachable())
    return checks
