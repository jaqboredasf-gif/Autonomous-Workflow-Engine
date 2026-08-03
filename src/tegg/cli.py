"""Command line entry point.

Two ways in, depending on where the documents come from.

Site-visit workflow (the live one)::

    tegg portal list-completed
    tegg portal inspect --site-visit <id>
    tegg run --site-visit <id>
    tegg resume --job-id <job-id>
    tegg status --job-id <job-id>

Manual workflow, for documents already downloaded by hand::

    tegg doctor
    tegg plan  --job config/job.example.yaml
    tegg build --job config/job.example.yaml --source ~/Downloads/acme
"""

from __future__ import annotations

import argparse
import re
import sys
from contextlib import contextmanager
from pathlib import Path

from . import canonical, certdoc, certificate, evidence, manifest, portal
from .assemble import AssemblyError, merge_pdfs, page_count, split_pdf
from .config import ConfigError, Job, Workflow, portal_credentials
from .paths import JobFolder
from .resolve import resolve_all, resolve_one

DEFAULT_WORKFLOW = Path("config/workflow.yaml")
DEFAULT_ASSETS = Path("assets/static")
DEFAULT_WORK_ROOT = Path("work")


def _load(args) -> tuple[Workflow, Job]:
    return Workflow.from_file(Path(args.workflow)), Job.from_file(Path(args.job))


def _job_folder(workflow: Workflow, job: Job, args) -> JobFolder:
    return JobFolder(Path(args.drive_root), workflow.raw["destination"]["root"], job)


# ---------------------------------------------------------------------------


#: The other doctor. These two check different halves of the system and a
#: coworker has no way to know which one they wanted, so each names the other.
OTHER_DOCTOR = (
    "This checks the offline stages -- PDF tools, static assets, the workflow\n"
    "config. For the live portal operations (visit-findings,\n"
    "documentation-read) run:  awe-tegg doctor"
)


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

    print("\nDraft marking")
    from . import draft

    if draft.watermark_available():
        print("  OK       reportlab (DRAFT watermark)")
    else:
        print("  MISSING  reportlab -- drafts get a DRAFT filename and title")
        print("           but no visual watermark. pip install reportlab")

    work_root = Path(getattr(args, "work_root", DEFAULT_WORK_ROOT))
    print(f"\nJob workspaces  ({work_root / 'jobs'})")
    from . import workspace as ws

    jobs = ws.Workspace.list_jobs(work_root)
    print(f"  {len(jobs)} existing job(s)")
    for job in jobs[:10]:
        print(f"    {job}")

    print(f"\n{OTHER_DOCTOR}")

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
        # The config key is `delete_first_checkbox_group`; the older spelling is
        # still honoured so existing job configs keep working.
        delete_first_group=settings.get(
            "delete_first_checkbox_group",
            settings.get("delete_first_group", True),
        ),
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
    """Full pipeline. Site-visit route when --site-visit is given, else the
    original manually-downloaded route."""
    if getattr(args, "site_visit", None) or getattr(args, "job_id", None):
        return cmd_site_visit_run(args)

    if not getattr(args, "job", None) or not getattr(args, "out", None):
        print(
            "error: choose a workflow --\n"
            "  live portal:  tegg run --site-visit <id>\n"
            "  manual:       tegg run --job <job.yaml> --out <download folder>",
            file=sys.stderr,
        )
        return 1

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


# ---------------------------------------------------------------------------
# Site-visit workflow
# ---------------------------------------------------------------------------


def _portal_settings(args) -> tuple[str, dict]:
    """The portal block from workflow.yaml, plus the base URL to drive."""
    workflow = Workflow.from_file(Path(args.workflow))
    settings = dict(workflow.raw.get("portal", {}))
    base_url = getattr(args, "base_url", None) or settings.get("base_url")
    if not base_url:
        raise ConfigError(
            "no portal base_url; set portal.base_url in config/workflow.yaml "
            "or pass --base-url"
        )
    return base_url, settings


@contextmanager
def _knowledge_run(args, evidence_dir: Path, note: str):
    """An open knowledge run for one live execution, or None.

    Yields None when ``--no-knowledge`` was passed, so the caller has one code
    path and the driver decides nothing. On the way out the run is closed,
    which is what persists whatever this execution confirmed or corrected --
    including when the run failed, because a failure is the most valuable
    thing a run can learn.
    """
    if getattr(args, "no_knowledge", False):
        yield None
        return

    from awe_knowledge.adapters import tegg_portal
    from awe_knowledge.store import KnowledgeStore

    execution_id = f"{evidence_dir.name}@{evidence.utcnow()}"
    run = tegg_portal.open_run(
        KnowledgeStore(), execution_id=execution_id, artifact_root=evidence_dir
    )
    run.open(base_url=tegg_portal.BASE_URL)
    known = [r.record_id for r in run.applicable()]
    print(f"knowledge  {len(known)} usable record(s) from earlier runs")
    try:
        yield run
    finally:
        report = run.close(note=note)
        print(f"\nknowledge  used {len(report.used)}, "
              f"rediscovered {len(report.rediscovered)}, "
              f"changed {len(report.changes)}")
        for change in report.changes:
            print(f"  {change['record_id']}  {change['before'] or '(new)'}"
                  f" -> {change['after']}  {change['reason']}")
        if report.pending_approval:
            print("  held for approval: " + ", ".join(report.pending_approval))
            print("  decide with:  tegg knowledge pending")


def cmd_portal_list(args) -> int:
    """List the completed site visits. Read-only."""
    from . import fetch as fetch_module

    base_url, settings = _portal_settings(args)
    evidence_dir = Path(args.evidence or (Path(args.work_root) / "exploration"))
    print(f"signing in to {base_url}")
    with _knowledge_run(args, evidence_dir, "portal list-completed") as knowledge:
        visits = fetch_module.list_completed(
            base_url, settings, evidence_dir, headless=not args.headed,
            knowledge=knowledge,
        )
    if not visits:
        print(
            "\nNo completed site visits were identified.\n"
            f"Evidence (page snapshot, links, tables): {evidence_dir}",
            file=sys.stderr,
        )
        return 1
    print(f"\n{len(visits)} completed site visit(s):\n")
    for visit in visits:
        print(f"  {visit.describe()}")
    print(f"\nevidence  {evidence_dir}")
    print("\nNext:  tegg run --site-visit <id>")
    return 0


def _diagnose_submit(page, form, settings, evidence_dir, login_path) -> int:
    """Sign in for real and report exactly what the portal did about it.

    Prints the full post-submit picture: URL, title, visible errors, cookies,
    the sign-in responses and any additional fields. The password is never
    printed or saved, and the username is redacted from every artifact.
    """
    from . import login as login_module

    username, password = portal_credentials()

    if form.contractor is not None:
        contractor = settings.get("contractor")
        if contractor:
            try:
                chosen = form.select_contractor(contractor)
                print(f"\ncontractor  {contractor!r} -> {chosen!r}")
            except login_module.LoginFormError as exc:
                print(f"\ncontractor  FAILED: {exc}", file=sys.stderr)
                return 1
        elif form.contractor_required:
            print(
                "\ncontractor  REQUIRED but portal.contractor is not set in "
                "config/workflow.yaml",
                file=sys.stderr,
            )
            return 1

    extra = settings.get("extra_fields") or {}
    if extra:
        try:
            print(f"extra fields  filled {', '.join(login_module.fill_extra_fields(form.frame, extra))}")
        except login_module.LoginFormError as exc:
            print(f"extra fields  FAILED: {exc}", file=sys.stderr)
            return 1

    cookies_before = [c["name"] for c in page.context.cookies()]
    responses: list[dict] = []

    def _on_response(response):
        try:
            if response.request.method == "POST" or "login" in response.url.lower():
                responses.append(
                    {"status": response.status, "url": response.url.split("?")[0]}
                )
        except Exception:
            pass

    page.on("response", _on_response)

    form.username.fill(username)
    form.password.fill(password)
    print("\nsubmitting (the password is never printed, saved or screenshotted)")
    if form.submit is not None:
        form.submit.click()
    else:
        form.password.press("Enter")

    outcome = login_module.wait_for_result(
        page, login_path,
        timeout_ms=int(settings.get("login_timeout_ms", 30000)),
        cookies_before=cookies_before,
    )

    print("\n--- after submit ---")
    print(outcome.describe())
    print(f"\ncookies before : {', '.join(cookies_before) or '(none)'}")
    print(f"cookies after  : new = {', '.join(outcome.new_cookies) or '(none new)'}")
    if responses:
        print("\nsign-in responses:")
        for item in responses[-10:]:
            print(f"  {item['status']}  {item['url']}")
    frames = [f.url for f in page.frames][1:]
    print(f"\niframes: {', '.join(frames) if frames else '(none)'}")

    # Snapshot with the username scrubbed out of everything saved.
    directory = Path(evidence_dir)
    directory.mkdir(parents=True, exist_ok=True)
    stamp = outcome.url and "after-submit" or "after-submit"
    try:
        page.eval_on_selector_all(
            "input",
            "els => els.forEach(e => { if (e.type !== 'checkbox' "
            "&& e.type !== 'radio') e.value = ''; })",
        )
        page.screenshot(path=str(directory / f"{stamp}.png"), full_page=True)
        (directory / f"{stamp}.html").write_text(
            login_module.redact(page.content(), username), encoding="utf-8"
        )
        print(f"\nsaved: {stamp}.png, {stamp}.html (username redacted)")
    except Exception as exc:
        print(f"\ncould not save evidence: {exc}", file=sys.stderr)

    if outcome.ok:
        print("\nAUTHENTICATION SUCCEEDED.")
        return 0
    print(f"\nAUTHENTICATION FAILED: {outcome.reason}", file=sys.stderr)
    return 1


def cmd_portal_probe_login(args) -> int:
    """Dump the sign-in page's structure. Needs no credentials, types nothing.

    This is the tool for a login that will not locate its fields: it reports
    every frame, label, input and button on the page, and says where the form
    lives and how its username field is identified.
    """
    from . import login as login_module

    base_url, settings = _portal_settings(args)
    login_path = settings.get("login_path", "/auth/login")
    url = f"{base_url}{login_path}"

    evidence_dir = Path(args.evidence or (Path(args.work_root) / "exploration"))
    print(f"probing {url}")
    print("(no credentials are used, read, or typed by this command)\n")

    try:
        import playwright  # noqa: F401
    except ImportError:
        print(
            "error: playwright is not installed "
            "(pip install -e '.[portal]' && python -m playwright install chromium)",
            file=sys.stderr,
        )
        return 2

    from playwright.sync_api import sync_playwright

    from .browser import launch

    with sync_playwright() as playwright_instance:
        browser = launch(playwright_instance, headless=not args.headed)
        context = browser.new_context()
        page = context.new_page()
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=45000)
            # Sign-in pages often finish wiring themselves up after load.
            try:
                page.wait_for_load_state("networkidle", timeout=10000)
            except Exception:
                pass
            probe = login_module.probe(page, evidence_dir)
            print(probe.describe())

            print("\n--- locator check ---")
            try:
                form = login_module.locate(page, settings.get("login_labels", {}))
                print("login form located:")
                for field_name, how in form.how.items():
                    print(f"  {field_name:<9} {how}")
            except login_module.LoginFormError as exc:
                print(f"could not locate the form: {exc}", file=sys.stderr)
                return 1

            if not args.submit:
                print("\nThis is what a real sign-in would use.")
                print("Add --submit to actually sign in and diagnose what happens.")
                return 0

            return _diagnose_submit(page, form, settings, evidence_dir, login_path)
        finally:
            context.close()
            browser.close()


def cmd_portal_inspect(args) -> int:
    """Open one site visit and report what it offers. Downloads nothing."""
    from . import fetch as fetch_module

    base_url, settings = _portal_settings(args)
    evidence_dir = Path(args.evidence or (Path(args.work_root) / "exploration"))
    recorder = evidence.Recorder(evidence_dir)

    with _knowledge_run(args, evidence_dir, "portal inspect") as knowledge, \
            fetch_module.session(
                base_url, recorder, settings, headless=not args.headed,
                knowledge=knowledge,
            ) as explorer:
        explorer.open_documentation()
        visits = explorer.list_completed_site_visits()
        if not visits:
            print(f"no completed site visits found; evidence in {evidence_dir}",
                  file=sys.stderr)
            return 1
        visit = fetch_module._select(visits, args.site_visit)
        print(f"site visit  {visit.describe()}\n")
        explorer.open_site_visit(visit)

        actions = explorer.inventory_actions(f"inspect-{visit.identifier}")
        print(f"actions offered ({len(actions)}):")
        for action in actions[:60]:
            print(f"  {action}")

        if explorer.open_document_library():
            print("\nDocument Library: open")
        else:
            print("\nDocument Library: NOT offered in this context")

        documents = explorer.discover_documents()
        print(f"\nrecognised documents ({len(documents)}):")
        for document in documents:
            if document.ambiguous_between:
                print(
                    f"  AMBIGUOUS  {document.label!r} -> "
                    f"{', '.join(document.ambiguous_between)}"
                )
            else:
                print(f"  {canonical.title(document.canonical):<44} {document.label!r}")

        found = {d.canonical for d in documents if d.canonical}
        missing = [k for k in canonical.REQUIRED_PORTAL_TYPES if k not in found]
        if missing:
            print("\nnot found in this context:")
            for key in missing:
                print(f"  {canonical.title(key)}")

    print(f"\nevidence  {evidence_dir}")
    return 0


def _output_name(workspace, args) -> str:
    """The report filename, from the job yaml when given, else the workspace."""
    job_path = getattr(args, "job", None)
    if job_path:
        workflow = Workflow.from_file(Path(args.workflow))
        return workflow.output_name(Job.from_file(Path(job_path)))

    data = workspace.data
    visit = data.get("site_visit", {})
    # A site visit identifier is a job number, not a date -- only treat it as a
    # year if it genuinely looks like one, else fall back to when the job ran.
    year = ""
    for candidate in (visit.get("date", ""), visit.get("identifier", "")):
        match = re.search(r"\b(19|20)\d{2}\b", str(candidate))
        if match:
            year = match.group(0)
            break
    if not year:
        year = (data.get("created_at", "") or "")[:4]
    parts = [
        data.get("customer") or "Customer",
        data.get("site") or "",
        year,
        "ESA Report",
    ]
    return " ".join(p for p in parts if p) + ".pdf"


def _finish_job(workspace, args, *, fetched=None) -> int:
    """Certificate, splits, static assets, assembly, and the operator report."""
    from . import pipeline

    print()
    missing_assets = pipeline.stage_static_assets(workspace, Path(args.assets))
    for name in missing_assets:
        print(f"static asset MISSING  {name}", file=sys.stderr)

    if workspace.record(canonical.CERTIFICATE).local_path:
        try:
            outcome = pipeline.prepare_certificate(workspace)
            print(outcome.describe())
        except pipeline.PipelineError as exc:
            print(f"certificate  FAILED  {exc}", file=sys.stderr)
    else:
        print("certificate  not downloaded; cannot include it")

    try:
        pipeline.derive_ir_sections(workspace)
    except pipeline.PipelineError as exc:
        print(f"IR split     FAILED  {exc}", file=sys.stderr)

    result = pipeline.build(
        workspace, _output_name(workspace, args), mark_draft=not args.final
    )

    print()
    if fetched is not None:
        print(fetched.summary() or "  (nothing downloaded)")
        print()

    if not result.ok:
        print(
            f"BUILD BLOCKED -- {len(result.missing)} required section(s) missing:",
            file=sys.stderr,
        )
        for item in result.missing:
            print(f"  - {item}", file=sys.stderr)
        print(f"\nworkspace  {workspace.path}", file=sys.stderr)
        print(f"evidence   {workspace.evidence}", file=sys.stderr)
        print(
            "\nNothing was assembled. Fix the items above, then:\n"
            f"  tegg resume --job-id {workspace.job_id}",
            file=sys.stderr,
        )
        return 1

    print(f"assembled  {result.output}")
    print(f"           {result.pages} pages from {len(result.components)} sections")
    if result.watermarked:
        print("           watermarked DRAFT - HUMAN REVIEW REQUIRED")
    for component in result.components:
        print(f"  {component.pages:>4}p  {canonical.title(component.key)}")

    if result.review_required:
        print("\nHUMAN REVIEW REQUIRED before this goes to the customer:")
        for reason in result.review_reasons:
            print(f"  - {reason}")

    print(f"\nmanifest   {workspace.manifest_path}")
    print(f"output     {result.output}")
    return 0


def cmd_site_visit_run(args) -> int:
    """Full site-visit pipeline: fetch -> certificate -> assemble a draft."""
    from . import fetch as fetch_module
    from . import workspace as ws

    base_url, settings = _portal_settings(args)
    job_id = args.job_id or ws.make_job_id(args.site_visit or "unknown")
    workspace = ws.Workspace.create(
        Path(args.work_root),
        job_id,
        site_visit=args.site_visit or "",
        portal_base_url=base_url,
    )
    print(f"job        {workspace.job_id}")
    print(f"workspace  {workspace.path}")

    fetched = None
    if not args.no_fetch:
        try:
            fetched = fetch_module.fetch_job(
                workspace,
                base_url,
                settings,
                site_visit_id=args.site_visit,
                headless=not args.headed,
                force=args.force,
            )
        except fetch_module.FetchError as exc:
            print(f"\nportal: {exc}", file=sys.stderr)
            print(f"\nevidence   {workspace.evidence}", file=sys.stderr)
            print(
                f"resume with:  tegg resume --job-id {workspace.job_id}",
                file=sys.stderr,
            )
            return 2

    return _finish_job(workspace, args, fetched=fetched)


def cmd_resume(args) -> int:
    """Carry on with an existing job, re-fetching only what is still missing."""
    from . import fetch as fetch_module
    from . import workspace as ws

    workspace = ws.Workspace.find(Path(args.work_root), args.job_id)
    print(f"job        {workspace.job_id}")
    print(f"workspace  {workspace.path}")

    fetched = None
    outstanding = [
        key for key in canonical.REQUIRED_PORTAL_TYPES
        if workspace.needs(key, args.force)
    ]
    if outstanding and not args.no_fetch:
        print(f"outstanding {len(outstanding)}: {', '.join(outstanding)}")
        base_url, settings = _portal_settings(args)
        visit = workspace.data.get("site_visit", {}).get("identifier") or None
        try:
            fetched = fetch_module.fetch_job(
                workspace, base_url, settings,
                site_visit_id=visit,
                headless=not args.headed,
                force=args.force,
            )
        except fetch_module.FetchError as exc:
            print(f"\nportal: {exc}", file=sys.stderr)
            return 2
    elif not outstanding:
        print("all portal documents already present; skipping the browser")

    return _finish_job(workspace, args, fetched=fetched)


def cmd_status(args) -> int:
    """Report one job's state, or list the jobs available."""
    from . import workspace as ws

    if not args.job_id:
        jobs = ws.Workspace.list_jobs(Path(args.work_root))
        if not jobs:
            print(f"no jobs in {Path(args.work_root) / 'jobs'}")
            return 0
        print(f"{len(jobs)} job(s):")
        for job in jobs:
            print(f"  {job}")
        return 0

    workspace = ws.Workspace.find(Path(args.work_root), args.job_id)
    print(workspace.summary())
    return 0


def cmd_certificate_inspect(args) -> int:
    """Classify a certificate's checkboxes. Converts a legacy .doc first."""
    source = Path(args.file)
    if not source.exists():
        print(f"error: file not found: {source}", file=sys.stderr)
        return 1

    out_dir = Path(args.out) if args.out else source.parent
    try:
        docx = certdoc.ensure_docx(source, out_dir)
    except certificate.CertificateError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    if docx != source:
        print(f"converted  {source.name} -> {docx.name}\n")
    analysis = certdoc.analyze(docx)
    print(analysis.describe())
    return 0 if not analysis.error else 1


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

    # `run` serves both workflows: --site-visit drives the live portal route,
    # --job keeps the original manually-downloaded pipeline working unchanged.
    run_cmd = sub.add_parser(
        "run", help="Full pipeline (use --site-visit for the live portal route)"
    )
    run_cmd.add_argument("--job", default=None, help="Job YAML (manual workflow)")
    run_cmd.add_argument("--drive-root", default=".")
    run_cmd.add_argument("--out", default=None, help="Download folder (manual workflow)")
    run_cmd.add_argument("--dry-run", action="store_true")
    _add_site_visit_options(run_cmd)
    run_cmd.add_argument(
        "--site-visit", default=None, help="Completed site visit identifier"
    )
    run_cmd.set_defaults(func=cmd_run)

    resume_cmd = sub.add_parser("resume", help="Continue an existing job")
    resume_cmd.add_argument("--job-id", required=True)
    _add_site_visit_options(resume_cmd, with_job_id=False)
    resume_cmd.set_defaults(func=cmd_resume)

    status_cmd = sub.add_parser("status", help="Show a job's state, or list jobs")
    status_cmd.add_argument("--job-id", default=None)
    status_cmd.add_argument("--work-root", default=str(DEFAULT_WORK_ROOT))
    status_cmd.set_defaults(func=cmd_status)

    portal_cmd = sub.add_parser("portal", help="Read-only portal exploration")
    portal_sub = portal_cmd.add_subparsers(dest="portal_command", required=True)

    list_cmd = portal_sub.add_parser(
        "list-completed", help="List completed site visits"
    )
    _add_portal_options(list_cmd)
    list_cmd.set_defaults(func=cmd_portal_list)

    probe_cmd = portal_sub.add_parser(
        "probe-login",
        help="Dump the sign-in page's structure (no credentials needed)",
    )
    _add_portal_options(probe_cmd)
    probe_cmd.add_argument(
        "--submit",
        action="store_true",
        help="Actually sign in and diagnose the result (needs credentials)",
    )
    probe_cmd.set_defaults(func=cmd_portal_probe_login)

    inspect_visit = portal_sub.add_parser(
        "inspect", help="Show what one site visit offers, downloading nothing"
    )
    inspect_visit.add_argument("--site-visit", default=None)
    _add_portal_options(inspect_visit)
    inspect_visit.set_defaults(func=cmd_portal_inspect)

    inspect_cmd = sub.add_parser(
        "inspect-docx", help="Report a certificate's checkbox structure"
    )
    inspect_cmd.add_argument("file")
    inspect_cmd.set_defaults(func=cmd_inspect_docx)

    cert_inspect = sub.add_parser(
        "certificate-inspect",
        help="Classify a certificate's checkboxes (converts a legacy .doc first)",
    )
    cert_inspect.add_argument("file")
    cert_inspect.add_argument("--out", default=None, help="Where to write the .docx")
    cert_inspect.set_defaults(func=cmd_certificate_inspect)

    # What earlier runs worked out about the portal, so a later run does not
    # have to work it out again. The knowledge layer is its own package and
    # knows nothing about this one beyond a default tenant name.
    from awe_knowledge.cli import build_subparser as knowledge_commands

    knowledge_commands(sub)
    return parser


def _add_portal_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--base-url", default=None, help="Override the portal URL")
    parser.add_argument(
        "--headed", action="store_true", help="Show the browser while it runs"
    )
    parser.add_argument("--work-root", default=str(DEFAULT_WORK_ROOT))
    parser.add_argument("--evidence", default=None, help="Where to write evidence")
    parser.add_argument(
        "--no-knowledge",
        action="store_true",
        help="Work the portal out from scratch, ignoring what earlier runs "
             "learned. This is the baseline a knowledge run is measured against.",
    )


def _add_site_visit_options(
    parser: argparse.ArgumentParser, with_job_id: bool = True
) -> None:
    if with_job_id:
        parser.add_argument("--job-id", default=None, help="Reuse a job folder")
    parser.add_argument("--work-root", default=str(DEFAULT_WORK_ROOT))
    parser.add_argument("--base-url", default=None)
    parser.add_argument("--headed", action="store_true")
    parser.add_argument(
        "--force", action="store_true", help="Re-download documents already present"
    )
    parser.add_argument(
        "--no-fetch", action="store_true", help="Assemble from what is already here"
    )
    parser.add_argument(
        "--final",
        action="store_true",
        help="Drop the DRAFT watermark (only after a human has reviewed it)",
    )
    parser.add_argument(
        "--review-required",
        action="store_true",
        help="Explicit default: produce a DRAFT marked for human review",
    )


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    from awe_knowledge.models import KnowledgeError

    from . import fetch as fetch_module
    from . import pipeline

    try:
        return args.func(args)
    except (
        ConfigError,
        AssemblyError,
        certificate.CertificateError,
        portal.PortalError,
        pipeline.PipelineError,
        fetch_module.FetchError,
        KnowledgeError,
    ) as exc:
        # Operators get a sentence, not a traceback.
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except FileNotFoundError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\ninterrupted; the job is resumable with 'tegg resume'", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
