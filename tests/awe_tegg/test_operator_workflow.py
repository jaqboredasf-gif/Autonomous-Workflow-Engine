"""The coworker's workflow, driven the way a coworker drives it.

Every test here corresponds to something the Windows mock run got wrong, or to
a safety property that must not regress when somebody makes the next change:

  * the intake wizard asks, validates, confirms and can be cancelled;
  * the visit ID the operator typed is the one the portal layer receives;
  * every document in the package is required, and a short package is a
    failed run rather than a quiet success;
  * the email draft names them all and is never sent;
  * no credential reaches a log, an output, the config or the package;
  * a path with spaces in it -- which is every Windows path that matters --
    survives the round trip;
  * a rerun does not re-render documents it already has.

The wizard is driven through injected ``ask``/``say`` callables, so these are
real end-to-end exercises of the prompts an operator sees, not assertions about
strings in the source.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from awe_tegg import deliverables, email_draft, intake, portal_write, visit_operation


# ---------------------------------------------------------------------------
# Driving the wizard
# ---------------------------------------------------------------------------


class Operator:
    """A scripted person at the keyboard. Records everything they were shown."""

    def __init__(self, keystrokes: list[str]) -> None:
        self.keystrokes = list(keystrokes)
        self.screen: list[str] = []

    def ask(self, prompt: str) -> str:
        if not self.keystrokes:
            raise EOFError("the operator ran out of answers")
        return self.keystrokes.pop(0)

    def say(self, line: str) -> None:
        self.screen.append(line)

    @property
    def text(self) -> str:
        return "\n".join(self.screen)


#: A full, valid set of answers, in the order the wizard asks for them.
GOOD_ANSWERS = [
    "T25-204",                        # 1 visit ID
    "Atlas Capital",                  # 2 customer
    "The Factory",                    # 3 site
    "120 Mill Street, Toledo OH",     # 4 address
    "Paul Lippolis",                  # 5 recipient name
    "paul@example.com",               # 6 recipient email
    "T25-204-ESA",                    # 7 job number
    "",                               # 8 report scope (optional)
    "1",                              # 9 evidence path
]


#: The six documents that come from Reports > Standard ESA Reports. The Table
#: of Contents (static) and the Certificate (Document Library) are produced by
#: their own functions and are not part of the report loop.
ESA_REPORTS = [
    item for item in deliverables.REQUIRED
    if item.source == deliverables.FROM_ESA_REPORT
]


def _pdf(path: Path, pages: int = 3) -> Path:
    """A genuinely openable PDF.

    The validator re-opens what it is given, so a file that merely starts
    ``%PDF-`` is not enough -- which is the point of the validator.
    """
    from pypdf import PdfWriter

    path.parent.mkdir(parents=True, exist_ok=True)
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=612, height=792)
    with path.open("wb") as handle:
        writer.write(handle)
    return path


def _full_manifest(tmp_path: Path, visit: str = "T25-204") -> deliverables.Manifest:
    """Every required document present, valid, and distinct from the others.

    Distinct matters: the manifest refuses a package where one file has been
    filed under two names, so every fixture needs its own page count and its
    own checksum.
    """
    manifest = deliverables.Manifest.create(visit)
    for number, expected in enumerate(deliverables.REQUIRED, start=1):
        manifest.record(
            expected.key,
            _pdf(tmp_path / expected.filename(visit), pages=number),
            status=deliverables.GENERATED,
            sha256=f"checksum-{expected.key}",
        )
    return manifest


# ---------------------------------------------------------------------------
# 1. Every required prompt appears
# ---------------------------------------------------------------------------


def test_every_required_prompt_is_asked():
    operator = Operator(GOOD_ANSWERS + ["y"])
    answers = intake.collect(operator.ask, operator.say)

    shown = operator.text.lower()
    for wanted in (
        "tegg visit id",
        "customer / company name",
        "site name",
        "site address",
        "recipient's name",
        "recipient's email",
        "job / reference number",
        "reports wanted",
        "findings source",
    ):
        assert wanted in shown, f"the operator was never asked for {wanted!r}"

    assert answers.site_visit == "T25-204"
    assert answers.customer == "Atlas Capital"
    assert answers.recipient_email == "paul@example.com"
    assert answers.evidence_path == intake.FROM_TEGG


def test_both_evidence_paths_are_offered():
    """C: retrieve from TEGG, or retrieve then supplement."""
    operator = Operator(GOOD_ANSWERS[:-1] + ["2", "y"])
    answers = intake.collect(operator.ask, operator.say)
    assert answers.evidence_path == intake.FROM_OPERATOR
    assert answers.supplementing

    supplementing = Operator(["the north switchgear was not accessible"])
    answers = intake.review_supplement(
        answers, supplementing.ask, supplementing.say,
        findings_summary="3 findings, 2 needing an estimate",
    )
    assert "north switchgear" in answers.operator_notes
    assert "3 findings" in supplementing.text


# ---------------------------------------------------------------------------
# 2. Blank required fields are rejected
# ---------------------------------------------------------------------------


def test_blank_required_field_is_rejected_and_reasked():
    operator = Operator(["", "   ", "T25-204"] + GOOD_ANSWERS[1:] + ["y"])
    answers = intake.collect(operator.ask, operator.say)

    assert answers.site_visit == "T25-204"
    assert operator.text.count("This one is needed") == 2


def test_a_malformed_email_is_rejected():
    answers_with_bad_email = list(GOOD_ANSWERS)
    answers_with_bad_email[5] = "paul-at-example"
    operator = Operator(
        answers_with_bad_email[:6] + ["paul@example.com"]
        + answers_with_bad_email[6:] + ["y"]
    )
    answers = intake.collect(operator.ask, operator.say)

    assert answers.recipient_email == "paul@example.com"
    assert "does not look like an email address" in operator.text


def test_the_optional_field_may_be_left_blank():
    operator = Operator(GOOD_ANSWERS + ["y"])
    answers = intake.collect(operator.ask, operator.say)
    assert answers.report_scope == ""
    assert answers.to_dict()["report_scope"] == "the standard TEGG ESA package"


# ---------------------------------------------------------------------------
# 3. Confirming and revising
# ---------------------------------------------------------------------------


def test_the_operator_sees_a_confirmation_screen_listing_every_answer():
    operator = Operator(GOOD_ANSWERS + ["y"])
    intake.collect(operator.ask, operator.say)

    assert "CONFIRM" in operator.text
    for value in ("T25-204", "Atlas Capital", "The Factory", "Paul Lippolis",
                  "paul@example.com", "T25-204-ESA"):
        assert value in operator.text


def test_the_operator_can_revise_one_answer_then_confirm():
    # Confirm screen: "2" revises the customer, then Y.
    operator = Operator(GOOD_ANSWERS + ["2", "Borden Foods", "y"])
    answers = intake.collect(operator.ask, operator.say)

    assert answers.customer == "Borden Foods"
    assert answers.site == "The Factory", "revising one field disturbed another"
    assert answers.site_visit == "T25-204"


def test_an_unrecognised_confirmation_answer_re_asks_rather_than_proceeding():
    operator = Operator(GOOD_ANSWERS + ["maybe", "99", "y"])
    answers = intake.collect(operator.ask, operator.say)
    assert answers.customer == "Atlas Capital"
    assert operator.text.count("is not Y, C, or a number") == 2


# ---------------------------------------------------------------------------
# 4. Cancelling is always safe
# ---------------------------------------------------------------------------


def test_cancelling_at_the_confirmation_screen_raises_and_does_nothing():
    operator = Operator(GOOD_ANSWERS + ["c"])
    with pytest.raises(intake.IntakeCancelled) as stop:
        intake.collect(operator.ask, operator.say)
    assert "nothing was sent to TEGG" in str(stop.value)


def test_ctrl_c_partway_through_cancels_safely():
    class Interrupting(Operator):
        def ask(self, prompt: str) -> str:
            if len(self.screen) > 12:
                raise KeyboardInterrupt
            return super().ask(prompt)

    operator = Interrupting(GOOD_ANSWERS)
    with pytest.raises(intake.IntakeCancelled) as stop:
        intake.collect(operator.ask, operator.say)
    assert "no report was created" in str(stop.value)
    assert "no email was drafted" in str(stop.value)


def test_running_out_of_input_cancels_rather_than_hanging():
    operator = Operator(["T25-204"])
    with pytest.raises(intake.IntakeCancelled):
        intake.collect(operator.ask, operator.say)


# ---------------------------------------------------------------------------
# 5. The visit ID reaches the portal layer
# ---------------------------------------------------------------------------


def test_the_typed_visit_id_is_what_choose_visit_is_asked_for():
    records = [
        {"identifier": "T25-204", "status": "Completed", "agreement": "STD1-01/25-01",
         "site": "The Factory", "customer": "Atlas Capital", "end_date": "5/1/2026"},
        {"identifier": "T25-999", "status": "Completed", "agreement": "STD2-01/25-01",
         "site": "Other Site", "customer": "Someone Else", "end_date": "9/1/2026"},
    ]
    # T25-999 is the most recent, so the standing rule would pick it. The
    # operator asked for T25-204 and must get T25-204.
    chosen, why = visit_operation.choose_visit(records, "T25-204")
    assert chosen["identifier"] == "T25-204"
    assert "explicitly" in why


def test_intake_visit_id_flows_into_the_visit_settings():
    answers = intake.Intake(site_visit="T25-204", customer="Atlas Capital")
    settings = visit_operation.VisitSettings(intake=answers,
                                             site_visit=answers.site_visit)
    assert settings.site_visit == "T25-204"
    assert settings.to_dict()["intake"]["site_visit"] == "T25-204"


def test_an_unknown_visit_id_is_an_error_naming_what_was_available():
    records = [
        {"identifier": "T25-204", "status": "Completed", "agreement": "A",
         "site": "S", "customer": "C", "end_date": "5/1/2026"},
    ]
    with pytest.raises(Exception) as stop:
        visit_operation.choose_visit(records, "T25-777")
    assert "T25-204" in str(stop.value)


# ---------------------------------------------------------------------------
# 6. Five documents are required
# ---------------------------------------------------------------------------


def test_the_contract_is_eight_documents():
    assert deliverables.REQUIRED_COUNT == 8
    assert len(deliverables.REQUIRED) == 8
    assert len({e.key for e in deliverables.REQUIRED}) == 8


def test_a_complete_manifest_passes_enforcement(tmp_path: Path):
    manifest = _full_manifest(tmp_path)
    assert manifest.complete
    assert len(manifest.produced) == 8
    manifest.enforce()


@pytest.mark.parametrize("produced", [0, 1, 2, 4, 6, 7])
def test_fewer_than_the_full_package_is_a_failed_run(tmp_path: Path, produced: int):
    """The exact defect the mock run hit: two documents reported as success."""
    manifest = deliverables.Manifest.create("T25-204")
    for number, expected in enumerate(deliverables.REQUIRED[:produced], start=1):
        manifest.record(
            expected.key,
            _pdf(tmp_path / expected.filename("T25-204"), pages=number),
            status=deliverables.GENERATED, sha256=f"checksum-{expected.key}",
        )
    for expected in deliverables.REQUIRED[produced:]:
        manifest.fail(expected.key, "the report form did not offer an agreement")

    assert not manifest.complete
    with pytest.raises(deliverables.DeliverableError) as stop:
        manifest.enforce()
    assert f"has {produced}" in str(stop.value)
    assert "Not calling this finished" in str(stop.value)


def test_a_file_wearing_a_pdf_header_does_not_count(tmp_path: Path):
    """A truncated export keeps the header and loses everything after it."""
    manifest = deliverables.Manifest.create("T25-204")
    for number, expected in enumerate(deliverables.REQUIRED[:-1], start=1):
        manifest.record(
            expected.key,
            _pdf(tmp_path / expected.filename("T25-204"), pages=number),
            sha256=f"checksum-{expected.key}",
        )
    hollow = tmp_path / "hollow.pdf"
    hollow.write_bytes(b"%PDF-1.7\nnothing here\n%%EOF\n")
    entry = manifest.record(deliverables.REQUIRED[-1].key, hollow)

    assert entry.validation == deliverables.NOT_PDF
    assert "will not open" in entry.detail
    assert not entry.ok
    with pytest.raises(deliverables.DeliverableError):
        manifest.enforce()


def test_a_zero_byte_file_does_not_count(tmp_path: Path):
    manifest = deliverables.Manifest.create("T25-204")
    blank = tmp_path / "blank.pdf"
    blank.write_bytes(b"")
    entry = manifest.record(deliverables.REQUIRED[0].key, blank)
    assert entry.validation == deliverables.EMPTY
    assert not entry.ok


def test_a_real_but_short_report_still_counts(tmp_path: Path):
    """A clean site's summary is legitimately one page. It is not a failure."""
    manifest = deliverables.Manifest.create("T25-204")
    entry = manifest.record(
        deliverables.REQUIRED[0].key,
        _pdf(tmp_path / "one-page.pdf", pages=1),
    )
    assert entry.validation == deliverables.VALID
    assert entry.ok


def test_a_document_that_is_not_a_pdf_does_not_count(tmp_path: Path):
    manifest = deliverables.Manifest.create("T25-204")
    html = tmp_path / "error.pdf"
    html.write_bytes(b"<html><body>Server Error</body></html>" + b" " * 20_000)
    entry = manifest.record(deliverables.REQUIRED[0].key, html)
    assert entry.validation == deliverables.NOT_PDF
    assert not entry.ok


def test_the_manifest_records_every_field_the_contract_asks_for(tmp_path: Path):
    manifest = _full_manifest(tmp_path)
    written = manifest.write(tmp_path / "run")
    payload = json.loads(written.read_text(encoding="utf-8"))

    assert payload["required"] == 8
    assert payload["produced"] == 8
    assert payload["complete"] is True
    for row in payload["documents"]:
        assert row["canonical_name"]                    # canonical name
        assert row["generated_filename"]                # generated filename
        assert row["source"]                            # source / template
        assert row["status"] == deliverables.GENERATED  # generation status
        assert row["validation"] == deliverables.VALID  # validation status
        assert row["location"]                          # final location


def test_seven_valid_and_one_missing_fails_and_names_the_missing_document(
    tmp_path: Path,
):
    """The near-miss case: everything but one, which is the easiest to ship."""
    for missing in deliverables.REQUIRED:
        manifest = deliverables.Manifest.create("T25-204")
        for number, expected in enumerate(deliverables.REQUIRED, start=1):
            if expected.key == missing.key:
                manifest.fail(expected.key, "the report form did not render")
                continue
            manifest.record(
                expected.key,
                _pdf(tmp_path / expected.filename("T25-204"), pages=number),
                sha256=f"checksum-{expected.key}",
            )

        assert len(manifest.produced) == 7
        assert not manifest.complete
        with pytest.raises(deliverables.DeliverableError) as stop:
            manifest.enforce()
        message = str(stop.value)
        assert "has 7" in message
        assert missing.canonical_name in message, (
            f"the failure did not name the missing document {missing.key!r}"
        )


def test_the_long_and_short_inventory_are_separate_and_cannot_substitute(
    tmp_path: Path,
):
    """Long Form and Short Form are two documents, not two names for one.

    Evidence: the 2026-07-29 dry run downloaded the Short Form and failed the
    Long Form independently, on the same site in the same run.
    """
    long_form = deliverables.BY_KEY["equipment_inventory_long"]
    short_form = deliverables.BY_KEY["equipment_inventory_short"]

    # Different slots, different routes, different filenames.
    assert long_form.key != short_form.key
    assert long_form.route != short_form.route
    assert long_form.route == ("Equipment Inventory", "Long Form")
    assert short_form.route == ("Equipment Inventory", "Short Form")
    assert long_form.filename("T25-204") != short_form.filename("T25-204")
    assert set(deliverables.INVENTORY_PAIR) == {long_form.key, short_form.key}

    # Having the Short Form does not satisfy the Long Form.
    manifest = deliverables.Manifest.create("T25-204")
    for number, expected in enumerate(deliverables.REQUIRED, start=1):
        if expected.key == long_form.key:
            manifest.fail(expected.key, "did not render")
            continue
        manifest.record(
            expected.key,
            _pdf(tmp_path / expected.filename("T25-204"), pages=number),
            sha256=f"checksum-{expected.key}",
        )
    with pytest.raises(deliverables.DeliverableError) as stop:
        manifest.enforce()
    assert long_form.canonical_name in str(stop.value)

    # And filing the same file under both is caught, not counted twice.
    both = deliverables.Manifest.create("T25-204")
    shared = _pdf(tmp_path / "one-inventory.pdf", pages=5)
    for number, expected in enumerate(deliverables.REQUIRED, start=1):
        if expected.key in deliverables.INVENTORY_PAIR:
            both.record(expected.key, shared, sha256="the-same-file")
            continue
        both.record(
            expected.key,
            _pdf(tmp_path / expected.filename("T25-204"), pages=number),
            sha256=f"checksum-{expected.key}",
        )
    assert len(both.duplicates()) == 1
    assert not both.complete
    with pytest.raises(deliverables.DeliverableError) as stop:
        both.enforce()
    assert "One report has been filed as two" in str(stop.value)


def test_a_document_filed_under_another_documents_name_is_caught(tmp_path: Path):
    """Wrong report type in a slot, even when the bytes differ."""
    manifest = deliverables.Manifest.create("T25-204")
    for number, expected in enumerate(deliverables.REQUIRED, start=1):
        manifest.record(
            expected.key,
            _pdf(tmp_path / expected.filename("T25-204"), pages=number),
            sha256=f"checksum-{expected.key}",
        )
    # A genuinely different file, in a different place, but carrying the Long
    # Form's name -- so it is not a duplicate, it is the wrong type in a slot.
    long_form = deliverables.BY_KEY["equipment_inventory_long"]
    elsewhere = tmp_path / "elsewhere"
    manifest.record(
        "equipment_inventory_short",
        _pdf(elsewhere / long_form.filename("T25-204"), pages=11),
        sha256="a-different-checksum",
    )
    assert not manifest.duplicates(), "this case must not read as a duplicate"
    assert manifest.misfiled()
    with pytest.raises(deliverables.DeliverableError) as stop:
        manifest.enforce()
    assert "which is Inventory Equipment - Long Form's file" in str(stop.value)


def test_every_expected_filename_is_distinct():
    names = [e.filename("T25-204") for e in deliverables.REQUIRED]
    assert len(set(names)) == len(names), "two documents share a filename"


def test_no_two_documents_share_a_route():
    routes = [e.route for e in deliverables.REQUIRED if e.route]
    assert len(set(routes)) == len(routes), "two documents share a portal route"


def test_the_summary_document_is_not_confused_with_the_other_summaries():
    """The live Reports list offers four reports whose name ends 'Summary'."""
    summary = deliverables.BY_KEY["eds_all_problems"]
    counts = deliverables.BY_KEY["problem_count_summary"]
    assert summary.route == ("EDS Component Problem Summary", "All Problems")
    assert counts.route == ("Problem Count Summary",)
    assert summary.route != counts.route


def test_the_three_sources_are_distinct_mechanisms():
    by_source: dict[str, int] = {}
    for item in deliverables.REQUIRED:
        by_source[item.source] = by_source.get(item.source, 0) + 1
    assert by_source[deliverables.FROM_STATIC] == 1
    assert by_source[deliverables.FROM_DOCUMENT_LIBRARY] == 1
    assert by_source[deliverables.FROM_ESA_REPORT] == 6
    assert len(deliverables.PORTAL_REQUIRED) == 7

    toc = deliverables.BY_KEY["table_of_contents"]
    assert toc.static_source == "ESA Table of Contents.pdf"
    assert not toc.route, "the Table of Contents is not fetched from TEGG"
    assert not toc.from_portal

    certificate = deliverables.BY_KEY["certificate"]
    assert certificate.needs_conversion
    assert certificate.route[0] == "Document Library"


def test_the_manifest_round_trips(tmp_path: Path):
    manifest = _full_manifest(tmp_path)
    written = manifest.write(tmp_path / "run")
    again = deliverables.Manifest.load(written)
    assert again.complete
    assert again.filenames() == manifest.filenames()


# ---------------------------------------------------------------------------
# 7 & 8. The email draft
# ---------------------------------------------------------------------------


def _draft(tmp_path: Path) -> tuple[email_draft.Draft, deliverables.Manifest]:
    manifest = _full_manifest(tmp_path)
    answers = intake.Intake(
        site_visit="T25-204", customer="Atlas Capital", site="The Factory",
        site_address="120 Mill Street", recipient_name="Paul Lippolis",
        recipient_email="paul@example.com", job_number="T25-204-ESA",
    )
    return email_draft.build(answers, manifest), manifest


def test_the_email_draft_lists_every_filename(tmp_path: Path):
    draft, manifest = _draft(tmp_path)
    assert len(manifest.filenames()) == 8
    for name in manifest.filenames():
        assert name in draft.body, f"{name} is not named in the email body"


def test_the_email_draft_attaches_all_five(tmp_path: Path):
    draft, _ = _draft(tmp_path)
    written = email_draft.write(draft, tmp_path / "email")

    assert written.attached_ok
    assert len(written.attachments) == 8
    raw = written.path.read_bytes()
    for name in (p.name for p in written.attachments):
        assert name.encode() in raw, f"{name} is not attached to the message"


def test_the_draft_names_the_customer_and_site_in_the_subject(tmp_path: Path):
    draft, _ = _draft(tmp_path)
    assert "Atlas Capital" in draft.subject
    assert "The Factory" in draft.subject
    assert "T25-204-ESA" in draft.subject


def test_the_draft_is_addressed_to_the_recipient_who_was_entered(tmp_path: Path):
    draft, _ = _draft(tmp_path)
    written = email_draft.write(draft, tmp_path / "email")
    raw = written.path.read_text(encoding="utf-8", errors="replace")
    assert "paul@example.com" in raw
    assert "Paul Lippolis" in raw
    assert "Hi Paul," in written.body


def test_a_staging_folder_and_instructions_always_exist(tmp_path: Path):
    draft, _ = _draft(tmp_path)
    email_draft.write(draft, tmp_path / "email")

    staging = tmp_path / "email" / email_draft.STAGING_DIR
    assert staging.is_dir()
    assert len(list(staging.glob("*.pdf"))) == 8

    how = (tmp_path / "email" / email_draft.INSTRUCTIONS_NAME).read_text(
        encoding="utf-8")
    assert "has NOT sent anything" in how
    assert str(staging) in how
    assert "Press Send yourself" in how


def test_no_draft_is_written_for_a_short_package(tmp_path: Path):
    """There is no path that emails a four-document package."""
    manifest = deliverables.Manifest.create("T25-204")
    for number, expected in enumerate(deliverables.REQUIRED[:-1], start=1):
        manifest.record(
            expected.key,
            _pdf(tmp_path / expected.filename("T25-204"), pages=number),
            sha256=f"checksum-{expected.key}",
        )
    manifest.fail(deliverables.REQUIRED[-1].key, "did not render")

    answers = intake.Intake(recipient_email="paul@example.com")
    with pytest.raises(deliverables.DeliverableError):
        email_draft.build(answers, manifest)


def test_the_email_module_cannot_send(tmp_path: Path):
    """Not "does not send" -- has no code with which to send.

    Checked against the parsed module rather than its text, so the docstring
    may go on saying which transports are deliberately absent.
    """
    import ast

    tree = ast.parse(Path(email_draft.__file__).read_text(encoding="utf-8"))
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module.split(".")[0])

    for transport in ("smtplib", "socket", "requests", "urllib", "http",
                      "win32com", "subprocess", "ssl"):
        assert transport not in imported, (
            f"email_draft.py imports {transport!r}; this module must have no "
            "way to transmit anything"
        )

    functions = {n.name for n in ast.walk(tree)
                 if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}
    assert not {f for f in functions if "send" in f.lower()}
    assert not hasattr(email_draft, "send")

    draft, _ = _draft(tmp_path)
    written = email_draft.write(draft, tmp_path / "email")
    assert written.to_dict()["sent"] is False
    assert written.to_dict()["sendable_by_this_tool"] is False


def test_the_draft_says_it_is_a_draft(tmp_path: Path):
    draft, _ = _draft(tmp_path)
    written = email_draft.write(draft, tmp_path / "email")
    raw = written.path.read_text(encoding="utf-8", errors="replace")
    assert email_draft.BANNER in raw
    assert "X-Unsent" in raw


# ---------------------------------------------------------------------------
# 9. Credentials never land anywhere
# ---------------------------------------------------------------------------


SECRET = "hunter2-not-a-real-password"


def test_the_intake_never_asks_for_a_credential():
    shown = " ".join(
        f"{f.prompt} {f.note} {f.example}" for f in intake.FIELDS
    ).lower()
    for word in ("password", "passphrase", "secret", "token", "pin"):
        assert word not in shown, f"the intake screen asks for a {word}"

    operator = Operator(GOOD_ANSWERS + ["y"])
    answers = intake.collect(operator.ask, operator.say)
    for word in ("password", "secret", "token"):
        assert word not in json.dumps(answers.to_dict()).lower()


def test_the_intake_tells_the_operator_it_will_not_store_their_sign_in():
    operator = Operator(GOOD_ANSWERS + ["y"])
    intake.collect(operator.ask, operator.say)
    assert "never saved" in operator.text


def test_no_credential_reaches_the_manifest_or_the_draft(tmp_path: Path,
                                                         monkeypatch):
    monkeypatch.setenv("TEGG_USERNAME", "portal-user")
    monkeypatch.setenv("TEGG_PASSWORD", SECRET)

    draft, manifest = _draft(tmp_path)
    written_manifest = manifest.write(tmp_path / "run")
    written_draft = email_draft.write(draft, tmp_path / "email")

    for path in (written_manifest, written_draft.path,
                 tmp_path / "email" / email_draft.INSTRUCTIONS_NAME):
        text = Path(path).read_text(encoding="utf-8", errors="replace")
        assert SECRET not in text
        assert "portal-user" not in text


def test_no_source_file_in_the_package_carries_a_credential():
    """A hard-coded credential must not exist anywhere that ships.

    Looks for an assignment of a string literal to a credential-shaped name --
    ``password = "..."`` -- rather than for the word, so a constant that merely
    *documents* where credentials come from does not read as one.
    """
    import ast

    root = Path(__file__).resolve().parents[2]
    secretish = ("password", "passwd", "secret", "token", "credential",
                 "apikey", "api_key")
    #: Names that describe where a credential lives rather than holding one.
    describing = ("source", "env", "var", "name", "prompt", "label", "message")
    suspicious = []

    for path in (root / "src").rglob("*.py"):
        try:
            tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"))
        except SyntaxError:                                 # pragma: no cover
            continue
        for node in ast.walk(tree):
            if not isinstance(node, ast.Assign):
                continue
            if not isinstance(node.value, ast.Constant) or \
                    not isinstance(node.value.value, str):
                continue
            for target in node.targets:
                name = getattr(target, "id", "") or getattr(target, "attr", "")
                lowered = name.lower()
                if not any(word in lowered for word in secretish):
                    continue
                if any(word in lowered for word in describing):
                    continue
                suspicious.append(f"{path.name}:{node.lineno} {name}")
    assert not suspicious, suspicious


def test_the_service_file_still_refuses_credentials(tmp_path: Path):
    from awe_tegg.operation import OperationError, load_settings

    bad = tmp_path / "service.yaml"
    bad.write_text("service:\n  base_url: http://x\n  password: hunter2\n",
                   encoding="utf-8")
    with pytest.raises(OperationError) as stop:
        load_settings(bad)
    assert "password" in str(stop.value)


# ---------------------------------------------------------------------------
# 10. Windows paths with spaces
# ---------------------------------------------------------------------------


def test_a_path_with_spaces_survives_the_whole_package(tmp_path: Path):
    """Every real Windows path has a space in it: 'C:\\Users\\Paul Smith\\...'."""
    spaced = tmp_path / "C drive" / "Users" / "Paul Smith" / "TEGG Report Tool"
    spaced.mkdir(parents=True)

    manifest = _full_manifest(spaced)
    manifest.enforce()
    written = manifest.write(spaced / "run folder")
    assert written.exists()

    reloaded = deliverables.Manifest.load(written)
    assert reloaded.complete
    for entry in reloaded.entries:
        assert Path(entry.location).exists()
        assert " " in entry.location

    answers = intake.Intake(
        site_visit="T25-204", customer="Atlas Capital", site="The Factory",
        recipient_name="Paul Smith", recipient_email="paul@example.com",
    )
    draft = email_draft.write(
        email_draft.build(answers, manifest), spaced / "email folder"
    )
    assert draft.path.exists()
    assert len(draft.staged) == 8
    assert all(p.exists() for p in draft.staged)


def test_a_visit_id_with_a_slash_does_not_escape_its_folder():
    # A portal document, whose filename carries the visit identifier. The
    # static Table of Contents does not and is deliberately not tested here.
    expected = deliverables.BY_KEY["standard_ir"]
    name = expected.filename("T25/204 01")
    assert "/" not in name
    assert " " not in name
    assert name.endswith("-StandardIRReport.pdf")


# ---------------------------------------------------------------------------
# 11. Reruns do not duplicate completed work
# ---------------------------------------------------------------------------


class FakeLedger:
    def __init__(self, steps: list[dict]) -> None:
        self.data = {"steps": steps}
        self.notes: list[str] = []
        self.escalations: list[str] = []

    def note(self, message: str) -> None:
        self.notes.append(message)

    def escalate(self, message: str) -> None:
        self.escalations.append(message)


class CountingReports:
    """Stands in for ReportRun and counts what it was actually asked to render."""

    def __init__(self, out_dir: Path) -> None:
        self.out_dir = out_dir
        self.rendered: list[str] = []

    def retrieve(self, name, path, *, agreement, filename):
        self.rendered.append(filename)
        target = _pdf(self.out_dir / filename)

        class Got:
            def to_dict(self_inner):
                return {"name": name, "path": str(target), "bytes": target.stat().st_size}
            path = str(target)
        got = Got()
        got.path = str(target)
        return got


def test_a_rerun_with_everything_on_disk_renders_nothing_again(tmp_path: Path):
    from awe_tegg import findings as findings_module

    documents = tmp_path / "documents"
    already = {}
    for number, expected in enumerate(ESA_REPORTS, start=1):
        path = _pdf(documents / expected.filename("T25-204"), pages=number)
        already[expected.key] = {
            "path": str(path),
            "sha256": findings_module.checksum(path),
        }

    ledger = FakeLedger([{"step": "retrieve_documents",
                          "data": {"documents": already}}])
    reusable = visit_operation._reusable_documents(ledger, documents)
    assert len(reusable) == len(ESA_REPORTS)

    manifest = deliverables.Manifest.create("T25-204")
    reports = CountingReports(documents)
    visit_operation._retrieve(
        reports, {"identifier": "T25-204", "agreement": "A"}, ledger, manifest,
        already=reusable,
    )

    assert reports.rendered == [], "a rerun re-rendered documents it already had"
    assert all(manifest.entry(e.key).status == deliverables.REUSED
               for e in ESA_REPORTS)


def test_a_rerun_missing_one_document_renders_only_that_one(tmp_path: Path):
    from awe_tegg import findings as findings_module

    documents = tmp_path / "documents"
    already = {}
    for number, expected in enumerate(ESA_REPORTS[:-1], start=1):
        path = _pdf(documents / expected.filename("T25-204"), pages=number)
        already[expected.key] = {
            "path": str(path),
            "sha256": findings_module.checksum(path),
        }

    ledger = FakeLedger([{"step": "retrieve_documents",
                          "data": {"documents": already}}])
    manifest = deliverables.Manifest.create("T25-204")
    reports = CountingReports(documents)
    visit_operation._retrieve(
        reports, {"identifier": "T25-204", "agreement": "A"}, ledger, manifest,
        already=visit_operation._reusable_documents(ledger, documents),
    )

    assert len(reports.rendered) == 1
    assert ESA_REPORTS[-1].filename("T25-204") in reports.rendered[0]


def test_a_document_whose_checksum_changed_is_not_reused(tmp_path: Path):
    documents = tmp_path / "documents"
    path = _pdf(documents / "T25-204-StandardIRReport.pdf")
    ledger = FakeLedger([{
        "step": "retrieve_documents",
        "data": {"documents": {"standard_ir": {
            "path": str(path), "sha256": "a-checksum-that-no-longer-matches",
        }}},
    }])
    assert visit_operation._reusable_documents(ledger, documents) == {}


def test_the_intake_is_restored_from_the_ledger_on_a_resume():
    answers = intake.Intake(
        site_visit="T25-204", customer="Atlas Capital",
        recipient_email="paul@example.com",
    )
    restored = intake.Intake.from_dict(answers.to_dict())
    assert restored.site_visit == "T25-204"
    assert restored.customer == "Atlas Capital"
    assert restored.recipient_email == "paul@example.com"


# ---------------------------------------------------------------------------
# 12. The TEGG write stays shut unless deliberately opened
# ---------------------------------------------------------------------------


def test_the_write_capability_is_off_by_default():
    policy = portal_write.WritePolicy()
    assert not policy.enabled
    assert not policy.armed
    assert "read-only" in policy.describe()


def test_enabling_without_confirming_does_not_arm_it():
    policy = portal_write.WritePolicy(enabled=True, create_labels=("Save",))
    assert not policy.armed
    with pytest.raises(portal_write.WriteRefused) as stop:
        portal_write.create_or_update(object(), policy)
    assert "did not confirm" in str(stop.value)


def test_the_wrong_confirmation_phrase_leaves_the_run_read_only():
    policy = portal_write.WritePolicy(enabled=True, create_labels=("Save",))
    operator = Operator(["y"])
    policy = portal_write.confirm(policy, operator.ask, operator.say)
    assert not policy.confirmed
    assert not policy.armed
    assert "stays read-only" in operator.text


def test_the_exact_phrase_arms_it_and_the_consequence_was_stated():
    policy = portal_write.WritePolicy(enabled=True, create_labels=("Save",))
    operator = Operator([portal_write.CONFIRMATION_PHRASE])
    policy = portal_write.confirm(
        policy, operator.ask, operator.say,
        customer="Atlas Capital", site="The Factory", site_visit="T25-204",
    )
    assert policy.armed
    assert "changes a customer record" in operator.text
    assert "Atlas Capital" in operator.text


def test_an_armed_write_with_no_configured_label_escalates_rather_than_guessing():
    policy = portal_write.WritePolicy(enabled=True, confirmed=True)
    with pytest.raises(portal_write.WriteNotConfigured) as stop:
        portal_write.create_or_update(object(), policy)
    assert "nothing was guessed at" in str(stop.value)


def test_the_shipped_service_file_configures_no_write():
    from awe_tegg.operation import load_settings

    root = Path(__file__).resolve().parents[2]
    settings = load_settings(root / "config" / "service.yaml")
    assert not settings.write, (
        "config/service.yaml configures a TEGG write control; the shipped "
        "default must configure none"
    )
