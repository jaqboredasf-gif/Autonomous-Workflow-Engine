"""Command line entry point.

    tegg doctor
    tegg plan  --job config/job.example.yaml
    tegg build --job config/job.example.yaml --source ~/Downloads/acme
    tegg fetch --job config/job.example.yaml     (blocked, see docs/GAPS.md)
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import certificate, manifest, portal
from .assemble import AssemblyError, merge_pdfs, page_count, split_pdf
from .config import ConfigError, Job, Workflow
from .paths import JobFolder
from .resolve import resolve_all, resolve_one

DEFAULT_WORKFLOW = Path("config/workflow.yaml")
DEFAULT_ASSETS = Path("assets/static")


def _load(args) -> tuple[Workflow, Job]:
    return Workflow.from_file(Path(args.workflow)), Job.from_file(Path(args.job))


def _job_folder(workflow: Workflow, job: Job, args) -> JobFolder:
    return JobFolder(Path(args.drive_root), workflow.raw["destination"]["root"], job)


# ---------------------------------------------------------------------------


def cmd_doctor(args) -> int:
    """Report what is ready to run and what is blocked."""
    print("Stages that run without portal access")
    ok = True

    for label, check in (
        ("pypdf (split/merge)", _import_ok("pypdf")),
        ("PyYAML (config)", _import_ok("yaml")),
        ("workflow config", Path(args.workflow).exists()),
    ):
        print(f"  {'OK     ' if check else 'MISSING'}  {label}")
        ok = ok and check

    assets = Path(args.assets)
    print(f"\nStatic assets  ({assets})")
    workflow = Workflow.from_file(Path(args.workflow)) if ok else None
    if workflow:
        for name in workflow.static_assets:
            present = (assets / name).exists()
            print(f"  {'OK     ' if present else 'MISSING'}  {name}")
            if not present:
                ok = False

    print("\nCertificate stage")
    converter = certificate.find_soffice()
    print(f"  {'OK     ' if converter else 'MISSING'}  LibreOffice (docx -> pdf)")
    if not converter:
        print("           install LibreOffice, or edit the certificate by hand and")
        print("           save 'Certificates good.pdf' into the source folder")
    print("  CHECK    run 'tegg inspect-docx <Certificates.docx>' on a real file")
    print("           to confirm the checkbox grouping before trusting a run")

    print("\nPortal stage")
    blockers = portal.preflight()
    if blockers:
        for blocker in blockers:
            print(f"  BLOCKED  {blocker}")
    else:
        print("  OK       ready")

    print(
        "\nReady to build reports from manually downloaded files."
        if ok
        else "\nNot ready: resolve the MISSING items above."
    )
    return 0 if ok else 1


def _import_ok(module: str) -> bool:
    try:
        __import__(module)
        return True
    except ImportError:
        return False


# ---------------------------------------------------------------------------


def cmd_plan(args) -> int:
    """Show everything a run would do, without doing any of it."""
    workflow, job = _load(args)
    folder = _job_folder(workflow, job, args)

    print(f"Job:  {job.company} / {job.site} / {job.year}")
    print(f"      agreement={job.agreement}  site_visit={job.site_visit}\n")

    print("Destination")
    print(f"  {folder.path}")
    for level in folder.created_levels():
        print(f"    + create {level.name}/")

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
    return 0


# ---------------------------------------------------------------------------


def cmd_build(args) -> int:
    """Build the final report from files already on disk.

    This is the stage that works today: point --source at the folder the
    documents were downloaded into and it does the rest.
    """
    workflow, job = _load(args)
    source = Path(args.source)
    if not source.is_dir():
        print(f"error: source folder not found: {source}", file=sys.stderr)
        return 1

    folder = _job_folder(workflow, job, args)
    destination = folder.ensure()
    print(f"job folder  {destination}")

    search_dirs = [source, destination, Path(args.assets)]

    # 1. Split the IR report into cover + body.
    for split in workflow.splits:
        found = resolve_one(split["source"], [source, destination])
        if not found.found:
            print(
                f"error: {split['source']} not found in {source}", file=sys.stderr
            )
            return 1
        try:
            written = split_pdf(found.path, split["outputs"], destination)
        except AssemblyError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1
        for path in written:
            print(f"split       {path.name} ({page_count(path)}p)")

    # 2. Locate every document in the assembly order.
    order = workflow.assembly_order
    resolutions = resolve_all(order, search_dirs)

    print("\nresolved sections")
    for resolution in resolutions:
        print(f"  {resolution.describe()}")

    absent = [r.wanted for r in resolutions if not r.found]
    if absent:
        print(
            f"\nerror: {len(absent)} document(s) could not be found in "
            f"{', '.join(str(d) for d in search_dirs)}:",
            file=sys.stderr,
        )
        for name in absent:
            print(f"  - {name}", file=sys.stderr)
        print(
            "\nNothing was written. Add the missing files and re-run.",
            file=sys.stderr,
        )
        return 1

    if args.dry_run:
        print("\ndry run: stopping before merge")
        return 0

    # 3. Merge, then record what went in.
    sections = []
    inputs = []
    for resolution in resolutions:
        pages = page_count(resolution.path)
        sections.append(
            {
                "section": resolution.wanted,
                "source_file": resolution.path.name,
                "matched_by": resolution.how,
                "pages": pages,
            }
        )
        inputs.append(resolution.path)

    output = destination / workflow.output_name(job)
    merge_pdfs(inputs, output)
    print(f"\nmerged {len(inputs)} documents -> {output.name} ({page_count(output)}p)")

    manifest_path = manifest.write(
        manifest.build(job, workflow, sections, output), destination
    )
    print(f"log         {manifest_path.name}")
    return 0


# ---------------------------------------------------------------------------


def cmd_inspect_docx(args) -> int:
    """Report the checkbox structure of a real Certificates.docx."""
    print(certificate.inspect(Path(args.file)).describe())
    return 0


def cmd_certificate(args) -> int:
    """Apply the SOP's certificate edits and produce 'Certificates good.pdf'."""
    workflow, _ = _load(args)
    settings = workflow.certificate
    source = resolve_one(settings["source"], [Path(args.source)])
    if not source.found:
        print(
            f"error: {settings['source']} not found in {args.source}", file=sys.stderr
        )
        return 1

    out_dir = Path(args.out or args.source)
    edited = out_dir / "Certificates edited.docx"
    edit = certificate.edit_certificate(
        source.path,
        edited,
        yes_items=settings["section_b"]["yes_items"],
        no_items=settings["section_b"]["no_items"],
        delete_first_group=settings.get("delete_first_group", True),
        first_group_size=settings.get("first_group_size"),
    )
    print(f"certificate {edit.summary()}")
    output = certificate.docx_to_pdf(edited, out_dir / settings["output"])
    print(f"converted   {output.name}")
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

    out = Path(args.out)
    print(f"downloading to {out}")
    report = portal.download_all(
        workflow, job, out,
        base_url=args.base_url,
        headless=not args.headed,
    )
    print(report.summary())
    if not report.ok:
        print(
            "\nSome documents failed. Diagnostic dumps (page structure, "
            "screenshot, HTML) are in the diagnostics folder -- these show "
            "exactly which control could not be found.",
            file=sys.stderr,
        )
        return 1
    return 0


def cmd_run(args) -> int:
    """Full pipeline: fetch -> certificate -> split -> merge."""
    result = cmd_fetch(args)
    if result != 0:
        print("\nrun stopped: the portal stage did not complete.", file=sys.stderr)
        return result

    args.source = args.out
    result = cmd_certificate(args)
    if result != 0:
        print(
            "\nrun stopped: the certificate stage did not complete. "
            "Edit it by hand, save 'Certificates good.pdf' into "
            f"{args.out}, then run 'tegg build'.",
            file=sys.stderr,
        )
        return result

    return cmd_build(args)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="tegg", description=__doc__)
    parser.add_argument("--workflow", default=str(DEFAULT_WORKFLOW))
    parser.add_argument("--assets", default=str(DEFAULT_ASSETS))
    sub = parser.add_subparsers(dest="command", required=True)

    doctor = sub.add_parser("doctor", help="Check what is ready to run")
    doctor.set_defaults(func=cmd_doctor)

    def add(name, handler, help_text):
        child = sub.add_parser(name, help=help_text)
        child.add_argument("--job", required=True)
        child.add_argument(
            "--drive-root", default=".",
            help="Where the TEGG shared drive is mounted",
        )
        child.set_defaults(func=handler)
        return child

    add("plan", cmd_plan, "Show what a run would do, changing nothing")

    build_cmd = add("build", cmd_build, "Build the report from downloaded files")
    build_cmd.add_argument(
        "--source", required=True, help="Folder holding the downloaded documents"
    )
    build_cmd.add_argument(
        "--dry-run", action="store_true", help="Resolve files but do not merge"
    )

    cert_cmd = add("certificate", cmd_certificate, "Edit the certificate and convert it")
    cert_cmd.add_argument("--source", required=True)
    cert_cmd.add_argument("--out", default=None)

    fetch_cmd = add("fetch", cmd_fetch, "Download the documents from the portal")
    fetch_cmd.add_argument("--out", required=True)
    fetch_cmd.add_argument("--base-url", default=None, help="Override the portal URL")
    fetch_cmd.add_argument(
        "--headed", action="store_true", help="Show the browser while it runs"
    )

    run_cmd = add("run", cmd_run, "Full pipeline: fetch, certificate, build")
    run_cmd.add_argument("--out", required=True, help="Working folder for downloads")
    run_cmd.add_argument("--base-url", default=None)
    run_cmd.add_argument("--headed", action="store_true")
    run_cmd.add_argument("--dry-run", action="store_true")

    inspect_cmd = sub.add_parser(
        "inspect-docx", help="Report a certificate's checkbox structure"
    )
    inspect_cmd.add_argument("file")
    inspect_cmd.set_defaults(func=cmd_inspect_docx)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except (ConfigError, AssemblyError, certificate.CertificateError, portal.PortalError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
