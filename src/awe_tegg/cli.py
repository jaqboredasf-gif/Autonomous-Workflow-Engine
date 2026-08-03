"""The operator entry point. One operation, four verbs, no Claude Code.

    python -m awe_tegg preflight
    python -m awe_tegg run documentation-read --service-file config/service.yaml
    python -m awe_tegg resume --run-id documentation-read-20260731T143000+0000
    python -m awe_tegg status [--run-id ...]

Deliberately narrow. There is exactly one operation because there is exactly one
thing that has been proved end to end against the live portal, and a menu of
half-proved options is how an operator ends up trusting the wrong one.

Exit codes, which is what a scheduler reads:

    0   finished, read-only
    1   could not continue
    2   stopped and needs a person (and says what for)
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from . import report as report_module
from . import visit_operation as visit_module
from . import workspace_root as root_module
from .checkpoint import COMPLETED, ESCALATED, RunLedger
from .operation import (
    OPERATION,
    OperationError,
    Settings,
    credentials_present,
    load_settings,
    result_from,
    start,
)
from .operation import resume as resume_operation

DEFAULT_WORK_ROOT = Path("work")
EXIT_OK, EXIT_FAILED, EXIT_NEEDS_HUMAN = 0, 1, 2

#: The service file a coworker gets if they name none. Both operations read the
#: same non-secret settings, so requiring the flag only ever produced a typo.
DEFAULT_SERVICE_FILE = Path("config/service.yaml")


#: The name this file used to have. Scripts and runbook copies in the wild
#: still say it, so it keeps working rather than failing on a rename.
LEGACY_SERVICE_FILES = ("config/service.documentation-read.yaml",)


def _service_file(args: argparse.Namespace) -> Path | None:
    """The service file to read: what was asked for, or the default if it exists."""
    named = getattr(args, "service_file", None)
    if named:
        asked = root_module.resolve(named)
        if not asked.exists() and str(named) in LEGACY_SERVICE_FILES:
            moved = root_module.resolve(DEFAULT_SERVICE_FILE)
            if moved.exists():
                print(f"note: {named} is now {DEFAULT_SERVICE_FILE}, and is the "
                      "default -- you can drop --service-file entirely.",
                      file=sys.stderr)
                return moved
        return asked
    fallback = root_module.resolve(DEFAULT_SERVICE_FILE)
    return fallback if fallback.exists() else None


def _settings(args: argparse.Namespace) -> Settings:
    return load_settings(
        _service_file(args),
        headless=not getattr(args, "headed", False),
        base_url=getattr(args, "base_url", None),
        discovery_actions=getattr(args, "discovery_actions", None),
        discovery_seconds=getattr(args, "discovery_seconds", None),
    )


def _work_root(args: argparse.Namespace) -> Path:
    """Where run folders go, anchored to the installation unless overridden."""
    return root_module.resolve(getattr(args, "work_root", None) or DEFAULT_WORK_ROOT)


def _finish(result, as_json: bool) -> int:
    print(report_module.render_json(result) if as_json else report_module.render(result))
    if result.status == COMPLETED:
        return EXIT_OK
    if result.status == ESCALATED or result.human_action_required:
        return EXIT_NEEDS_HUMAN
    return EXIT_FAILED


# -- preflight, shared by doctor and by every run --------------------------
def preflight_problems(args, *, operation: str = "") -> list[str]:
    """Everything wrong that can be known without opening a browser.

    Called by ``doctor`` and by every ``run`` before the browser starts. The
    ordering is the point: the rate card used to be validated at step 10 of 13,
    so a coworker in the wrong directory signed in, retrieved two customers'
    reports, parsed them, and *then* learned they were missing a config file.
    Anything that can be known before the portal is touched is known here.
    """
    problems: list[str] = []

    try:
        root_module.require_installation()
    except root_module.NotInInstallation as error:
        # Nothing else is worth reporting: every path below would be a guess.
        return [str(error)]

    for name in credentials_present():
        problems.append(
            f"{name} is not set in this shell. Set it with: export {name}='...'"
        )

    try:
        import playwright  # noqa: F401
    except ImportError:
        problems.append(
            "playwright is not installed -- pip install -e '.[portal,dev]' && "
            "python -m playwright install chromium"
        )

    service = _service_file(args)
    if service is not None and not Path(service).exists():
        problems.append(f"no service file at {service}")

    if operation == visit_module.OPERATION:
        card = root_module.resolve(
            getattr(args, "rate_card", None) or visit_module.DEFAULT_RATE_CARD
        )
        try:
            from .estimate import RateCard

            RateCard.load(card)
        except Exception as error:                          # noqa: BLE001
            problems.append(str(error))

    work_root = _work_root(args)
    for path in (work_root, work_root / "operations"):
        ok, detail = _writable(path)
        if not ok:
            problems.append(f"{path}: {detail}")

    return problems


# -- commands -------------------------------------------------------------
def cmd_preflight(args) -> int:
    """Everything that must be true before a coworker starts a run."""
    ok = True
    print("credentials")
    missing = credentials_present()
    for name in ("TEGG_USERNAME", "TEGG_PASSWORD"):
        present = name not in missing
        # The name is printed. The value never is, and is never read here.
        print(f"  {'OK     ' if present else 'MISSING'}  {name} (from the environment)")
        ok = ok and present

    print("\nbrowser")
    try:
        import playwright  # noqa: F401

        print("  OK       playwright is installed")
    except ImportError:
        ok = False
        print("  MISSING  playwright -- pip install -e '.[portal]' && "
              "python -m playwright install chromium")

    print("\nknowledge")
    try:
        from awe_knowledge.store import KnowledgeStore
        from awe_knowledge.validator import validate_document

        settings = _settings(args)
        document = KnowledgeStore(settings.store_root).load(
            settings.tenant, settings.integration, settings.environment
        )
        validation = validate_document(document)
        usable = [
            r for r in document.records.values()
            if r.usable("", allow_candidate=True)
        ]
        print(f"  {'OK     ' if validation.ok else 'PROBLEM'}  "
              f"{len(document.records)} record(s), {len(usable)} usable, "
              f"document v{document.document_version}")
        for problem in validation.problems[:5]:
            print(f"           {problem}")
        ok = ok and validation.ok
    except Exception as error:                              # noqa: BLE001
        ok = False
        print(f"  PROBLEM  {error}")

    print(
        f"\nReady. Run:  python -m awe_tegg run {OPERATION}"
        if ok else "\nNot ready: resolve the MISSING/PROBLEM items above."
    )
    return EXIT_OK if ok else EXIT_FAILED


def cmd_doctor(args) -> int:
    """Everything that must be true before a coworker starts, checked in order.

    Reads only. It never signs in, never sends a credential anywhere, never
    prints one, and never touches a TEGG record. ``--online`` asks the portal
    for its sign-in page and nothing else, which is the same request a browser
    makes before anybody types anything.
    """
    # Three states, not two. A placeholder rate card is not a failure -- the
    # tool is built to run on one -- but reporting it as OK let a coworker
    # believe the money meant something. WARN says "this will work, and here is
    # what you are getting", and does not stop them.
    checks: list[tuple[str, str, str]] = []

    def check(ok: bool, name: str, detail: str = "", *, warn: bool = False) -> None:
        checks.append(("OK" if ok else ("WARN" if warn else "PROBLEM"), name, detail))

    print("python")
    check(sys.version_info >= (3, 10), "python 3.10 or newer",
          f"running {sys.version.split()[0]}"
          if sys.version_info >= (3, 10)
          else f"this is {sys.version.split()[0]}; install 3.10 or newer")
    _say(checks[-1])

    print("\ndependencies")
    for module, hint in (
        ("playwright", "pip install -e '.[portal]' && python -m playwright install chromium"),
        ("pypdf", "pip install -e '.'"),
        ("yaml", "pip install -e '.'"),
    ):
        try:
            __import__(module)
            check(True, module, "importable")
        except ImportError:
            check(False, module, hint)
        _say(checks[-1])

    print("\nbrowser")
    try:
        from tegg.browser import find_chromium

        binary = find_chromium()
        check(bool(binary), "a chromium build playwright can launch",
              str(binary) if binary
              else "run: python -m playwright install chromium")
    except Exception as error:                              # noqa: BLE001
        check(False, "a chromium build playwright can launch", str(error))
    _say(checks[-1])

    print("\ncredentials")
    missing = credentials_present()
    for name in ("TEGG_USERNAME", "TEGG_PASSWORD"):
        # The name is printed. The value is never read, printed or logged.
        check(name not in missing, f"{name} is set in this shell",
              "set it with: export %s='...'  (this terminal only)" % name
              if name in missing else "present; its value is never read here")
        _say(checks[-1])

    print("\nwho this is configured to act as")
    try:
        identity = _settings(args)
        service = _service_file(args)
        # Named explicitly, because a coworker at a second contractor would
        # otherwise have no signal that these came from somebody else's setup.
        check(True, f"{identity.contractor} at {identity.base_url}",
              f"tenant {identity.tenant}/{identity.integration}/"
              f"{identity.environment}, from "
              + (str(service) if service else "built-in defaults -- there is no "
                 "service file, so this is whoever the code was written for"))
    except Exception as error:                              # noqa: BLE001
        check(False, "the service settings", str(error))
    _say(checks[-1])

    print("\nwhere this installation lives")
    check(root_module.in_installation(), root_module.describe_root(),
          "you are inside it"
          if root_module.in_installation()
          else f"you are in {Path.cwd()} -- run from the directory above")
    _say(checks[-1])

    print("\nwritable paths")
    work_root = _work_root(args)
    for path in (work_root, work_root / "operations",
                 root_module.resolve("data/operational_knowledge")):
        ok, detail = _writable(path)
        check(ok, f"{path}", detail)
        _say(checks[-1])

    print("\nknowledge")
    try:
        from awe_knowledge.store import KnowledgeStore
        from awe_knowledge.validator import validate_document

        settings = _settings(args)
        document = KnowledgeStore(settings.store_root).load(
            settings.tenant, settings.integration, settings.environment
        )
        validation = validate_document(document)
        usable = [r for r in document.records.values()
                  if r.usable("", allow_candidate=True)]
        check(validation.ok,
              f"{settings.tenant}/{settings.integration}/{settings.environment}",
              f"{len(document.records)} record(s), {len(usable)} usable, "
              f"document v{document.document_version}"
              + ("" if validation.ok else "; " + "; ".join(validation.problems[:3])))
    except Exception as error:                              # noqa: BLE001
        check(False, "the knowledge store", str(error))
    _say(checks[-1])

    print("\nrate card (only needed for visit-findings)")
    card_path = root_module.resolve(
        args.rate_card or visit_module.DEFAULT_RATE_CARD)
    try:
        from .estimate import RateCard

        card = RateCard.load(card_path)
        # A placeholder card is not a failure -- the tool is designed to run on
        # one -- but reporting it as OK let a coworker believe the money meant
        # something. It is a warning, and it says what to do about it.
        check(not card.placeholder, str(card_path),
              f"real rates, {card.currency} {card.labour_rate_per_hour}/h"
              if not card.placeholder else
              "PLACEHOLDER rates. Runs work and every total is stamped NOT "
              "PRICED. For real figures: cp config/estimating.example.yaml "
              "config/estimating.yaml, put your numbers in it, set "
              "placeholder: false",
              warn=True)
    except Exception as error:                              # noqa: BLE001
        check(False, str(card_path), str(error))
    _say(checks[-1])

    if args.online:
        print("\nconnectivity (no sign-in, no credentials sent)")
        settings = _settings(args)
        ok, detail = _reachable(settings.base_url + settings.login_path)
        check(ok, settings.base_url, detail)
        _say(checks[-1])

    failed = [name for status, name, _ in checks if status == "PROBLEM"]
    warned = [name for status, name, _ in checks if status == "WARN"]
    print()
    if failed:
        print(f"Not ready. {len(failed)} problem(s) to resolve:")
        for name in failed:
            print(f"  - {name}")
        return EXIT_FAILED
    if warned:
        print(f"Ready, with {len(warned)} thing(s) worth knowing:")
        for name in warned:
            print(f"  - {name}")
        print()
    print("Ready. Start with:")
    print(f"  ./scripts/{visit_module.OPERATION}.sh")
    print(f"  (or: awe-tegg run {visit_module.OPERATION})")
    print("\nThis checks the live portal operations. For the offline\n"
          "report-assembly stages run:  tegg doctor")
    return EXIT_OK


def _say(entry: tuple[str, str, str]) -> None:
    status, name, detail = entry
    print(f"  {status:<7}  {name}" + (f" -- {detail}" if detail else ""))


def _writable(path: Path) -> tuple[bool, str]:
    """Whether a run could write here -- without making it so.

    This used to call ``mkdir(parents=True)`` and then report the directory as
    writable, which is true and beside the point: ``doctor`` is documented as
    changing nothing, and it was creating a directory tree wherever it was run
    from. So the probe walks up to the nearest directory that does exist and
    asks the operating system, instead of creating its way to an answer.
    """
    path = Path(path)
    existing = path
    while not existing.exists():
        parent = existing.parent
        if parent == existing:
            return False, "no part of this path exists"
        existing = parent

    if not existing.is_dir():
        return False, f"{existing} is not a directory"
    if not os.access(existing, os.W_OK | os.X_OK):
        return False, f"not writable (nearest existing directory is {existing})"
    if existing != path:
        return True, f"will be created under {existing}"
    return True, "writable"


def _reachable(url: str, timeout: float = 15.0) -> tuple[bool, str]:
    """Ask the portal for its sign-in page. Sends nothing but the request."""
    import urllib.error
    import urllib.request

    request = urllib.request.Request(url, method="GET",
                                     headers={"User-Agent": "awe-tegg-doctor"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return True, f"answered HTTP {response.status}"
    except urllib.error.HTTPError as error:
        # A 4xx still proves the host is there and answering.
        return True, f"answered HTTP {error.code}"
    except Exception as error:                              # noqa: BLE001
        return False, f"did not answer: {error}"


def _visit_settings(args) -> "visit_module.VisitSettings":
    return visit_module.VisitSettings(
        site_visit=getattr(args, "site_visit", "") or "",
        rate_card=root_module.resolve(
            getattr(args, "rate_card", None) or visit_module.DEFAULT_RATE_CARD),
        include_corrected=bool(getattr(args, "include_corrected", False)),
    )


def _blocked(args, operation: str) -> int | None:
    """Stop before the browser opens if anything checkable is wrong.

    Returns an exit code to return, or None to carry on. Nothing here touches
    the portal, so a coworker who is missing a file learns it in a second
    rather than after two customers' reports have been downloaded.
    """
    problems = preflight_problems(args, operation=operation)
    if not problems:
        return None
    print("Cannot start. Nothing was run and the portal was not contacted.\n",
          file=sys.stderr)
    for problem in problems:
        print(f"  - {problem}", file=sys.stderr)
    print("\nRun 'python -m awe_tegg doctor' for the full picture.",
          file=sys.stderr)
    return EXIT_NEEDS_HUMAN


def cmd_run(args) -> int:
    blocked = _blocked(args, args.operation)
    if blocked is not None:
        return blocked

    settings = _settings(args)
    print(f"starting {args.operation} against {settings.base_url}")
    print("(credentials are read from the environment and are never stored, "
          "printed or screenshotted)\n")
    if args.operation == visit_module.OPERATION:
        result = visit_module.start(
            settings, _visit_settings(args),
            work_root=_work_root(args), run_id=args.run_id,
        )
        return _finish_visit(result, args.json)
    result = start(settings, work_root=_work_root(args), run_id=args.run_id)
    return _finish(result, args.json)


def cmd_resume(args) -> int:
    work_root = _work_root(args)
    ledger = RunLedger.find(work_root, args.run_id)
    operation = str(ledger.data.get("operation", ""))
    blocked = _blocked(args, operation)
    if blocked is not None:
        return blocked
    settings = _settings(args)
    if operation == visit_module.OPERATION:
        result = visit_module.resume(
            settings, _visit_settings(args), args.run_id, work_root=work_root
        )
        return _finish_visit(result, args.json)
    result = resume_operation(settings, args.run_id, work_root=work_root)
    return _finish(result, args.json)


def _finish_visit(result, as_json: bool) -> int:
    print(report_module.render_json(result) if as_json
          else report_module.render_visit(result))
    if result.status == COMPLETED:
        return EXIT_OK
    if result.status == ESCALATED or result.human_action_required:
        return EXIT_NEEDS_HUMAN
    return EXIT_FAILED


def cmd_status(args) -> int:
    if args.run_id:
        ledger = RunLedger.find(_work_root(args), args.run_id)
        if str(ledger.data.get("operation", "")) == visit_module.OPERATION:
            return _finish_visit(visit_module.result_from(ledger), args.json)
        return _finish(result_from(ledger), args.json)

    work_root = _work_root(args)
    runs = RunLedger.list_runs(work_root)
    if not runs:
        print(f"no runs under {work_root / 'operations'}")
        return EXIT_OK
    for run_id in runs:
        ledger = RunLedger.find(work_root, run_id)
        steps = len(ledger.completed_steps())
        print(f"  {ledger.status:<12} {run_id:<44} {steps} step(s)")
    return EXIT_OK


# -- wiring ---------------------------------------------------------------
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m awe_tegg",
        description="Read-only TEGG portal operations for operators.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    def shared(child: argparse.ArgumentParser) -> None:
        child.add_argument(
            "--service-file", default=None,
            help="Non-secret service description (base URL, tenant, contractor). "
                 "Credentials are never read from it.",
        )
        child.add_argument(
            "--work-root", default=None, type=Path,
            help="Where run folders go. Relative paths resolve against the "
                 "installation, not your current directory.",
        )
        child.add_argument("--json", action="store_true")
        child.add_argument("--base-url", default=None)

    preflight = sub.add_parser("preflight", help="Check this machine is ready")
    shared(preflight)
    preflight.set_defaults(func=cmd_preflight)

    def visit_options(child: argparse.ArgumentParser) -> None:
        child.add_argument(
            "--site-visit", default=None,
            help="Which completed visit to read. Without it the standing rule "
                 "applies and the run prints which visit it chose and why.",
        )
        child.add_argument(
            "--rate-card", default=None,
            help="YAML rate card for the estimate. The one that ships is a "
                 "placeholder and every total built from it says so.",
        )
        child.add_argument(
            "--include-corrected", action="store_true",
            help="Also size items the technician already fixed on the visit.",
        )

    run_cmd = sub.add_parser("run", help="Start an operation")
    run_cmd.add_argument("operation", choices=[OPERATION, visit_module.OPERATION])
    shared(run_cmd)
    run_cmd.add_argument("--headed", action="store_true",
                         help="Show the browser instead of running it hidden")
    run_cmd.add_argument("--run-id", default=None)
    run_cmd.add_argument("--discovery-actions", type=int, default=None,
                         help="Hard cap on navigations during route discovery")
    run_cmd.add_argument("--discovery-seconds", type=float, default=None)
    visit_options(run_cmd)
    run_cmd.set_defaults(func=cmd_run)

    resume_cmd = sub.add_parser("resume", help="Continue from the last checkpoint")
    resume_cmd.add_argument("--run-id", required=True)
    shared(resume_cmd)
    resume_cmd.add_argument("--headed", action="store_true")
    visit_options(resume_cmd)
    resume_cmd.set_defaults(func=cmd_resume)

    doctor_cmd = sub.add_parser(
        "doctor", help="Check this machine can run an operation, changing nothing"
    )
    shared(doctor_cmd)
    doctor_cmd.add_argument(
        "--rate-card", default=None,
        help="Rate card to check, if you are running visit-findings",
    )
    doctor_cmd.add_argument(
        "--online", action="store_true",
        help="Also check the portal answers. Does not sign in and sends no "
             "credentials.",
    )
    doctor_cmd.set_defaults(func=cmd_doctor)

    status_cmd = sub.add_parser("status", help="Show one run, or list them all")
    status_cmd.add_argument("--run-id", default=None)
    shared(status_cmd)
    status_cmd.set_defaults(func=cmd_status)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except FileNotFoundError as error:
        print(f"error: {error}", file=sys.stderr)
        return EXIT_FAILED
    except OperationError as error:
        print(f"error: {error}", file=sys.stderr)
        return EXIT_NEEDS_HUMAN
    except KeyboardInterrupt:
        print("\ninterrupted. The run is checkpointed -- resume with:", file=sys.stderr)
        print("  python -m awe_tegg status", file=sys.stderr)
        return EXIT_NEEDS_HUMAN


if __name__ == "__main__":
    raise SystemExit(main())
