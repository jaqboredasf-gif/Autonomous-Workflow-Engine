"""The repository command's contract: what it prints and what it exits with.

The full mock run takes minutes and is exercised operationally, not here. What
is tested here is everything around it -- argument handling, preflight gating,
the summary, and above all that a failing run really does exit non-zero. A
harness that reports failures and then exits 0 is worse than no harness.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from tegg import mock_runner, preflight, results

REPO_ROOT = Path(__file__).resolve().parents[1]


def _assets(tmp_path: Path) -> Path:
    folder = tmp_path / "static"
    folder.mkdir()
    for name in preflight.REQUIRED_ASSETS:
        (folder / name).write_bytes(b"%PDF-1.4\n")
    return folder


def _report(*, acceptable: bool) -> results.RunReport:
    report = results.RunReport(job_id="mock-job", portal_url="http://127.0.0.1:1")
    good = report.add(results.ReportResult(report_id="problem_count_summary"))
    good.generation_status = results.COMPLETED
    good.export_status = results.PASSED
    good.validation_status = results.PASSED

    cert = report.add(results.ReportResult(report_id="certificate"))
    cert.generation_status = results.COMPLETED
    cert.export_status = results.PASSED
    cert.validation_status = results.PASSED
    cert.block_finalization("the signature cannot be automated")

    if not acceptable:
        bad = report.add(results.ReportResult(report_id="eds_all_problems"))
        bad.fail("the export served HTML", root_cause="export/response_was_not_a_pdf")

    report.assembled = "DRAFT - TEGG_Northwind_Bay_2026-03-11.pdf"
    report.assembled_pages = 31
    report.acceptance = {
        "all_ten_sections_generated": {"ok": True, "detail": "10/10 sections"},
        "every_section_validated": {
            "ok": acceptable,
            "detail": "ok" if acceptable else "eds_all_problems=failed",
        },
    }
    return report


# --- argument handling ------------------------------------------------------


def test_the_default_work_root_and_assets_are_inside_the_repository():
    # The whole point of the command: it must not reach into ~/.claude/jobs.
    for default in (mock_runner.DEFAULT_WORK_ROOT, mock_runner.DEFAULT_ASSETS):
        assert REPO_ROOT in default.parents or default == REPO_ROOT
        assert ".claude/jobs" not in str(default)


def test_defaults_parse_without_any_arguments():
    args = mock_runner.build_parser().parse_args([])
    assert args.work_root == mock_runner.DEFAULT_WORK_ROOT
    assert args.assets == mock_runner.DEFAULT_ASSETS
    assert args.max_attempts == 2
    assert args.headed is False
    assert args.preflight is False


def test_every_path_flag_is_accepted(tmp_path):
    args = mock_runner.build_parser().parse_args(
        [
            "--work-root", str(tmp_path / "w"),
            "--assets", str(tmp_path / "a"),
            "--cases", str(tmp_path / "c.yaml"),
            "--report", str(tmp_path / "r.json"),
            "--max-attempts", "5",
            "--headed",
            "--slow",
            "--quiet",
        ]
    )
    assert args.max_attempts == 5
    assert args.headed and args.slow and args.quiet


# --- preflight gating -------------------------------------------------------


def test_preflight_alone_exits_zero_when_ready(capsys):
    code = mock_runner.main(["--preflight", "--quiet"])
    assert code == 0
    assert "PREFLIGHT: ready" in capsys.readouterr().out


def test_preflight_exits_two_when_a_prerequisite_blocks(tmp_path, capsys):
    code = mock_runner.main(
        ["--preflight", "--quiet", "--assets", str(tmp_path / "absent")]
    )
    assert code == 2
    assert "not ready" in capsys.readouterr().out


def test_a_failing_preflight_stops_the_run_before_a_browser_starts(
    tmp_path, capsys, monkeypatch
):
    def explode(*args, **kwargs):  # pragma: no cover - must never be reached
        raise AssertionError("the run started despite a failing preflight")

    monkeypatch.setattr(mock_runner.Runner, "run", explode)
    code = mock_runner.main(
        ["--quiet", "--assets", str(tmp_path / "absent"), "--work-root", str(tmp_path)]
    )
    assert code == 2
    assert "refusing to start" in capsys.readouterr().err


def test_skip_preflight_gets_past_the_gate(tmp_path, monkeypatch, capsys):
    # Proves --skip-preflight is what carries the run past the gate: the same
    # arguments without it are refused by the test above.
    monkeypatch.setattr(
        mock_runner.Runner, "run", lambda self: _report(acceptable=True)
    )
    monkeypatch.setattr(
        mock_runner.Runner, "acceptable", property(lambda self: True)
    )
    code = mock_runner.main(
        [
            "--skip-preflight",
            "--quiet",
            "--assets", str(_assets(tmp_path)),
            "--work-root", str(tmp_path / "work"),
        ]
    )
    assert code == 0


# --- exit codes -------------------------------------------------------------


def test_a_missing_assets_folder_exits_two(tmp_path, capsys):
    code = mock_runner.main(
        [
            "--skip-preflight",
            "--assets", str(tmp_path / "absent"),
            "--work-root", str(tmp_path / "work"),
        ]
    )
    assert code == 2
    assert "assets folder not found" in capsys.readouterr().err


def test_a_broken_case_file_exits_two(tmp_path, capsys):
    cases = tmp_path / "cases.yaml"
    cases.write_text("cases:\n  - id: x\n    kind: nonsense\n", encoding="utf-8")
    code = mock_runner.main(
        [
            "--skip-preflight",
            "--assets", str(_assets(tmp_path)),
            "--work-root", str(tmp_path / "work"),
            "--cases", str(cases),
        ]
    )
    assert code == 2
    assert "case file problem" in capsys.readouterr().err


def test_a_case_file_that_misses_a_section_exits_two(tmp_path, capsys):
    cases = tmp_path / "cases.yaml"
    cases.write_text(
        "job: {}\ncases:\n"
        "  - id: problem_count_summary\n"
        "    kind: portal_report\n"
        "    portal_label: Problem Count Summary\n",
        encoding="utf-8",
    )
    code = mock_runner.main(
        [
            "--skip-preflight",
            "--assets", str(_assets(tmp_path)),
            "--work-root", str(tmp_path / "work"),
            "--cases", str(cases),
        ]
    )
    assert code == 2
    assert "does not cover every section" in capsys.readouterr().err


def test_an_unacceptable_run_exits_one_and_says_so(tmp_path, monkeypatch, capsys):
    # The negative-path proof. Everything ran; a criterion failed; the command
    # must not report success.
    monkeypatch.setattr(
        mock_runner.Runner, "run", lambda self: _report(acceptable=False)
    )
    monkeypatch.setattr(
        mock_runner.Runner, "acceptable", property(lambda self: False)
    )
    code = mock_runner.main(
        [
            "--skip-preflight",
            "--assets", str(_assets(tmp_path)),
            "--work-root", str(tmp_path / "work"),
        ]
    )
    assert code == 1
    assert "VERDICT: NOT acceptable" in capsys.readouterr().out


def test_an_acceptable_run_exits_zero(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(
        mock_runner.Runner, "run", lambda self: _report(acceptable=True)
    )
    monkeypatch.setattr(
        mock_runner.Runner, "acceptable", property(lambda self: True)
    )
    code = mock_runner.main(
        [
            "--skip-preflight",
            "--assets", str(_assets(tmp_path)),
            "--work-root", str(tmp_path / "work"),
        ]
    )
    assert code == 0
    assert "VERDICT: acceptable" in capsys.readouterr().out


def test_the_json_result_is_written_where_it_says(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(
        mock_runner.Runner, "run", lambda self: _report(acceptable=True)
    )
    monkeypatch.setattr(
        mock_runner.Runner, "acceptable", property(lambda self: True)
    )
    destination = tmp_path / "elsewhere" / "result.json"
    mock_runner.main(
        [
            "--skip-preflight",
            "--assets", str(_assets(tmp_path)),
            "--work-root", str(tmp_path / "work"),
            "--report", str(destination),
        ]
    )
    assert destination.is_file()
    assert "problem_count_summary" in destination.read_text(encoding="utf-8")


def test_a_missing_playwright_exits_two(tmp_path, monkeypatch, capsys):
    def no_playwright(self):
        raise ImportError("No module named 'playwright'")

    monkeypatch.setattr(mock_runner.Runner, "run", no_playwright)
    code = mock_runner.main(
        [
            "--skip-preflight",
            "--assets", str(_assets(tmp_path)),
            "--work-root", str(tmp_path / "work"),
        ]
    )
    assert code == 2
    assert "playwright is required" in capsys.readouterr().err


# --- the summary ------------------------------------------------------------


def test_the_summary_names_the_blocked_section_and_its_blocker():
    text = mock_runner.summarise(_report(acceptable=True))
    assert "BLOCKED" in text
    assert "the signature cannot be automated" in text
    assert "31 pages" in text


def test_the_summary_lists_failures_with_their_root_cause():
    text = mock_runner.summarise(_report(acceptable=False))
    assert "the export served HTML" in text
    assert "export/response_was_not_a_pdf" in text
    assert "VERDICT: NOT acceptable" in text


def test_a_long_case_id_does_not_run_into_the_next_column():
    report = _report(acceptable=True)
    report.results[0].report_id = "recommendation-and-estimate-malformed"
    for line in mock_runner.summarise(report).splitlines():
        if line.startswith("recommendation-and-estimate-malformed"):
            assert line.startswith("recommendation-and-estimate-malformed ")
            break
    else:  # pragma: no cover - the row must be there
        pytest.fail("the renamed case did not appear in the summary")


def test_quiet_prints_only_the_verdict():
    text = mock_runner.summarise(_report(acceptable=True), quiet=True)
    assert "VERDICT" in text
    assert "certificate" not in text
