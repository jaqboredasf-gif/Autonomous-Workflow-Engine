"""The one command that runs the controlled end-to-end mock system.

    python -m tegg.mock_runner

It signs in to a local mock portal, walks the proven report route, exports every
section, converts the certificate, splits the IR cover, assembles a ten-section
DRAFT, validates every artifact, prints a summary, writes a JSON result, and
exits non-zero if any acceptance criterion fails.

Everything it touches is local: the portal is bound to 127.0.0.1, and all output
lands under ``--work-root``. It sends nothing, uploads nothing, and needs no
credentials -- the mock's account is a fake constant in
:mod:`tegg.mockportal`.

Prerequisites are checked first, and the run refuses to start if any of them
blocks. ``--preflight`` performs that check and exits without running anything.

Exit codes
    0  every acceptance criterion met (or, with --preflight, ready to run)
    1  at least one criterion failed (the summary names which)
    2  the run could not start -- failed preflight, bad case file, missing
       assets, no browser
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import mockassets, mockcases, mockportal, preflight, results
from .mockrun import Runner, Settings

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_WORK_ROOT = REPO_ROOT / "mock-run"
DEFAULT_ASSETS = REPO_ROOT / "assets" / "static"

BAR = "-" * 78


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m tegg.mock_runner",
        description=__doc__.splitlines()[0],
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--work-root",
        type=Path,
        default=DEFAULT_WORK_ROOT,
        help=f"where job workspaces are written (default: {DEFAULT_WORK_ROOT})",
    )
    parser.add_argument(
        "--assets",
        type=Path,
        default=DEFAULT_ASSETS,
        help="folder holding the two fixed PDF sections",
    )
    parser.add_argument(
        "--cases",
        type=Path,
        default=None,
        help=f"case file (default: {mockcases.DEFAULT_PATH})",
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=None,
        help="where to write the JSON result (default: <work-root>/mock-result.json)",
    )
    parser.add_argument(
        "--max-attempts",
        type=int,
        default=2,
        help="bounded retries per case (default: 2). A case whose root cause "
             "repeats is not retried again regardless.",
    )
    parser.add_argument(
        "--headed",
        action="store_true",
        help="show the browser (for watching the route)",
    )
    parser.add_argument(
        "--slow",
        action="store_true",
        help="use timings closer to the live portal's, to exercise the waits",
    )
    parser.add_argument(
        "--quiet", action="store_true", help="only print the verdict"
    )
    parser.add_argument(
        "--preflight",
        action="store_true",
        help="check prerequisites and exit without running anything",
    )
    parser.add_argument(
        "--skip-preflight",
        action="store_true",
        help="run without the prerequisite check (not recommended)",
    )
    parser.add_argument(
        "--synthesize-assets",
        action="store_true",
        help="write clearly-marked stand-ins for the two fixed sections if they "
             "are absent, so a clean clone can run. Anything assembled with a "
             "stand-in in it must not be sent.",
    )
    return parser


def _timing(slow: bool) -> mockportal.Timing:
    if not slow:
        return mockportal.Timing()
    # Still far short of live (~20 s for Print Report), but slow enough that a
    # driver which does not actually wait will fail here.
    return mockportal.Timing(
        login_ms=800, print_report_ms=3000, viewer_ready_ms=2500, list_load_ms=800
    )


def summarise(report: results.RunReport, *, quiet: bool = False) -> str:
    lines: list[str] = []
    counts = report.counts()

    if not quiet:
        # Sized to the longest id actually present, so a long case name pushes
        # the columns across rather than running into the next one.
        width = max([len(r.report_id) for r in report.results] + [len("case")]) + 2
        lines += [
            BAR,
            f"mock run   {report.job_id}",
            f"portal     {report.portal_url}  (local mock, no live system)",
            f"cases      {counts['total']}  "
            f"passed {counts['passed']}  failed {counts['failed']}",
            BAR,
            f"{'case':<{width}}{'gen':<11}{'export':<16}{'valid':<10}review",
        ]
        for result in report.results:
            review = "HUMAN" if result.review_status != results.AUTOMATED else "-"
            if result.finalization_status == results.BLOCKED:
                review = "BLOCKED"
            lines.append(
                f"{result.report_id:<{width}}{result.generation_status:<11}"
                f"{result.export_status:<16}{result.validation_status:<10}{review}"
            )

        problems = [r for r in report.results if not r.ok]
        if problems:
            lines += ["", "failures"]
            for result in problems:
                lines.append(f"  {result.report_id}: {result.failure_reason}")
                if result.root_cause:
                    lines.append(f"    root cause: {result.root_cause}")
                for name in result.missing_fields:
                    lines.append(f"    missing field: {name}")

        review = report.human_review_required
        if review:
            lines += ["", "human review required"]
            for result in review:
                for reason in result.human_review:
                    lines.append(f"  {result.report_id}: {reason}")

        blocked = report.blocked
        if blocked:
            lines += ["", "finalization blocked"]
            for result in blocked:
                lines.append(f"  {result.report_id}: {result.blocker}")

        if report.assembled:
            lines += [
                "",
                f"assembled  {report.assembled}",
                f"           {report.assembled_pages} pages",
            ]
        for note in report.notes:
            lines.append(f"note       {note}")

        lines += ["", "acceptance criteria"]
        for name, criterion in report.acceptance.items():
            mark = "PASS" if criterion["ok"] else "FAIL"
            lines.append(f"  [{mark}] {name}: {criterion['detail']}")

    ok = all(c["ok"] for c in report.acceptance.values())
    lines += [BAR, "VERDICT: acceptable" if ok else "VERDICT: NOT acceptable"]
    return "\n".join(lines)


def check_prerequisites(args, *, verbose: bool = True) -> preflight.Preflight:
    checks = preflight.run(
        repo_root=REPO_ROOT,
        work_root=Path(args.work_root),
        assets_dir=Path(args.assets),
        cases_path=args.cases,
    )
    if verbose:
        print(BAR)
        print("preflight")
        print(BAR)
        print(checks)
        print(BAR)
        print("PREFLIGHT: ready" if checks.ok else "PREFLIGHT: not ready")
    return checks


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if args.synthesize_assets:
        written = mockassets.write(Path(args.assets))
        for path in written.created:
            print(f"stand-in   {path.name} ({mockassets.MARKER})")
        if written.created:
            print(
                "NOTE: these are stand-ins, not the real sections. A report "
                "assembled with one in it must not be sent.\n"
            )

    if args.preflight:
        checks = check_prerequisites(args, verbose=not args.quiet)
        if args.quiet:
            print("PREFLIGHT: ready" if checks.ok else "PREFLIGHT: not ready")
        return 0 if checks.ok else 2

    if not args.skip_preflight:
        checks = check_prerequisites(args, verbose=not args.quiet)
        if not checks.ok:
            print(
                "refusing to start: "
                + "; ".join(f"{i.name} ({i.detail})" for i in checks.blockers),
                file=sys.stderr,
            )
            return 2
        print()

    if not Path(args.assets).is_dir():
        print(
            f"assets folder not found: {args.assets}\n"
            "It must hold 'ESA Table of Contents.pdf' and 'TEGGPro View "
            "Customer Instructions.pdf'.",
            file=sys.stderr,
        )
        return 2

    try:
        settings = Settings(
            work_root=Path(args.work_root),
            assets_dir=Path(args.assets),
            cases_path=args.cases,
            headless=not args.headed,
            max_attempts=max(1, args.max_attempts),
            timing=_timing(args.slow),
        )
        runner = Runner(settings)
    except mockcases.CaseError as exc:
        print(f"case file problem: {exc}", file=sys.stderr)
        return 2

    missing = runner.matrix.missing_types()
    if missing:
        print(
            "the case file does not cover every section of the report; missing: "
            + ", ".join(missing),
            file=sys.stderr,
        )
        return 2

    try:
        report = runner.run()
    except ImportError as exc:
        print(f"playwright is required for the mock run: {exc}", file=sys.stderr)
        return 2

    destination = Path(args.report) if args.report else (
        Path(args.work_root) / "mock-result.json"
    )
    report.write(destination)

    print(summarise(report, quiet=args.quiet))
    print(f"json       {destination}")
    return 0 if runner.acceptable else 1


if __name__ == "__main__":
    raise SystemExit(main())
