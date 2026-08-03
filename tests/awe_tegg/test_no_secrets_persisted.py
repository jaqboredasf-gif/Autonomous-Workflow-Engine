"""Proof 11: nothing a run writes down can carry a credential or a session.

This one is checked the only way worth checking it -- by *value*. A whole
operation runs with real credentials in the environment, and then every byte
the run produced is searched for those exact strings: the ledger, the knowledge
document, its history, the observation file, the saved HTML, the screenshots.

Two further refusals are checked directly, because they are what stops the next
person from being clever:

  * the ledger's own save screens the payload and raises rather than writing;
  * a service file that carries a password is refused rather than read, so a
    coworker cannot make one work by pasting a secret into it.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tests"))

# The whole operation drives a real browser; skip rather than fail without one.
pytest.importorskip("playwright")

from awe_knowledge.models import SecretRejected  # noqa: E402
from awe_tegg.checkpoint import COMPLETED, RunLedger  # noqa: E402
from awe_tegg.operation import (  # noqa: E402
    CREDENTIAL_SOURCE,
    OperationError,
    credentials_present,
    load_settings,
    start,
)

from mock_documentation import PASSWORD, USERNAME  # noqa: E402

#: Anything shaped like a session. None of these may reach disk either.
SESSION_KEYS = ("cookie", "set-cookie", "authorization", "bearer",
                "sessionstorage", "localstorage", "jsessionid", "access_token")


def _every_file(root: Path) -> list[Path]:
    return [p for p in root.rglob("*") if p.is_file()]


def _read_bytes(path: Path) -> bytes:
    try:
        return path.read_bytes()
    except OSError:                                         # pragma: no cover
        return b""


def test_no_artifact_of_a_live_run_contains_a_credential(
    portal, store, seeded, settings, credentials, tmp_path
):
    settings.store_root = store.root
    work = tmp_path / "work"
    result = start(settings, work_root=work, run_id="secret-scan")
    assert result.status == COMPLETED, result.human_action_required

    needles = {
        "username": USERNAME.encode(),
        "password": PASSWORD.encode(),
    }
    checked = 0
    for path in _every_file(work) + _every_file(Path(store.root)):
        blob = _read_bytes(path)
        checked += 1
        for label, needle in needles.items():
            assert needle not in blob, f"{label} reached {path}"
    assert checked > 5, "the scan found almost nothing -- did the run write anything?"


def test_no_artifact_carries_a_session(
    portal, store, seeded, settings, credentials, tmp_path
):
    settings.store_root = store.root
    work = tmp_path / "work"
    start(settings, work_root=work, run_id="session-scan")

    ledger = RunLedger.find(work, "session-scan")
    serialised = json.dumps(ledger.data).lower()
    for key in SESSION_KEYS:
        assert key not in serialised, f"the ledger recorded {key!r}"

    document = json.dumps(
        store.load(settings.tenant, settings.integration,
                   settings.environment).to_dict()
    ).lower()
    for key in SESSION_KEYS:
        # 'cookie_indicators' is an allowlisted *name* elsewhere in the schema;
        # what must never appear is a value under any of these.
        assert f'"{key}":' not in document, f"the knowledge store recorded {key!r}"


def test_the_ledger_records_where_credentials_came_from_never_what_they_are(
    portal, store, seeded, settings, credentials, tmp_path
):
    settings.store_root = store.root
    work = tmp_path / "work"
    start(settings, work_root=work, run_id="provenance-only")
    ledger = RunLedger.find(work, "provenance-only")

    assert ledger.data["credential_source"] == CREDENTIAL_SOURCE
    assert "TEGG_USERNAME" in ledger.data["credential_source"]
    assert USERNAME not in json.dumps(ledger.data)


def test_the_ledger_refuses_to_save_a_secret(tmp_path, credentials):
    ledger = RunLedger.create(
        tmp_path / "work", "refuses",
        operation="documentation-read", tenant="lippolis",
        integration="tegg-pro", environment="production",
        base_url="http://127.0.0.1", credential_source=CREDENTIAL_SOURCE,
    )
    ledger.checkpoint("open_knowledge", "fine")
    good = ledger.state_path.read_text(encoding="utf-8")

    ledger.data["notes"].append({"message": f"signed in as {USERNAME}"})
    with pytest.raises(SecretRejected):
        ledger.save()
    assert ledger.state_path.read_text(encoding="utf-8") == good, (
        "the refused write still reached disk"
    )

    ledger.data["notes"][-1] = {"message": "carrying a token"}
    ledger.data["password"] = "anything at all"
    with pytest.raises(SecretRejected):
        ledger.save()


def test_a_service_file_carrying_a_credential_is_refused(tmp_path):
    path = tmp_path / "service.yaml"
    path.write_text(
        "service:\n"
        "  base_url: https://tegg2.teggpro.com\n"
        "  tenant: lippolis\n"
        "  password: hunter2\n",
        encoding="utf-8",
    )
    with pytest.raises(OperationError) as raised:
        load_settings(path)
    assert "password" in str(raised.value)
    assert "environment" in str(raised.value)


def test_a_clean_service_file_is_read(tmp_path):
    path = tmp_path / "service.yaml"
    path.write_text(
        "service:\n"
        "  base_url: https://tegg2.teggpro.com\n"
        "  tenant: lippolis\n"
        "  contractor: Lippolis\n"
        "  discovery_actions: 6\n",
        encoding="utf-8",
    )
    settings = load_settings(path)
    assert settings.base_url == "https://tegg2.teggpro.com"
    assert settings.tenant == "lippolis"
    assert settings.discovery_actions == 6


def test_missing_credentials_are_named_but_never_read(monkeypatch):
    monkeypatch.delenv("TEGG_USERNAME", raising=False)
    monkeypatch.delenv("TEGG_PASSWORD", raising=False)
    assert credentials_present() == ["TEGG_USERNAME", "TEGG_PASSWORD"]

    monkeypatch.setenv("TEGG_USERNAME", "someone")
    assert credentials_present() == ["TEGG_PASSWORD"]


def test_a_run_without_credentials_escalates_before_opening_a_browser(
    portal, store, seeded, settings, monkeypatch, tmp_path
):
    monkeypatch.delenv("TEGG_USERNAME", raising=False)
    monkeypatch.delenv("TEGG_PASSWORD", raising=False)
    settings.store_root = store.root

    result = start(settings, work_root=tmp_path / "work", run_id="no-creds")
    assert result.status == "escalated"
    assert "TEGG_USERNAME" in result.human_action_required[0]
    assert portal.fetched == [], "a browser was opened without credentials"


# ---------------------------------------------------------------------------
# The session token the portal hands us, rather than the one we hand it
# ---------------------------------------------------------------------------

#: A real-*shaped* TEGG site-visit row link. In the live portal the 64 hex
#: characters are a session token: whoever holds the URL is signed in as the
#: account that produced it. The value below is synthetic on purpose -- a
#: fixture is a committed file, and a real token in one is the leak this
#: whole test file exists to prevent.
SSO_ROW_URL = (
    "https://remote.teggpro.com/auth/gsso/104/TEGGProExample595/"
    "16719376-b07e-4085-880b-e090a607b6f4/"
    "0F1E2D3C4B5A69788796A5B4C3D2E1F00F1E2D3C4B5A69788796A5B4C3D2E1F0/"
    "3076/969/4672/0"
)
SSO_TOKEN = "0F1E2D3C4B5A69788796A5B4C3D2E1F00F1E2D3C4B5A69788796A5B4C3D2E1F0"


def test_a_visit_keeps_its_link_in_memory_and_loses_the_token_on_disk():
    """The run must be able to follow the link; the disk must not learn it."""
    from tegg.sitevisit import SiteVisit

    visit = SiteVisit(identifier="T26-001", customer="Example", url=SSO_ROW_URL)
    assert visit.url == SSO_ROW_URL, "the live URL is needed to navigate"

    stored = visit.to_dict()
    assert SSO_TOKEN not in json.dumps(stored)
    assert "gsso" not in json.dumps(stored)
    # The fact survives even though the token does not.
    assert "remote.teggpro.com" in stored["url"]


def test_a_payload_carrying_an_sso_url_is_refused_by_the_screen():
    """Belt as well as braces: if redaction is ever skipped, the save refuses.

    Redaction alone is one line away from being deleted by someone who does not
    know what it is for. The screen is what makes that a failing test rather
    than a quiet leak.
    """
    from awe_knowledge.evidence import reject_secrets, scan_for_secrets

    payload = {"records": [{"identifier": "T26-001", "url": SSO_ROW_URL}]}
    assert scan_for_secrets(payload), "an SSO URL must not pass the screen"
    with pytest.raises(SecretRejected):
        reject_secrets(payload, context="a run ledger")


def test_a_ledger_cannot_be_written_with_a_session_token_in_it(tmp_path):
    ledger = RunLedger.create(
        tmp_path / "work", "sso-leak",
        operation="documentation-read", tenant="t", integration="i",
        environment="e", base_url="https://example.test",
        credential_source=CREDENTIAL_SOURCE,
    )
    before = ledger.state_path.read_text(encoding="utf-8")
    ledger.data["records"] = [{"identifier": "T26-001", "url": SSO_ROW_URL}]
    with pytest.raises(SecretRejected):
        ledger.save()
    # A refused write leaves the previous ledger intact.
    assert ledger.state_path.read_text(encoding="utf-8") == before
