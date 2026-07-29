"""Command line entry point.

    tegg plan     --job config/job.example.yaml
    tegg assemble --job config/job.example.yaml --source <dir>
    tegg fetch    --job config/job.example.yaml
    tegg run      --job config/job.example.yaml
"""

from __future__ import annotations

import argparse
import sys
from datetime import date
from pathlib import Path

from .assemble import AssemblyError, assemble, page_count, plan_merge, split_pdf
from .config import ConfigError, Job, Workflow
from .paths import JobFolder
from . import portal

DEFAULT_WORKFLOW = Path("config/workflow.yaml")


def _load(args) -> tuple[Workflow, Job]:
    return Workflow.from_file(Path(args.workflow)), Job.from_file(Path(args.job))


def _destination(workflow: Workflow, job: Job, args) -> JobFolder:
    return JobFolder(Path(args.drive_root), workflow.raw["destination"]["root"], job)


def cmd_plan(args) -> int:
    """Show everything the run will do, without doing any of it."""
    workflow, job = _load(args)
    folder = _destination(workflow, job, args)

    print(f"Job:  {job.company} / {job.site} / {job.year}")
    print(f"      agreement={job.agreement}  site_visit={job.site_visit}\n")

    print("Destination folder")
    print(f"  {folder.path}")
    missing = folder.created_levels()
    if missing:
        for level in missing:
            print(f"    + create {level.name}/")
    else:
        print("    (already exists)")

    print("\nPortal downloads")
    for step in portal.plan_downloads(workflow, job):
        print(f"  [{step['key']}] -> {step['filename']}")
        print(f"      nav: {' > '.join(step['nav'])}")
        for key, value in step["params"].items():
            print(f"      {key}: {value}")

    print("\nSplits")
    for split in workflow.splits:
        for out in split["outputs"]:
            print(f"  {split['source']} pages {out['pages']:<4} -> {out['name']}")

    print("\nAssembly order")
    for index, name in enumerate(workflow.assembly_order, 1):
        print(f"  {index:2}. {name}")
    print(f"\nOutput\n  {workflow.output_name(job)}")

    blockers = portal.preflight()
    print("\nPortal readiness")
    if blockers:
        for blocker in blockers:
            print(f"  BLOCKED: {blocker}")
    else:
        print("  ready")
    return 0


def cmd_assemble(args) -> int:
    """Split the IR report and merge everything into the final ESA report."""
    workflow, job = _load(args)
    source = Path(args.source)
    out_dir = Path(args.out) if args.out else source

    for split in workflow.splits:
        source_pdf = source / split["source"]
        if not source_pdf.exists():
            print(f"error: {source_pdf} not found", file=sys.stderr)
            return 1
        written = split_pdf(source_pdf, split["outputs"], out_dir)
        for path in written:
            print(f"split  {path.name} ({page_count(path)}p)")

    order = workflow.assembly_order
    plan = plan_merge(order, out_dir)
    if not plan.ok:
        print(
            f"error: {len(plan.missing)} document(s) missing from {out_dir}:",
            file=sys.stderr,
        )
        for name in plan.missing:
            print(f"  - {name}", file=sys.stderr)
        return 1

    output = out_dir / workflow.output_name(job)
    assemble(order, out_dir, output)
    print(f"\nmerged {len(order)} documents -> {output.name} ({page_count(output)}p)")
    return 0


def cmd_fetch(args) -> int:
    """Download the source documents from the TEGG Pro portal."""
    workflow, job = _load(args)
    blockers = portal.preflight()
    if blockers:
        print("Portal automation is not ready to run:", file=sys.stderr)
        for blocker in blockers:
            print(f"  - {blocker}", file=sys.stderr)
        print("\nSee docs/GAPS.md for what unblocks each item.", file=sys.stderr)
        return 2
    portal.download_all(workflow, job, Path(args.out))
    return 0


def cmd_run(args) -> int:
    """Full pipeline: fetch -> certificate -> split -> merge."""
    result = cmd_fetch(args)
    if result != 0:
        print("\nrun stopped: the portal stage could not complete.", file=sys.stderr)
        return result
    return cmd_assemble(args)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="tegg", description=__doc__)
    parser.add_argument("--workflow", default=str(DEFAULT_WORKFLOW))
    sub = parser.add_subparsers(dest="command", required=True)

    def add(name, handler, help_text):
        child = sub.add_parser(name, help=help_text)
        child.add_argument("--job", required=True)
        child.add_argument(
            "--drive-root", default=".",
            help="Where the TEGG T shared drive is mounted",
        )
        child.set_defaults(func=handler)
        return child

    add("plan", cmd_plan, "Show what a run would do, changing nothing")

    assemble_cmd = add("assemble", cmd_assemble, "Split and merge the final report")
    assemble_cmd.add_argument("--source", required=True)
    assemble_cmd.add_argument("--out", default=None)

    fetch_cmd = add("fetch", cmd_fetch, "Download documents from the portal")
    fetch_cmd.add_argument("--out", default=".")

    run_cmd = add("run", cmd_run, "Full pipeline")
    run_cmd.add_argument("--source", required=True)
    run_cmd.add_argument("--out", default=None)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except (ConfigError, AssemblyError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
