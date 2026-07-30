"""Stand-in sections: they must work, and they must be unmistakable."""

from __future__ import annotations

from pypdf import PdfReader

from tegg import mockassets, preflight, validate


def test_write_produces_every_required_fixed_section(tmp_path):
    written = mockassets.write(tmp_path)
    assert len(written.created) == len(mockassets.STAND_INS)
    for name in preflight.REQUIRED_ASSETS:
        assert (tmp_path / name).is_file()


def test_the_stand_ins_satisfy_the_preflight_asset_check(tmp_path):
    mockassets.write(tmp_path)
    assert preflight.static_assets(tmp_path).status == preflight.OK


def test_every_stand_in_is_a_readable_pdf_with_the_expected_pages(tmp_path):
    mockassets.write(tmp_path)
    for name, (_title, pages) in mockassets.STAND_INS.items():
        path = tmp_path / name
        assert validate.is_pdf(path).passed
        assert len(PdfReader(str(path)).pages) == pages


def test_the_marker_is_in_the_text_layer_of_every_page(tmp_path):
    # In the text layer specifically, so a reader, a text extractor and the
    # validation pass all see it.
    mockassets.write(tmp_path)
    for name in mockassets.STAND_INS:
        text = validate.extract_text(tmp_path / name)
        assert mockassets.MARKER.lower() in text


def test_a_stand_in_says_the_report_must_not_be_sent(tmp_path):
    mockassets.write(tmp_path)
    text = validate.extract_text(tmp_path / next(iter(mockassets.STAND_INS)))
    assert "must not be sent" in text


def test_is_stand_in_recognises_what_write_produced(tmp_path):
    mockassets.write(tmp_path)
    for name in mockassets.STAND_INS:
        assert mockassets.is_stand_in(tmp_path / name)


def test_is_stand_in_says_no_to_an_ordinary_pdf(tmp_path):
    from tegg import mockportal

    path = tmp_path / "real.pdf"
    path.write_bytes(mockportal.make_pdf(mockportal.BY_KEY["eds_all_problems"]))
    assert not mockassets.is_stand_in(path)


def test_is_stand_in_says_no_to_something_that_is_not_a_pdf(tmp_path):
    path = tmp_path / "notapdf.pdf"
    path.write_bytes(b"<html>error</html>")
    assert not mockassets.is_stand_in(path)


def test_an_existing_file_is_never_silently_replaced(tmp_path):
    # The real assets live at these exact names. Overwriting them by accident
    # would destroy files that are not in version control.
    name = next(iter(mockassets.STAND_INS))
    real = tmp_path / name
    real.write_bytes(b"%PDF-1.4 pretend this is the real section")
    written = mockassets.write(tmp_path)
    assert real.read_bytes().startswith(b"%PDF-1.4 pretend")
    assert real in written.skipped
    assert real not in written.created


def test_overwrite_is_available_but_must_be_asked_for(tmp_path):
    name = next(iter(mockassets.STAND_INS))
    real = tmp_path / name
    real.write_bytes(b"%PDF-1.4 pretend this is the real section")
    mockassets.write(tmp_path, overwrite=True)
    assert mockassets.is_stand_in(real)


def test_write_creates_the_destination_if_it_is_absent(tmp_path):
    target = tmp_path / "deep" / "static"
    mockassets.write(target)
    assert target.is_dir()
    assert preflight.static_assets(target).status == preflight.OK
