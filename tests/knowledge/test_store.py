"""Durability, the tenant boundary, and the secret screen.

The store is the last thing between an agent and a file that gets committed,
so the tests that matter most here are the refusals.
"""

from __future__ import annotations

import json

import pytest

from awe_knowledge import (
    KnowledgeDocument,
    KnowledgeError,
    KnowledgeRecord,
    MalformedKnowledge,
    RecordKind,
    SchemaMismatch,
    SecretRejected,
    TenantMismatch,
    TrustLevel,
)
from conftest import ENVIRONMENT, INTEGRATION, TENANT

AT = "2026-01-02T00:00:00+00:00"


def _document(**kwargs) -> KnowledgeDocument:
    return KnowledgeDocument(
        tenant=kwargs.pop("tenant", TENANT),
        integration=kwargs.pop("integration", INTEGRATION),
        environment=kwargs.pop("environment", ENVIRONMENT),
        base_url="https://portal.example",
        **kwargs,
    )


def test_a_saved_document_reloads_identically(store, make_record):
    document = _document()
    document.put(make_record())
    store.save(document, at=AT, execution_id="run-1")

    reloaded = store.load(TENANT, INTEGRATION, ENVIRONMENT)
    assert reloaded.to_dict() == document.to_dict()


def test_another_tenant_cannot_read_this_tenants_knowledge(store, make_record):
    document = _document()
    document.put(make_record())
    store.save(document, at=AT)

    with pytest.raises(KnowledgeError):
        store.load("other-contractor", INTEGRATION, ENVIRONMENT)


def test_a_document_moved_under_the_wrong_tenants_path_is_refused(store, make_record):
    """The boundary is checked against the file's contents, not its path."""
    document = _document()
    document.put(make_record())
    store.save(document, at=AT)

    foreign = store.path_for("other-contractor", INTEGRATION, ENVIRONMENT)
    foreign.parent.mkdir(parents=True, exist_ok=True)
    foreign.write_text(
        store.path_for(TENANT, INTEGRATION, ENVIRONMENT).read_text(encoding="utf-8"),
        encoding="utf-8",
    )
    with pytest.raises(TenantMismatch):
        store.load("other-contractor", INTEGRATION, ENVIRONMENT)


def test_a_record_from_another_tenant_cannot_be_put_in_this_document(make_record):
    document = _document()
    with pytest.raises(TenantMismatch):
        document.put(make_record(tenant="someone-else"))


def test_a_payload_carrying_a_credential_is_refused(store, make_record):
    document = _document()
    document.put(
        make_record(
            "login.password",
            payload={
                "component": "sign-in form",
                "purpose": "the password field",
                "preferred": {"by": "label", "value": "Password"},
                "selector_type": "label",
                "password": "hunter2xyz",          # the thing we must never keep
            },
        )
    )
    with pytest.raises(SecretRejected):
        store.save(document, at=AT)
    assert not store.exists(TENANT, INTEGRATION, ENVIRONMENT)


def test_a_live_environment_credential_is_caught_even_under_an_innocent_key(
    store, make_record, monkeypatch
):
    monkeypatch.setenv("TEGG_PASSWORD", "s3cret-value")
    document = _document()
    document.put(
        make_record(
            "login.note",
            kind=RecordKind.FAILURE,
            payload={
                "observed_error": "sign-in refused",
                "likely_cause": "we typed s3cret-value and it bounced",
            },
        )
    )
    with pytest.raises(SecretRejected):
        store.save(document, at=AT)


def test_naming_a_credential_field_is_allowed(store, make_record):
    """Storing *where* the password box is must stay legal."""
    document = _document()
    document.put(
        make_record(
            "login.password",
            payload={
                "component": "sign-in form",
                "purpose": "the password field",
                "preferred": {"by": "label", "value": "Enter your password"},
                "selector_type": "label",
                "password_selector": "input[type=password][name=password]",
                "credential_source": "the TEGG_PASSWORD environment variable",
            },
        )
    )
    store.save(document, at=AT)
    assert store.exists(TENANT, INTEGRATION, ENVIRONMENT)


def test_every_save_appends_to_an_immutable_history(store, make_record):
    document = _document()
    document.put(make_record())
    store.save(document, at=AT, execution_id="run-1", note="first")
    store.save(document, at="2026-01-03T00:00:00+00:00", execution_id="run-2",
               note="second")

    history = store.history(TENANT, INTEGRATION, ENVIRONMENT)
    assert [h["note"] for h in history] == ["first", "second"]
    assert [h["document_version"] for h in history] == [2, 3]


def test_the_written_file_is_stable_between_identical_saves(store, make_record):
    """Byte-stable output is what makes a knowledge change reviewable."""
    first = _document()
    first.put(make_record())
    path = store.save(first, at=AT)
    text_one = path.read_text(encoding="utf-8")

    second = _document(document_version=1)
    second.put(make_record())
    text_two = store.save(second, at=AT).read_text(encoding="utf-8")
    assert text_one == text_two


def test_a_document_from_a_future_schema_is_refused(store, make_record):
    document = _document()
    document.put(make_record())
    path = store.save(document, at=AT)
    raw = json.loads(path.read_text(encoding="utf-8"))
    raw["schema_version"] = 99
    path.write_text(json.dumps(raw), encoding="utf-8")

    with pytest.raises(SchemaMismatch):
        store.load(TENANT, INTEGRATION, ENVIRONMENT)


def test_loading_something_that_is_not_there_creates_nothing(store):
    with pytest.raises(KnowledgeError):
        store.load(TENANT, INTEGRATION, ENVIRONMENT)
    fresh = store.load_or_create(TENANT, INTEGRATION, ENVIRONMENT)
    assert fresh.records == {}
    assert not store.exists(TENANT, INTEGRATION, ENVIRONMENT)


def test_a_hand_edited_record_is_named_rather_than_crashing(store, make_record):
    """knowledge.json is meant to be read and argued with by people.

    So a typo in it has to come back as a sentence naming the record, not as a
    traceback out of the enum constructor three frames down.
    """
    document = _document()
    document.put(make_record())
    path = store.save(document, at=AT)
    raw = json.loads(path.read_text(encoding="utf-8"))
    record_id = next(iter(raw["records"]))
    raw["records"][record_id]["trust"] = "verified"      # right word, wrong case
    path.write_text(json.dumps(raw), encoding="utf-8")

    with pytest.raises(MalformedKnowledge) as caught:
        store.load(TENANT, INTEGRATION, ENVIRONMENT)
    assert record_id in str(caught.value)


@pytest.mark.parametrize(
    "corrupt, expected",
    [
        (lambda raw: raw["records"][next(iter(raw["records"]))].update(trust="nope"),
         MalformedKnowledge),
        (lambda raw: raw.update(schema_version=99), SchemaMismatch),
        (lambda raw: raw.update(tenant="somebody-else"), TenantMismatch),
    ],
    ids=["corrupt-record", "future-schema", "another-tenant"],
)
def test_a_document_that_is_there_but_unreadable_is_never_replaced(
    store, make_record, corrupt, expected
):
    """The one and only reason to start an empty document is that no file exists.

    Every other failure describes a file that is *there* and holds something.
    Answering one of those with a fresh empty document hands the caller that
    slot, and the run's own save then overwrites the records that were in it.
    """
    document = _document()
    document.put(make_record())
    path = store.save(document, at=AT)
    before = path.read_text(encoding="utf-8")

    raw = json.loads(before)
    corrupt(raw)
    path.write_text(json.dumps(raw), encoding="utf-8")
    after_corruption = path.read_text(encoding="utf-8")

    with pytest.raises(expected):
        store.load_or_create(TENANT, INTEGRATION, ENVIRONMENT, base_url="https://x")
    # Refused, and nothing was written over the top of it.
    assert path.read_text(encoding="utf-8") == after_corruption


def test_the_store_lists_what_it_holds(store, make_record):
    for tenant in ("acme", "other-contractor"):
        document = _document(tenant=tenant)
        document.put(make_record(tenant=tenant))
        store.save(document, at=AT)
    assert sorted(store.documents()) == [
        ("acme", INTEGRATION, ENVIRONMENT),
        ("other-contractor", INTEGRATION, ENVIRONMENT),
    ]


def test_a_document_snapshot_can_be_restored(make_record):
    document = _document()
    record = make_record(trust=TrustLevel.VERIFIED)
    document.put(record)
    document.remember_good()

    document.records[record.record_id].payload["preferred"] = {"by": "css",
                                                               "value": "#wrong"}
    assert document.restore_good() is True
    assert document.records[record.record_id].payload["preferred"]["value"] == "Username"


def test_record_ids_are_derived_not_invented():
    assert KnowledgeRecord.make_id(RecordKind.SELECTOR, "login.username") == (
        "selector:login.username"
    )
