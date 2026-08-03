"""The command surface over the knowledge store.

Deliberately small, and deliberately weighted towards *reading*. Most of what
an operator needs is to see what the system believes, why it believes it, and
what it has stopped believing. The two commands that change trust --
``approve`` and ``invalidate`` -- both require a name, because a decision
nobody signed is not a decision.

Wired into the ``tegg`` CLI as ``tegg knowledge <command>``, but the module
knows nothing about TEGG beyond a default tenant, so a second integration
reuses it as it stands.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from .evidence import scan_for_secrets
from .lifecycle import decide_pending, open_pending
from .models import KnowledgeError, RecordKind, TrustLevel
from .promotion import confirm_invalid
from .runtime import utc_clock
from .store import KnowledgeStore
from .validator import validate_document

DEFAULT_TENANT = "lippolis"
DEFAULT_INTEGRATION = "tegg-pro"
DEFAULT_ENVIRONMENT = "production"


def _store(args: argparse.Namespace) -> KnowledgeStore:
    return KnowledgeStore(getattr(args, "root", None) or None)


def _load(args: argparse.Namespace):
    return _store(args).load(args.tenant, args.integration, args.environment)


def _emit(payload: Any, as_json: bool) -> None:
    if as_json:
        print(json.dumps(payload, indent=2, sort_keys=True))


# -- reading --------------------------------------------------------------
def cmd_inspect(args) -> int:
    document = _load(args)
    records = sorted(document.records.values(), key=lambda r: r.record_id)
    if args.kind:
        records = [r for r in records if r.kind is RecordKind(args.kind)]
    if args.trust:
        records = [r for r in records if r.trust is TrustLevel(args.trust)]

    if args.json:
        _emit([r.to_dict() for r in records], True)
        return 0
    print(f"{document.tenant}/{document.integration}/{document.environment} "
          f"— schema v{document.schema_version}, document v{document.document_version}, "
          f"{len(document.records)} record(s)")
    for record in records:
        flags = []
        if record.superseded_by:
            flags.append(f"superseded by {record.superseded_by}")
        if record.awaiting_approval:
            flags.append("awaiting approval")
        if record.expires_at:
            flags.append(f"expires {record.expires_at}")
        suffix = f"  [{'; '.join(flags)}]" if flags else ""
        print(f"  {record.trust.value:<10} {record.record_id:<44} "
              f"v{record.version} ok={record.success_count} "
              f"fail={record.failure_count} runs={len(set(record.verified_by_runs))}"
              f"{suffix}")
    return 0


def cmd_validate(args) -> int:
    document = _load(args)
    report = validate_document(document)
    if args.json:
        _emit(report.to_dict(), True)
        return 0 if report.ok else 1
    for problem in report.problems:
        print(f"problem: {problem}")
    for warning in report.warnings:
        print(f"warning: {warning}")
    for stale in report.stale:
        print(f"stale:   {stale}")
    print("ok" if report.ok else f"{len(report.problems)} problem(s)")
    return 0 if report.ok else 1


def cmd_degraded(args) -> int:
    """Everything that stopped working, which is the queue of real work."""
    document = _load(args)
    hurt = [
        r for r in sorted(document.records.values(), key=lambda r: r.record_id)
        if r.trust in (TrustLevel.DEGRADED, TrustLevel.INVALID)
    ]
    if args.json:
        _emit([r.to_dict() for r in hurt], True)
        return 0
    if not hurt:
        print("nothing degraded or invalid")
        return 0
    for record in hurt:
        print(f"{record.trust.value:<9} {record.record_id}")
        print(f"          last failure {record.last_failure or '?'} "
              f"({record.failure_count} total)")
        if record.previous_good:
            print("          a last-known-good state is available "
                  "('knowledge restore')")
    return 0


def cmd_changes(args) -> int:
    entries = _store(args).history(
        args.tenant, args.integration, args.environment, limit=args.limit
    )
    if args.json:
        _emit(entries, True)
        return 0
    for entry in entries:
        print(f"{entry.get('at', '?')}  v{entry.get('document_version')}  "
              f"{entry.get('execution_id') or '-'}  {entry.get('note', '')}")
        for change in entry.get("changes", []):
            print(f"    {change.get('before') or '-'} -> {change.get('after')}  "
                  f"{change.get('record_id')}  ({change.get('reason', '')})")
    return 0


def cmd_pending(args) -> int:
    document = _load(args)
    waiting = open_pending(document)
    if args.json:
        _emit([p.to_dict() for p in waiting], True)
        return 0
    if not waiting:
        print("nothing waiting for a decision")
        return 0
    for change in waiting:
        print(f"{change.record_id}  ({change.reason})")
        for contradiction in change.contradictions:
            print(f"    {contradiction['field']}: "
                  f"believed {contradiction['believed']!r} / "
                  f"observed {contradiction['observed']!r}")
    return 0


# -- deciding -------------------------------------------------------------
def cmd_approve(args) -> int:
    store = _store(args)
    document = _load(args)
    at = utc_clock()
    changes = decide_pending(document, args.record, approve=not args.reject,
                             decided_by=args.by, at=at)
    store.save(document, at=at, execution_id=f"cli:{args.by}", changes=changes,
               note=f"{'rejected' if args.reject else 'approved'} by {args.by}")
    print(f"{'rejected' if args.reject else 'approved'} {args.record} "
          f"({len(changes)} trust change(s))")
    return 0


def cmd_invalidate(args) -> int:
    store = _store(args)
    document = _load(args)
    record = document.get(args.record)
    if record is None:
        print(f"error: no record {args.record}")
        return 1
    at = utc_clock()
    change = confirm_invalid(record, args.reason, at=at, execution_id=f"cli:{args.by}")
    store.save(document, at=at, execution_id=f"cli:{args.by}", changes=[change],
               note=f"invalidated by {args.by}: {args.reason}")
    print(f"invalidated {args.record}")
    return 0


def cmd_restore(args) -> int:
    store = _store(args)
    document = _load(args)
    at = utc_clock()
    if args.record:
        record = document.get(args.record)
        if record is None or not record.restore_good():
            print(f"error: no last-known-good state for {args.record}")
            return 1
        note = f"restored {args.record} to its last known good state"
    else:
        if not document.restore_good():
            print("error: this document has no last-known-good snapshot")
            return 1
        note = "restored the whole document to its last known good state"
    store.save(document, at=at, execution_id=f"cli:{args.by}", note=note)
    print(note)
    return 0


# -- handing off ----------------------------------------------------------
def cmd_export(args) -> int:
    """A self-contained bundle another session can read without this repo."""
    store = _store(args)
    document = _load(args)
    report = validate_document(document)
    bundle = {
        "exported_at": utc_clock(),
        "document": document.to_dict(),
        "validation": report.to_dict(),
        "history": store.history(args.tenant, args.integration, args.environment),
        "how_to_use": (
            "Records at VERIFIED may be used without exploring. CANDIDATE needs "
            "a check first. DEGRADED and INVALID must be rediscovered. No "
            "credential is in this file; they come from the environment."
        ),
    }
    problems = scan_for_secrets(bundle)
    if problems:
        print("error: refusing to export, the document holds something secret-shaped:")
        for problem in sorted(set(problems)):
            print(f"  {problem}")
        return 1
    text = json.dumps(bundle, indent=2, sort_keys=True) + "\n"
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
        print(f"wrote {args.out}")
    else:
        print(text)
    return 0


def cmd_ingest(args) -> int:
    """Feed one live run's observation file into the store."""
    from .adapters import tegg_portal

    store = _store(args)
    path = Path(args.observations)
    execution_id = args.execution_id or tegg_portal.execution_id_for(path)
    run = tegg_portal.open_run(store, execution_id=execution_id)
    run.open(base_url=tegg_portal.BASE_URL, strict=not args.force)
    touched = tegg_portal.ingest_observations(run, path)
    report = run.close(note=f"ingested {path}")

    print(f"execution {execution_id}: {len(touched)} record(s) touched")
    for change in report.changes:
        print(f"  {change['before'] or '-'} -> {change['after']}  "
              f"{change['record_id']}")
    if report.pending_approval:
        print("held for approval: " + ", ".join(report.pending_approval))
    print(f"saved {report.saved_to}")
    return 0


# -- wiring ---------------------------------------------------------------
def add_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--tenant", default=DEFAULT_TENANT)
    parser.add_argument("--integration", default=DEFAULT_INTEGRATION)
    parser.add_argument("--environment", default=DEFAULT_ENVIRONMENT)
    parser.add_argument("--root", default=None, help="Override the store location")
    parser.add_argument("--json", action="store_true", help="Machine-readable output")


def build_subparser(sub: argparse._SubParsersAction) -> None:
    """Attach ``knowledge <command>`` to an existing CLI."""
    knowledge = sub.add_parser(
        "knowledge", help="Inspect and manage stored operational knowledge"
    )
    commands = knowledge.add_subparsers(dest="knowledge_command", required=True)

    for name, handler, help_text in (
        ("inspect", cmd_inspect, "List what this tenant knows"),
        ("validate", cmd_validate, "Check the store is well formed and safe"),
        ("degraded", cmd_degraded, "Show knowledge that stopped working"),
        ("pending", cmd_pending, "Show changes waiting for a decision"),
    ):
        child = commands.add_parser(name, help=help_text)
        add_arguments(child)
        child.set_defaults(func=handler)

    inspect_cmd = commands.choices["inspect"]
    inspect_cmd.add_argument("--kind", choices=[k.value for k in RecordKind])
    inspect_cmd.add_argument("--trust", choices=[t.value for t in TrustLevel])

    changes = commands.add_parser("changes", help="Show the knowledge change log")
    add_arguments(changes)
    changes.add_argument("--limit", type=int, default=0)
    changes.set_defaults(func=cmd_changes)

    approve = commands.add_parser("approve", help="Decide a queued change")
    add_arguments(approve)
    approve.add_argument("--record", required=True)
    approve.add_argument("--by", required=True, help="Who is deciding")
    approve.add_argument("--reject", action="store_true")
    approve.set_defaults(func=cmd_approve)

    invalidate = commands.add_parser("invalidate", help="Write a record off by hand")
    add_arguments(invalidate)
    invalidate.add_argument("--record", required=True)
    invalidate.add_argument("--reason", required=True)
    invalidate.add_argument("--by", required=True)
    invalidate.set_defaults(func=cmd_invalidate)

    restore = commands.add_parser("restore", help="Go back to the last known good")
    add_arguments(restore)
    restore.add_argument("--record", default=None, help="One record, or the whole file")
    restore.add_argument("--by", required=True)
    restore.set_defaults(func=cmd_restore)

    export = commands.add_parser("export", help="Write a handoff bundle")
    add_arguments(export)
    export.add_argument("--out", default=None)
    export.set_defaults(func=cmd_export)

    ingest = commands.add_parser(
        "ingest", help="Record a live run's observations as knowledge"
    )
    add_arguments(ingest)
    ingest.add_argument("--observations", required=True,
                        help="Path to a run's observations.json")
    ingest.add_argument("--execution-id", default=None)
    ingest.add_argument("--force", action="store_true",
                        help="Ingest even if the stored document fails validation")
    ingest.set_defaults(func=cmd_ingest)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="awe-knowledge")
    sub = parser.add_subparsers(dest="command", required=True)
    build_subparser(sub)
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except KnowledgeError as error:
        print(f"error: {error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
