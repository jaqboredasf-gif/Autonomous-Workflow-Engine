"""Shared scaffolding for the knowledge-layer tests.

Every test here runs against a temporary store and a fixed clock. The clock
matters: the layer is supposed to be replayable, and a test that used wall
time could not tell a real change from a change in the timestamp.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))

from awe_knowledge import (  # noqa: E402
    EvidenceRef,
    KnowledgeRecord,
    KnowledgeStore,
    RecordKind,
    TrustLevel,
)

TENANT = "acme"
INTEGRATION = "portal"
ENVIRONMENT = "production"


class FixedClock:
    """A clock that only moves when a test moves it."""

    def __init__(self, start: str = "2026-01-01T00:00:00+00:00") -> None:
        self.now = start

    def __call__(self) -> str:
        return self.now

    def set(self, iso: str) -> None:
        self.now = iso


@pytest.fixture
def clock() -> FixedClock:
    return FixedClock()


@pytest.fixture
def store(tmp_path: Path) -> KnowledgeStore:
    return KnowledgeStore(tmp_path / "operational_knowledge")


@pytest.fixture
def make_record():
    def _make(
        name: str = "login.username",
        kind: RecordKind = RecordKind.SELECTOR,
        *,
        tenant: str = TENANT,
        integration: str = INTEGRATION,
        environment: str = ENVIRONMENT,
        trust: TrustLevel = TrustLevel.DISCOVERED,
        payload: dict | None = None,
        **kwargs,
    ) -> KnowledgeRecord:
        defaults = {
            RecordKind.SELECTOR: {
                "component": "sign-in form",
                "purpose": "the account name field",
                "preferred": {"by": "label", "value": "Username"},
                "selector_type": "label",
                "fallbacks": [],
            },
            RecordKind.AUTH: {"login_url": "https://portal.example/auth/login"},
            RecordKind.NAVIGATION: {
                "starting_state": "signed in",
                "actions": ["open Documentation"],
                "expected_result": "the list is on screen",
            },
            RecordKind.PROCEDURE: {"steps": ["one", "two"]},
            RecordKind.POLICY: {"rule": "never submit", "applies_to": "every run"},
            RecordKind.FAILURE: {
                "observed_error": "wrong context",
                "likely_cause": "an SSO interstitial",
            },
            RecordKind.INTEGRATION: {
                "base_url": "https://portal.example",
                "auth_type": "form",
            },
        }
        return KnowledgeRecord(
            record_id=KnowledgeRecord.make_id(kind, name),
            kind=kind,
            name=name,
            tenant=tenant,
            integration=integration,
            environment=environment,
            payload=payload if payload is not None else dict(defaults[kind]),
            trust=trust,
            created_at="2026-01-01T00:00:00+00:00",
            updated_at="2026-01-01T00:00:00+00:00",
            **kwargs,
        )

    return _make


@pytest.fixture
def make_evidence():
    def _make(execution_id: str = "run-1", at: str = "2026-01-01T00:00:00+00:00",
              **kwargs) -> EvidenceRef:
        return EvidenceRef(
            execution_id=execution_id, observed_at=at, kind="test", **kwargs
        )

    return _make
