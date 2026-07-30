"""Execution orchestration for the controlled mock run.

One case at a time, each producing a :class:`~tegg.results.ReportResult` whether
it succeeds or fails. The orchestrator itself makes no judgement about whether a
report is good -- it generates, exports, and hands the artifact to
:mod:`tegg.validate`. That separation is what lets validation be strengthened
without touching the driver.

The retry loop is bounded twice over: at most ``max_attempts`` tries per case,
and a case whose root cause is identical two attempts running stops immediately.
Retrying a deterministic failure is how a test harness turns a five-second
failure into a five-minute one and learns nothing.

Nothing here reaches the network. The portal is :mod:`tegg.mockportal`, bound to
127.0.0.1, and no artifact leaves the job workspace.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path

from . import (
    canonical,
    certdoc,
    diagnose,
    esaroute,
    evidence,
    mockassets,
    mockcases,
    mockportal,
    naming,
    pipeline,
    results,
    ssrs,
    validate,
)
from . import workspace as ws
from .assemble import page_count
from .browser import launch
from .sitevisit import Explorer

# Root causes worth one more try. Everything else is deterministic in a mock and
# retrying it only wastes the clock.
TRANSIENT_CAUSES = frozenset({"timed_out", "viewer_never_opened"})

# The rerun scenario is an operational invariant rather than a report section,
# so it is named here instead of in the case file -- listing it among the cases
# would make it count towards section coverage, which it does not.
RERUN_CASE_ID = "rerun-the-same-report"


@dataclass
class Settings:
    """How to run. Defaults are the ones the repository command uses."""

    work_root: Path
    assets_dir: Path
    cases_path: Path | None = None
    headless: bool = True
    max_attempts: int = 2
    keep_going: bool = True
    timing: mockportal.Timing = field(default_factory=mockportal.Timing)
    # Never a real secret: the mock's own fake account.
    username: str = mockportal.USERNAME
    password: str = mockportal.PASSWORD


class Runner:
    """Runs the mock matrix and reports on it."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.matrix = mockcases.load(settings.cases_path)
        self.job = self.matrix.job
        self.report = results.RunReport(job_id=self.job.job_id())
        self.workspace: ws.Workspace | None = None
        self.log: list[str] = []

    # -- logging ----------------------------------------------------------
    def say(self, message: str) -> None:
        self.log.append(message)

    # -- the run ----------------------------------------------------------
    def run(self) -> results.RunReport:
        workspace = ws.Workspace.create(
            self.settings.work_root,
            self.job.job_id(),
            customer=self.job.customer,
            site=self.job.site,
            site_visit=self.job.site_visit,
        )
        self.workspace = workspace
        self.report.job_id = workspace.job_id
        self.say(f"workspace {workspace.path}")

        from playwright.sync_api import sync_playwright

        with sync_playwright() as playwright:
            browser = launch(playwright, headless=self.settings.headless)
            try:
                self._run_sections(browser, workspace)
                self._run_faults(browser)
                # Assembly happens while the browser is still up, because the
                # rerun scenario needs a finished deliverable to prove it does
                # not disturb, and a browser to redo the export with.
                self._assemble(workspace)
                self._rerun(browser, workspace)
            finally:
                browser.close()

        self._score()
        self.report.finished_at = results.utcnow()
        (workspace.logs / "mock-run.log").write_text(
            "\n".join(self.log) + "\n", encoding="utf-8"
        )
        return self.report

    # -- sections ---------------------------------------------------------
    def _run_sections(self, browser, workspace: ws.Workspace) -> None:
        """Every case that contributes a section, in dependency order.

        Portal reports first, then the certificate, then static assets, then the
        derived sections -- a split cannot happen before the document it splits.
        """
        portal_cases = [
            c for c in self.matrix.sections() if c.kind == mockcases.PORTAL_REPORT
        ]
        cert_cases = [
            c for c in self.matrix.sections() if c.kind == mockcases.CERTIFICATE
        ]
        static_cases = [
            c for c in self.matrix.sections() if c.kind == mockcases.STATIC
        ]
        derived_cases = [
            c for c in self.matrix.sections() if c.kind == mockcases.DERIVED
        ]

        options = mockportal.Options(
            username=self.settings.username,
            password=self.settings.password,
            timing=self.settings.timing,
        )
        with mockportal.MockPortal(options=options) as portal:
            self.report.portal_url = portal.url
            context = browser.new_context(accept_downloads=True)
            page = context.new_page()
            page.set_default_timeout(30000)
            try:
                self._sign_in(page, portal.url, workspace)
                for case in portal_cases:
                    self._attempt(
                        case,
                        lambda c: self._portal_report(c, page, portal.url, workspace),
                    )
                for case in cert_cases:
                    self._attempt(
                        case,
                        lambda c: self._certificate(c, page, portal.url, workspace),
                    )
            finally:
                context.close()

        for case in static_cases:
            self._attempt(case, lambda c: self._static(c, workspace))
        for case in derived_cases:
            self._attempt(case, lambda c: self._derived(c, workspace))

    def _sign_in(self, page, base_url: str, workspace: ws.Workspace) -> None:
        recorder = evidence.Recorder(workspace.evidence)
        explorer = Explorer(
            page, base_url, recorder, {"login_path": "/auth/login"}
        )
        explorer.login(
            self.settings.username,
            self.settings.password,
            mockportal.CONTRACTOR_LABEL,
        )
        self.say("signed in to the mock portal")
        esaroute.open_documentation(page, base_url)
        if not esaroute.select_site(page, self.job.site, keystroke_delay_ms=25):
            raise esaroute.RouteError(
                f"could not select the site {self.job.site!r} in the typeahead"
            )
        self.say(f"site selected: {self.job.site}")

    # -- one case, with a bounded retry ----------------------------------
    def _attempt(self, case: mockcases.Case, work) -> results.ReportResult:
        """Run one case, retrying only when the root cause might not repeat."""
        result = results.ReportResult(
            report_id=case.id,
            canonical_type=case.canonical_type,
            input_fixture=self.matrix.source,
            expected_template=case.canonical_type,
        )
        self.report.add(result)

        started = time.monotonic()
        previous_cause = ""
        for attempt in range(1, max(1, self.settings.max_attempts) + 1):
            result.attempts = attempt
            try:
                work(case)
            except Exception as exc:
                reason = str(exc).splitlines()[0][:300] or exc.__class__.__name__
                verdict = diagnose.diagnose(reason)
                result.fail(reason, root_cause=str(verdict))
                result.checks.append(
                    {"name": "exception", "passed": False, "detail": reason,
                     "severity": validate.REQUIRED}
                )
                cause = verdict.cause
            else:
                cause = "" if result.ok else result.root_cause

            if result.ok:
                break
            if cause and cause == previous_cause:
                self.say(f"{case.id}: same cause twice ({cause}); not retrying")
                break
            if diagnose.diagnose(result.failure_reason).cause not in TRANSIENT_CAUSES:
                break
            previous_cause = cause

        result.duration_ms = int((time.monotonic() - started) * 1000)
        self._finish(case, result)
        return result

    def _finish(self, case: mockcases.Case, result: results.ReportResult) -> None:
        """Apply the case's declared review and finalization expectations."""
        if case.human_review:
            result.require_human_review(
                case.blocker or f"{case.id} requires a human check"
            )
        if case.finalization_blocked:
            result.block_finalization(case.blocker)

        if case.should_fail:
            # A fault case is correct when it fails, and the diagnosis must
            # point where the case says it should.
            verdict = diagnose.diagnose(result.failure_reason)
            checks = [
                validate.Check(
                    "expected_failure_occurred",
                    not result.ok,
                    result.failure_reason or "the case unexpectedly passed",
                )
            ]
            if case.expect_stage:
                checks.append(
                    validate.Check(
                        "root_cause_stage",
                        verdict.stage == case.expect_stage,
                        f"{verdict.stage!r}"
                        + (
                            ""
                            if verdict.stage == case.expect_stage
                            else f", expected {case.expect_stage!r}"
                        ),
                    )
                )
            if case.expect_cause:
                checks.append(
                    validate.Check(
                        "root_cause",
                        verdict.cause == case.expect_cause,
                        f"{verdict.cause!r}"
                        + (
                            ""
                            if verdict.cause == case.expect_cause
                            else f", expected {case.expect_cause!r}"
                        ),
                    )
                )
            result.checks.extend(c.to_dict() for c in checks)
            passed = all(c.passed for c in checks)

            # Recast the result. For a fault case the success condition is that
            # the failure happened and was localised correctly, so a detected
            # fault reads as COMPLETED. The observed failure is preserved in
            # root_cause and in the checks; only the top-level failure_reason is
            # cleared, and only when the detection itself succeeded.
            result.generation_status = (
                results.COMPLETED if passed else results.FAILED
            )
            result.export_status = results.NOT_APPLICABLE
            result.validation_status = (
                results.PASSED if passed else results.FAILED
            )
            result.root_cause = str(verdict)
            if passed:
                result.detected_failure = result.failure_reason
                result.failure_reason = ""
            self.say(
                f"{case.id}: {'detected as expected' if passed else 'MISDIAGNOSED'}"
                f" -- {verdict}"
            )
            return

        status = "ok" if result.ok else f"FAILED ({result.failure_reason})"
        self.say(f"{case.id}: {status}")

    # -- case kinds -------------------------------------------------------
    def _portal_report(
        self,
        case: mockcases.Case,
        page,
        base_url: str,
        workspace: ws.Workspace,
        result: results.ReportResult | None = None,
    ) -> None:
        result = result or self.report.by_id(case.id)
        assert result is not None

        # Back to a known state: the report list is reached from the site, and a
        # previous report's form is still on screen.
        esaroute.open_documentation(page, base_url)
        if not esaroute.select_site(page, self.job.site, keystroke_delay_ms=25):
            raise esaroute.RouteError(
                f"could not select the site {self.job.site!r} in the typeahead"
            )
        esaroute.open_report_list(page)

        prepared = esaroute.prepare_report(
            page, case.portal_label, agreement=self.job.agreement
        )
        result.template_selected = case.canonical_type
        self.say(f"{case.id}: params {', '.join(prepared.applied) or '(none)'}")

        destination = workspace.source / case.output_filename
        outcome = ssrs.export_pdf(
            page,
            destination,
            evidence_dir=workspace.evidence,
            tag=case.canonical_type,
            base_url=base_url,
            pdf_timeout_ms=20000,
            viewer_timeout_ms=20000,
            poll_ms=250,
        )
        result.artifacts.extend(outcome.screenshots)
        if not outcome.ok:
            result.export_status = results.FAILED
            raise ssrs.ExportError(outcome.reason)
        result.export_status = results.PASSED
        self.say(f"{case.id}: exported via {outcome.via}")

        self._validate_pdf(case, result, outcome.path, workspace)
        record = workspace.mark_downloaded(
            case.canonical_type, outcome.path, discovered_name=case.portal_label
        )
        record.validation = "verified pdf"
        record.pages = page_count(outcome.path)
        workspace.put(record)

    def _certificate(
        self, case: mockcases.Case, page, base_url: str, workspace: ws.Workspace
    ) -> None:
        result = self.report.by_id(case.id)
        assert result is not None

        esaroute.open_documentation(page, base_url)
        if not esaroute.select_site(page, self.job.site, keystroke_delay_ms=25):
            raise esaroute.RouteError("could not select the site for the library")
        page.get_by_text("Document Library", exact=True).first.click(timeout=20000)
        page.wait_for_timeout(500)

        with page.expect_download(timeout=30000) as info:
            page.get_by_text("Certificates", exact=True).first.click(timeout=20000)
        download = info.value
        original = workspace.source / (download.suggested_filename or "certificate.doc")
        download.save_as(str(original))
        result.export_status = results.PASSED
        result.artifacts.append(str(original))
        self.say(f"{case.id}: downloaded {original.name}")

        workspace.mark_downloaded(
            case.canonical_type, original, discovered_name="Certificates"
        )
        outcome = certdoc.prepare(original, workspace.converted)

        record = workspace.record(case.canonical_type)
        record.conversion_status = "converted"
        record.converted_path = workspace.relative(outcome.pdf)
        record.status = ws.CONVERTED
        record.validation = "not edited; requires human check"
        record.pages = page_count(outcome.pdf)
        workspace.put(record)
        workspace.require_review(outcome.reason)

        # The analysis is the evidence for the blocker, so it is reported rather
        # than summarised.
        analysis = outcome.analysis
        if analysis is not None:
            result.checks.append(
                {
                    "name": "certificate_not_editable",
                    "passed": not analysis.editable,
                    "detail": analysis.reason(),
                    "severity": validate.REQUIRED,
                }
            )
            if analysis.editable:
                result.formatting_defects.append(
                    "the certificate reports itself as safe to edit; the "
                    "checkbox mapping must be proven before that is acted on"
                )
        result.require_human_review(outcome.reason)
        self._validate_pdf(case, result, outcome.pdf, workspace)

    def _static(self, case: mockcases.Case, workspace: ws.Workspace) -> None:
        result = self.report.by_id(case.id)
        assert result is not None
        missing = pipeline.stage_static_assets(workspace, self.settings.assets_dir)
        record = workspace.record(case.canonical_type)
        if missing and not record.local_path:
            raise pipeline.PipelineError(
                f"static asset not found: {', '.join(missing)}"
            )
        path = workspace.resolve(record.local_path)
        result.export_status = results.NOT_APPLICABLE
        result.template_selected = case.canonical_type
        self._validate_pdf(case, result, path, workspace)
        record.pages = page_count(path)
        workspace.put(record)

        # A stand-in section is a legitimate way to exercise the pipeline from a
        # clean clone, but it must never pass silently: the deliverable it lands
        # in is a demonstration, not a report, and the run has to say so.
        if mockassets.is_stand_in(path):
            reason = (
                f"{case.canonical_type} is a synthetic stand-in, not the real "
                "section; this deliverable demonstrates the pipeline and must "
                "not be sent"
            )
            result.require_human_review(reason)
            result.block_finalization(reason)
            self.say(f"{case.id}: STAND-IN in use -- {reason}")

    def _derived(self, case: mockcases.Case, workspace: ws.Workspace) -> None:
        result = self.report.by_id(case.id)
        assert result is not None
        missing = pipeline.derive_ir_sections(workspace)
        if missing:
            raise pipeline.PipelineError(
                f"cannot derive {case.id}: {', '.join(missing)} is not available"
            )
        record = workspace.record(case.canonical_type)
        path = workspace.resolve(record.local_path)
        result.export_status = results.NOT_APPLICABLE
        result.template_selected = case.canonical_type
        self._validate_pdf(case, result, path, workspace)

    # -- validation -------------------------------------------------------
    def _validate_pdf(
        self,
        case: mockcases.Case,
        result: results.ReportResult,
        path: Path | None,
        workspace: ws.Workspace,
    ) -> None:
        report = validate.check_pdf_artifact(
            path,
            expected_filename=case.output_filename,
            expected_type=case.canonical_type,
            actual_type=canonical.classify(Path(path).name).key or "" if path else "",
            fields=case.expected_fields(self.job),
            min_pages=case.min_pages,
            max_pages=case.max_pages,
            secrets=[self.settings.password],
        )
        result.checks.extend(c.to_dict() for c in report.checks)
        if path:
            result.artifacts.append(str(path))
        for check in report.advisory_failures:
            result.formatting_defects.append(f"{check.name}: {check.detail}")

        missing = [
            c.name.removeprefix("text_has_")
            for c in report.required_failures
            if c.name.startswith("text_has_")
        ]
        result.missing_fields.extend(missing)

        if report.ok:
            result.generation_status = results.COMPLETED
            result.validation_status = results.PASSED
        else:
            result.validation_status = results.FAILED
            result.fail(report.reasons())

    # -- fault cases ------------------------------------------------------
    def _run_faults(self, browser) -> None:
        """Each fault gets its own portal, so one cannot mask another."""
        for case in self.matrix.faults:
            report = mockportal.BY_KEY.get(case.canonical_type)
            if report is None:
                self.say(f"{case.id}: no mock report for {case.canonical_type}")
                continue
            options = mockportal.Options(
                username=self.settings.username,
                password=self.settings.password,
                timing=self.settings.timing,
                faults=mockportal.Faults({report.slug: case.fault}),
            )
            with mockportal.MockPortal(options=options) as portal:
                context = browser.new_context(accept_downloads=True)
                page = context.new_page()
                page.set_default_timeout(15000)
                try:
                    workspace = ws.Workspace.create(
                        self.settings.work_root,
                        f"{self.job.job_id()}-fault-{case.id}",
                        customer=self.job.customer,
                        site=self.job.site,
                        site_visit=self.job.site_visit,
                    )
                    self._sign_in(page, portal.url, workspace)
                    self._attempt(
                        case,
                        lambda c: self._portal_report(
                            c, page, portal.url, workspace
                        ),
                    )
                except Exception as exc:
                    existing = self.report.by_id(case.id)
                    if existing is None:
                        result = self.report.add(
                            results.ReportResult(
                                report_id=case.id,
                                canonical_type=case.canonical_type,
                                input_fixture=self.matrix.source,
                            )
                        )
                        result.fail(str(exc).splitlines()[0][:300])
                        self._finish(case, result)
                finally:
                    context.close()

    # -- rerunning a report that already succeeded -------------------------
    def _rerun(self, browser, workspace: ws.Workspace) -> None:
        """Export a section a second time and prove nothing else moved.

        An operator who reruns one report should not have to wonder what it did
        to the rest of the job. Three things are checked together, because any
        one of them alone would let a real regression through: the second export
        is a valid PDF of the same length, the manifest still holds one record
        per section rather than accumulating duplicates, and the deliverable
        assembled before the rerun is byte-for-byte untouched.
        """
        target = None
        for candidate in self.matrix.sections():
            if candidate.kind != mockcases.PORTAL_REPORT:
                continue
            prior = self.report.by_id(candidate.id)
            if prior is not None and prior.ok:
                target = candidate
                break
        if target is None:
            self.report.notes.append(
                "rerun scenario skipped: no portal report succeeded to rerun"
            )
            return

        deliverable = Path(self.report.assembled) if self.report.assembled else None
        if deliverable is None or not deliverable.is_file():
            self.report.notes.append(
                "rerun scenario skipped: no assembled deliverable to protect"
            )
            return

        before_deliverable = ws.checksum(deliverable)
        before_pages = self.report.assembled_pages
        source = workspace.source / target.output_filename
        before_source_pages = page_count(source) if source.is_file() else 0
        before_records = len(workspace.records())

        result = self.report.add(
            results.ReportResult(
                report_id=RERUN_CASE_ID,
                canonical_type=target.canonical_type,
                input_fixture=self.matrix.source,
                expected_template=target.canonical_type,
            )
        )

        options = mockportal.Options(
            username=self.settings.username,
            password=self.settings.password,
            timing=self.settings.timing,
        )
        started = time.monotonic()
        with mockportal.MockPortal(options=options) as portal:
            context = browser.new_context(accept_downloads=True)
            page = context.new_page()
            page.set_default_timeout(30000)
            try:
                self._sign_in(page, portal.url, workspace)
                self._portal_report(target, page, portal.url, workspace, result)
            except Exception as exc:
                reason = str(exc).splitlines()[0][:300] or exc.__class__.__name__
                result.fail(reason, root_cause=str(diagnose.diagnose(reason)))
            finally:
                context.close()
        result.attempts = 1
        result.duration_ms = int((time.monotonic() - started) * 1000)

        after_records = len(workspace.records())
        checks = [
            validate.Check(
                "rerun_export_valid",
                result.validation_status == results.PASSED,
                result.failure_reason or "the second export validated",
            ),
            validate.Check(
                "rerun_page_count_stable",
                page_count(source) == before_source_pages,
                f"{before_source_pages} pages before, {page_count(source)} after",
            ),
            validate.Check(
                "rerun_does_not_duplicate_records",
                after_records == before_records,
                f"{before_records} manifest record(s) before, {after_records} after",
            ),
            validate.Check(
                "prior_deliverable_untouched",
                deliverable.is_file()
                and ws.checksum(deliverable) == before_deliverable,
                f"the {before_pages}-page DRAFT assembled before the rerun is "
                "unchanged" if deliverable.is_file()
                else "the DRAFT assembled before the rerun is gone",
            ),
        ]
        result.checks.extend(c.to_dict() for c in checks)
        passed = all(c.passed for c in checks)
        result.generation_status = (
            results.COMPLETED if passed else results.FAILED
        )
        result.validation_status = results.PASSED if passed else results.FAILED
        if passed:
            result.failure_reason = ""
        elif not result.failure_reason:
            result.fail(
                "; ".join(f"{c.name}: {c.detail}" for c in checks if not c.passed)
            )
        self.say(
            f"{RERUN_CASE_ID}: re-exported {target.canonical_type} -- "
            + ("no side effects" if passed else f"FAILED ({result.failure_reason})")
        )

    # -- assembly ---------------------------------------------------------
    def _assemble(self, workspace: ws.Workspace) -> None:
        name = naming.deliverable_name(
            self.job.customer, self.job.site, self.job.visit_date, draft=False
        )
        try:
            build = pipeline.build(workspace, name, mark_draft=True)
        except pipeline.PipelineError as exc:
            self.report.notes.append(f"assembly failed: {exc}")
            return

        if not build.ok or build.output is None:
            self.report.notes.append(
                "assembly blocked, missing: " + "; ".join(build.missing)
            )
            return

        self.report.assembled = str(build.output)
        self.report.assembled_pages = build.pages
        self.say(f"assembled {build.output.name} ({build.pages}p)")

    # -- acceptance -------------------------------------------------------
    def _score(self) -> None:
        """Decide whether this run is acceptable, and say why not if it is not."""
        section_ids = {c.id for c in self.matrix.sections()}
        section_results = [r for r in self.report.results if r.report_id in section_ids]
        covered = {r.canonical_type for r in section_results if r.ok}
        missing_types = [k for k in canonical.BUSINESS_ORDER if k not in covered]

        fault_ids = {c.id for c in self.matrix.faults}
        fault_results = [r for r in self.report.results if r.report_id in fault_ids]

        artifacts: list[Path] = []
        for result in self.report.results:
            artifacts.extend(Path(a) for a in result.artifacts)
        if self.report.assembled:
            artifacts.append(Path(self.report.assembled))
        secret_check = validate.no_secrets(artifacts, [self.settings.password])

        blocked = bool(self.report.blocked)
        final_checks = [
            validate.not_final_while_blocked(
                Path(self.report.assembled).name if self.report.assembled else "",
                finalization_blocked=blocked,
            )
        ]
        name_check = (
            naming.check(
                Path(self.report.assembled).name,
                customer=self.job.customer,
                site=self.job.site,
                visit_date=self.job.visit_date,
                expect_draft=True,
            )
            if self.report.assembled
            else naming.NameCheck("", False, ["no report was assembled"])
        )

        review = self.report.human_review_required
        criteria = {
            "all_ten_sections_generated": {
                "ok": not missing_types,
                # Counted over the business order only. STANDARD_IR is an
                # eleventh canonical type that is fetched and then split; it is
                # a source, not a section, and counting it would report 11/10.
                "detail": f"{len([k for k in canonical.BUSINESS_ORDER if k in covered])}"
                f"/{len(canonical.BUSINESS_ORDER)} sections"
                + (f"; missing {', '.join(missing_types)}" if missing_types else ""),
            },
            "assembled_report_produced": {
                "ok": bool(self.report.assembled),
                "detail": self.report.assembled or "nothing assembled",
            },
            "every_section_validated": {
                "ok": all(
                    r.validation_status == results.PASSED for r in section_results
                ),
                "detail": "; ".join(
                    f"{r.report_id}={r.validation_status}"
                    for r in section_results
                    if r.validation_status != results.PASSED
                )
                or f"{len(section_results)} section(s) validated",
            },
            "failures_are_diagnosed": {
                "ok": all(r.ok for r in fault_results) and bool(fault_results),
                "detail": "; ".join(
                    f"{r.report_id}: {r.failure_reason or r.root_cause}"
                    for r in fault_results
                    if not r.ok
                )
                or f"{len(fault_results)} fault case(s) detected and localised",
            },
            "no_secrets_in_artifacts": {
                "ok": secret_check.passed,
                "detail": secret_check.detail,
            },
            "no_unsupported_final_label": {
                "ok": all(c.passed for c in final_checks),
                "detail": "; ".join(c.detail for c in final_checks),
            },
            "deliverable_name_follows_convention": {
                "ok": name_check.ok,
                "detail": "; ".join(name_check.problems) or name_check.name,
            },
            "results_internally_consistent": {
                "ok": not self.report.inconsistencies(),
                "detail": "; ".join(self.report.inconsistencies()) or "no contradictions",
            },
            "human_review_is_declared": {
                "ok": bool(review),
                "detail": "; ".join(
                    f"{r.report_id}: {'; '.join(r.human_review)}" for r in review
                )
                or "nothing declared -- the certificate should always require review",
            },
        }

        rerun = self.report.by_id(RERUN_CASE_ID)
        criteria["rerun_leaves_prior_artifacts_intact"] = {
            "ok": rerun is not None and rerun.ok,
            "detail": (
                "the rerun scenario did not run"
                if rerun is None
                else rerun.failure_reason
                or f"{rerun.canonical_type} re-exported with no side effects"
            ),
        }
        self.report.acceptance = criteria

    # -- reporting --------------------------------------------------------
    @property
    def acceptable(self) -> bool:
        return all(c["ok"] for c in self.report.acceptance.values())
