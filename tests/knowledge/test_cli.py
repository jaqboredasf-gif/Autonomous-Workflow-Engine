"""The command surface, including the two commands that change trust.

``approve`` and ``invalidate`` both require ``--by``. That is not politeness:
a decision that overrides evidence has to name who made it, or the history
cannot answer why the system believes what it believes.
"""

from __future__ import annotations

import json

import pytest

from awe_knowledge import KnowledgeStore, TrustLevel, cli
from awe_knowledge.adapters import tegg_portal
from conftest import ENVIRONMENT, INTEGRATION, TENANT

from test_tegg_adapter import RUN_A, RUN_B, USERNAME_SELECTOR

TEGG = ("--tenant", "lippolis", "--integration", "tegg-pro",
        "--environment", "production")


@pytest.fixture
def seeded(tmp_path, clock):
    """A store with real trust levels, reached the only way allowed."""
    store = KnowledgeStore(tmp_path / "knowledge")
    for execution_id, path in (("run-a", RUN_A), ("run-b", RUN_B)):
        run = tegg_portal.open_run(store, execution_id=execution_id, clock=clock)
        run.open()
        tegg_portal.ingest_observations(run, path)
        run.close()
    return store


def _run(store, *args) -> int:
    return cli.main(["knowledge", *args, "--root", str(store.root), *TEGG])


def test_inspect_lists_what_is_known(seeded, capsys):
    assert _run(seeded, "inspect") == 0
    out = capsys.readouterr().out
    assert "lippolis/tegg-pro/production" in out
    assert "VERIFIED" in out and USERNAME_SELECTOR in out


def test_inspect_filters_by_kind_and_trust(seeded, capsys):
    assert _run(seeded, "inspect", "--kind", "selector", "--trust", "VERIFIED") == 0
    out = capsys.readouterr().out
    assert USERNAME_SELECTOR in out
    assert "navigation:" not in out


def test_validate_passes_on_a_healthy_store(seeded, capsys):
    assert _run(seeded, "validate") == 0
    assert "ok" in capsys.readouterr().out


def test_validate_fails_on_a_broken_store(seeded, capsys):
    path = seeded.path_for("lippolis", "tegg-pro", "production")
    raw = json.loads(path.read_text(encoding="utf-8"))
    raw["records"][USERNAME_SELECTOR]["payload"].pop("preferred")
    path.write_text(json.dumps(raw), encoding="utf-8")

    assert _run(seeded, "validate") == 1
    assert "problem" in capsys.readouterr().out


def test_degraded_shows_what_stopped_working(seeded, capsys):
    assert _run(seeded, "degraded") == 0
    out = capsys.readouterr().out
    # Run B's visit list came back empty, so that record and only that record
    # is in trouble.
    assert "navigation:site-visit-list" in out
    assert "DEGRADED" in out


def test_changes_reads_the_append_only_history(seeded, capsys):
    assert _run(seeded, "changes") == 0
    out = capsys.readouterr().out
    assert "-> VERIFIED" in out
    assert "run-b" in out


def test_invalidate_requires_a_name(seeded):
    with pytest.raises(SystemExit):
        _run(seeded, "invalidate", "--record", USERNAME_SELECTOR,
             "--reason", "because")


def test_invalidate_writes_a_record_off_and_says_who_did_it(seeded, capsys):
    assert _run(seeded, "invalidate", "--record", USERNAME_SELECTOR,
                "--reason", "the form was rebuilt", "--by", "jack") == 0

    document = seeded.load("lippolis", "tegg-pro", "production")
    assert document.records[USERNAME_SELECTOR].trust is TrustLevel.INVALID
    history = seeded.history("lippolis", "tegg-pro", "production")
    assert "invalidated by jack" in history[-1]["note"]


def test_restore_puts_a_record_back_to_its_last_known_good(seeded, capsys):
    _run(seeded, "invalidate", "--record", USERNAME_SELECTOR, "--reason", "oops",
         "--by", "jack")
    assert _run(seeded, "restore", "--record", USERNAME_SELECTOR, "--by", "jack") == 0

    document = seeded.load("lippolis", "tegg-pro", "production")
    assert document.records[USERNAME_SELECTOR].trust is TrustLevel.VERIFIED


def test_restore_says_so_when_there_is_nothing_to_restore(seeded, capsys):
    record_id = "navigation:site-visit-actions"
    assert _run(seeded, "restore", "--record", record_id, "--by", "jack") == 1
    assert "no last-known-good" in capsys.readouterr().out


def test_export_writes_a_bundle_a_later_session_can_read(seeded, tmp_path, capsys):
    out = tmp_path / "handoff.json"
    assert _run(seeded, "export", "--out", str(out)) == 0

    bundle = json.loads(out.read_text(encoding="utf-8"))
    assert bundle["validation"]["ok"] is True
    assert USERNAME_SELECTOR in bundle["document"]["records"]
    assert bundle["history"]
    assert "VERIFIED" in bundle["how_to_use"]


def test_ingest_feeds_a_live_runs_observations_in(tmp_path, capsys):
    store = KnowledgeStore(tmp_path / "knowledge")
    assert cli.main(["knowledge", "ingest", "--observations", str(RUN_A),
                     "--root", str(store.root), *TEGG]) == 0
    out = capsys.readouterr().out
    assert "record(s) touched" in out
    assert "-> CANDIDATE" in out

    document = store.load("lippolis", "tegg-pro", "production")
    assert document.records[USERNAME_SELECTOR].trust is TrustLevel.CANDIDATE


def test_a_missing_store_is_an_error_not_a_traceback(tmp_path, capsys):
    code = cli.main(["knowledge", "inspect", "--root", str(tmp_path / "nothing"),
                     *TEGG])
    assert code == 1
    assert "error: no knowledge for" in capsys.readouterr().out


def test_pending_reports_an_empty_queue_plainly(seeded, capsys):
    assert _run(seeded, "pending") == 0
    assert "nothing waiting" in capsys.readouterr().out
