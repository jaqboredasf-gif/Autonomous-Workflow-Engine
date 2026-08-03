"""Evidence capture and the secret screen every write passes through.

The store is meant to be committed to a repository and read by people who are
not the person who ran the job, so two things matter more than convenience:
an artifact path that no longer exists is not evidence, and a credential that
reaches the file is a credential that reaches the repository.
"""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path
from typing import Any, Iterable

from .models import EvidenceRef, SecretRejected

# Environment variables whose *values* must never appear in a record. The
# names are safe to store; the values are what we screen for.
SECRET_ENV_VARS = (
    "TEGG_PASSWORD",
    "TEGG_USERNAME",
    "AWE_PASSWORD",
    "AWE_USERNAME",
)

# Keys that must never carry a value, whatever that value looks like.
SECRET_KEY_PATTERN = re.compile(
    r"(password|passwd|secret|token|api[_-]?key|cookie|session[_-]?id|"
    r"authorization|credential|bearer|private[_-]?key)",
    re.IGNORECASE,
)

# A single-sign-on hand-off URL. TEGG's site-visit rows link out to
# ``remote.teggpro.com/auth/gsso/<n>/<contractor>/<guid>/<64 hex>/...`` and that
# hex is a live session token -- anyone holding the URL is signed in as the
# account that produced it. It arrives under the innocent key "url", from the
# portal rather than from us, which is exactly the shape of leak a key-name
# screen misses.
SSO_URL_PATTERN = re.compile(
    r"https?://[^\s\"']*/(?:gsso|sso)/[^\s\"']*", re.IGNORECASE
)

# Values that look like a credential even under an innocent key.
SECRET_VALUE_PATTERNS = (
    # Unanchored: a token pasted mid-sentence into a note is still a token.
    re.compile(r"\bBearer\s+\S{8,}", re.IGNORECASE),
    re.compile(r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\."),   # JWT
    re.compile(r"\b[A-Za-z0-9_-]*(?:AKIA|ASIA)[A-Z0-9]{12,}\b"),  # AWS key id
    SSO_URL_PATTERN,
)

# Keys that may name a credential without carrying one -- these are how a
# record says "the password field is located by this label".
SECRET_KEY_ALLOWLIST = {
    "password_selector",
    "password_field",
    "password_label",
    "password_locator",
    "username_selector",
    "username_field",
    "username_label",
    "username_locator",
    "credential_source",
    "cookie_indicators",
    "session_indicators",
}


def _env_secret_values() -> list[str]:
    values = []
    for name in SECRET_ENV_VARS:
        value = os.environ.get(name, "")
        if value and len(value) >= 4:
            values.append(value)
    return values


def scan_for_secrets(payload: Any, path: str = "") -> list[str]:
    """Every reason this payload must not be written down. Empty is a pass."""
    problems: list[str] = []
    env_values = _env_secret_values()

    def walk(node: Any, where: str) -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                child = f"{where}.{key}" if where else str(key)
                if (
                    SECRET_KEY_PATTERN.search(str(key))
                    and str(key).lower() not in SECRET_KEY_ALLOWLIST
                    and isinstance(value, (str, bytes))
                    and value
                ):
                    problems.append(f"{child}: key names a secret")
                walk(value, child)
        elif isinstance(node, (list, tuple)):
            for index, value in enumerate(node):
                walk(value, f"{where}[{index}]")
        elif isinstance(node, str):
            for pattern in SECRET_VALUE_PATTERNS:
                if pattern.search(node):
                    problems.append(f"{where or '<root>'}: value looks like a credential")
                    break
            for secret in env_values:
                if secret in node:
                    problems.append(
                        f"{where or '<root>'}: value contains a live credential "
                        "from the environment"
                    )
                    break

    walk(payload, path)
    return problems


def reject_secrets(payload: Any, context: str = "") -> None:
    """Raise unless the payload is safe to commit."""
    problems = scan_for_secrets(payload)
    if problems:
        where = f" in {context}" if context else ""
        raise SecretRejected(
            f"refusing to store knowledge{where}: " + "; ".join(sorted(set(problems)))
        )


def redact(text: str) -> str:
    """Blank out live credentials in free text before it is recorded."""
    for secret in _env_secret_values():
        text = text.replace(secret, "<redacted>")
    return redact_sso(text)


def redact_sso(text: str) -> str:
    """Replace any single-sign-on hand-off URL with a non-secret placeholder.

    The URL is worth keeping the *shape* of -- "this row links out to the
    remote app" is a real fact about the portal -- but not the token in it,
    which is a live session. So the host and the fact survive and the path
    does not.
    """
    def _blank(match: re.Match[str]) -> str:
        from urllib.parse import urlparse

        host = urlparse(match.group(0)).hostname or "the remote app"
        return f"<sso hand-off to {host}; token not recorded>"

    return SSO_URL_PATTERN.sub(_blank, text)


def code_version(root: Path | None = None) -> tuple[str, str]:
    """The commit and a human version string, for provenance. Never fails."""
    root = root or Path(__file__).resolve().parents[2]
    commit = ""
    try:
        commit = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "HEAD"],
            capture_output=True, text=True, timeout=5,
        ).stdout.strip()
    except Exception:
        commit = ""
    version = ""
    try:
        from importlib.metadata import version as _version

        version = _version("tegg-esa-report")
    except Exception:
        version = ""
    return commit, version


def build_evidence(
    execution_id: str,
    observed_at: str,
    *,
    kind: str = "run",
    url: str = "",
    artifacts: Iterable[Path | str] = (),
    tenant: str = "",
    note: str = "",
    root: Path | None = None,
) -> EvidenceRef:
    """An evidence reference whose artifact paths are known to exist."""
    commit, version = code_version(root)
    kept: list[str] = []
    for artifact in artifacts:
        path = Path(artifact)
        if path.exists():
            kept.append(str(path))
    return EvidenceRef(
        execution_id=execution_id,
        observed_at=observed_at,
        kind=kind,
        url=url,
        artifacts=kept,
        commit=commit,
        code_version=version,
        tenant=tenant,
        note=redact(note),
    )


def evidence_is_usable(ref: EvidenceRef) -> bool:
    """Evidence counts only if it names a run and still points at something."""
    if not ref.execution_id or not ref.observed_at:
        return False
    if not ref.artifacts:
        # A run with no artifact is still evidence if it names its execution
        # and time -- a deterministic test result, for instance.
        return ref.kind in ("test", "run", "replay")
    return any(Path(a).exists() for a in ref.artifacts)
