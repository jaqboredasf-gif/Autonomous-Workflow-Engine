"""Locating the sign-in form.

The regression these guard against is specific and was hit live: the portal
labels its username field "Please enter email address/username" and its button
"Sign in", so a single strict `get_by_label("User Id")` found nothing and the
run died at the first step.

`tests/fixtures/login_teggpro.html` is a sanitized capture of that real page,
so the exact structure that broke is now permanently under test -- along with
the other shapes a sign-in page can take.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

pytest.importorskip("playwright")

from tegg import login as login_module  # noqa: E402
from tegg.browser import launch  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures"
TEGGPRO = (FIXTURES / "login_teggpro.html").read_text(encoding="utf-8")

# Other shapes a sign-in page takes in the wild.
PLACEHOLDER_ONLY = """
<form>
  <input type="text" name="u" placeholder="Username">
  <input type="password" name="p" placeholder="Password">
  <button>Continue</button>
</form>
"""

ARIA_ONLY = """
<form>
  <input type="text" aria-label="Login ID">
  <input type="password" aria-label="Password">
  <input type="submit" value="Log On">
</form>
"""

NAME_ONLY = """
<form>
  <input type="text" name="txtAccountId">
  <input type="password" name="txtPwd">
  <button>Go</button>
</form>
"""

IFRAMED = """
<h1>Portal</h1>
<iframe srcdoc="
  <form>
    <label for='uid'>User ID</label><input id='uid' type='text'>
    <label for='pw'>Password</label><input id='pw' type='password'>
    <button>Sign In</button>
  </form>"></iframe>
"""

NO_PASSWORD = "<form><input type='text' name='email'><button>Next</button></form>"

TWO_FORMS = """
<form><input type="text" name="email"><input type="password" name="p1"><button>In</button></form>
<iframe srcdoc="<form><input type='text' name='u'><input type='password' name='p2'></form>"></iframe>
"""


@pytest.fixture(scope="module")
def browser():
    from playwright.sync_api import sync_playwright

    with sync_playwright() as playwright:
        instance = launch(playwright, headless=True)
        yield instance
        instance.close()


@pytest.fixture
def page(browser):
    context = browser.new_context()
    page = context.new_page()
    yield page
    context.close()


def _load(page, html: str):
    page.set_content(html)
    if "iframe" in html:
        page.wait_for_timeout(150)
    return page


class TestTheRealPortalPage:
    """The exact structure that broke the first live run."""

    @pytest.fixture
    def loaded(self, page):
        return _load(page, TEGGPRO)

    def test_the_old_strict_lookup_would_still_fail(self, loaded):
        """Documents the original bug: that label does not exist."""
        assert loaded.get_by_label("User Id").count() == 0

    def test_the_visible_label_is_not_associated_with_the_input(self, loaded):
        """'User Name' is a bare label -- targeting it finds nothing either."""
        assert loaded.get_by_label("User Name", exact=True).count() == 0

    def test_the_form_is_located_anyway(self, loaded):
        form = login_module.locate(loaded)
        assert form.username is not None
        assert form.password is not None
        assert form.submit is not None

    def test_the_username_field_is_the_email_input(self, loaded):
        form = login_module.locate(loaded)
        form.username.fill("someone@example.invalid")
        assert loaded.locator("input[name=email]").input_value() == (
            "someone@example.invalid"
        )

    def test_the_password_field_is_the_password_input(self, loaded):
        form = login_module.locate(loaded)
        form.password.fill("x")
        assert loaded.locator("input[name=password]").input_value() == "x"

    def test_the_submit_button_is_sign_in(self, loaded):
        form = login_module.locate(loaded)
        assert "sign in" in form.submit.inner_text().strip().lower()

    def test_config_hints_do_not_break_it(self, loaded):
        """The hints in config/workflow.yaml must not mislocate anything."""
        form = login_module.locate(
            loaded,
            {"username": "email", "password": "password", "submit": "Sign in"},
        )
        form.username.fill("a@b.invalid")
        assert loaded.locator("input[name=email]").input_value() == "a@b.invalid"


class TestContractor:
    @pytest.fixture
    def form(self, page):
        return login_module.locate(_load(page, TEGGPRO))

    def test_the_contractor_select_is_found(self, form):
        assert form.contractor is not None

    def test_it_is_recognised_as_required(self, form):
        """This is why sign-in would silently refuse to submit."""
        assert form.contractor_required is True

    def test_the_options_are_read(self, form):
        assert "TEGGPro Lippolis" in form.contractor_options

    def test_a_short_name_matches_the_teggpro_prefixed_option(self, form, page):
        assert form.select_contractor("Lippolis") == "TEGGPro Lippolis"
        assert (
            page.locator("select[name=contractorConnection]").input_value()
            == "TEGGProLippolis595"
        )

    def test_an_exact_name_also_works(self, form):
        assert form.select_contractor("TEGGPro Lippolis") == "TEGGPro Lippolis"

    def test_an_unknown_contractor_fails_closed_and_lists_the_options(self, form):
        with pytest.raises(login_module.LoginFormError) as caught:
            form.select_contractor("Nonexistent Electric")
        assert "TEGGPro Lippolis" in str(caught.value)

    def test_an_ambiguous_contractor_fails_closed(self, form):
        """'TEGGPro' matches every option, so it must not pick one."""
        with pytest.raises(login_module.LoginFormError, match="matches"):
            form.select_contractor("TEGGPro")

    def test_the_placeholder_option_is_never_chosen(self, form):
        with pytest.raises(login_module.LoginFormError):
            form.select_contractor("Select Contractor")


class TestOtherFormShapes:
    def test_placeholder_only(self, page):
        form = login_module.locate(_load(page, PLACEHOLDER_ONLY))
        form.username.fill("u")
        assert page.locator("input[name=u]").input_value() == "u"
        assert form.submit is not None

    def test_aria_label_only(self, page):
        form = login_module.locate(_load(page, ARIA_ONLY))
        form.username.fill("u")
        assert page.locator("input[aria-label='Login ID']").input_value() == "u"

    def test_name_attribute_only(self, page):
        form = login_module.locate(_load(page, NAME_ONLY))
        form.username.fill("u")
        assert page.locator("input[name=txtAccountId]").input_value() == "u"

    def test_form_inside_an_iframe(self, page):
        form = login_module.locate(_load(page, IFRAMED))
        form.username.fill("u")
        assert page.frames[1].locator("#uid").input_value() == "u"

    def test_no_contractor_control_is_fine(self, page):
        form = login_module.locate(_load(page, PLACEHOLDER_ONLY))
        assert form.contractor is None
        assert form.contractor_required is False


class TestFailClosed:
    def test_a_page_with_no_password_field_is_refused(self, page):
        with pytest.raises(login_module.LoginFormError, match="no password field"):
            login_module.locate(_load(page, NO_PASSWORD))

    def test_the_error_includes_the_page_structure(self, page):
        with pytest.raises(login_module.LoginFormError) as caught:
            login_module.locate(_load(page, NO_PASSWORD))
        message = str(caught.value)
        assert "inputs" in message and "buttons" in message

    def test_two_frames_with_password_fields_are_refused(self, page):
        with pytest.raises(login_module.LoginFormError, match="frames contain"):
            login_module.locate(_load(page, TWO_FORMS))


# An Angular-style sign-in: the click resolves client-side after a delay and
# no navigation ever happens. This is what produced "still on the sign-in page
# after submitting" against the live portal.
SPA_SUCCESS = """
<div id="app">
  <form>
    <input type="text" name="email"><input type="password" name="password">
    <button type="button" id="go">Sign in</button>
  </form>
</div>
<script>
document.getElementById('go').addEventListener('click', () => {
  setTimeout(() => {
    document.getElementById('app').innerHTML = '<h1>Dashboard</h1>';
  }, 600);
});
</script>
"""

SPA_REJECTED = """
<div id="app">
  <form>
    <input type="text" name="email"><input type="password" name="password">
    <button type="button" id="go">Sign in</button>
  </form>
  <div id="msg"></div>
</div>
<script>
document.getElementById('go').addEventListener('click', () => {
  setTimeout(() => {
    document.getElementById('msg').innerHTML =
      '<div class="alert alert-danger">Invalid username or password.</div>';
  }, 300);
});
</script>
"""

SPA_SILENT = """
<form>
  <input type="text" name="email"><input type="password" name="password">
  <button type="button">Sign in</button>
</form>
"""

EXTRA_FIELD_FORM = """
<form>
  <label for="co">Company Code</label><input id="co" name="companyCode" type="text">
  <input type="text" name="email"><input type="password" name="password">
  <button>Sign in</button>
</form>
"""


class TestPostSubmitDetection:
    """The bug: checking for the form straight after clicking always sees it."""

    def test_a_delayed_client_side_login_is_detected_as_success(self, page):
        loaded = _load(page, SPA_SUCCESS)
        loaded.click("#go")
        # The old check ran here and always failed.
        assert login_module.password_visible(loaded) is True

        outcome = login_module.wait_for_result(loaded, "", timeout_ms=5000)
        assert outcome.ok is True
        assert outcome.waited_ms > 0, "returned instantly instead of waiting"
        assert outcome.reason == "sign-in form gone"

    def test_a_rejected_login_reports_the_portal_message(self, page):
        loaded = _load(page, SPA_REJECTED)
        loaded.click("#go")
        outcome = login_module.wait_for_result(loaded, "", timeout_ms=5000)
        assert outcome.ok is False
        assert outcome.reason == "invalid_credentials"
        assert "Invalid username or password." in outcome.detail

    def test_a_form_that_does_nothing_reports_no_response(self, page):
        loaded = _load(page, SPA_SILENT)
        outcome = login_module.wait_for_result(loaded, "", timeout_ms=800)
        assert outcome.ok is False
        assert outcome.reason == "no_response"

    def test_a_hidden_password_box_still_counts_as_gone(self, page):
        loaded = _load(page, SPA_SILENT)
        loaded.eval_on_selector("form", "el => el.style.display = 'none'")
        assert login_module.password_visible(loaded) is False
        assert login_module.wait_for_result(loaded, "", timeout_ms=1000).ok is True

    def test_leaving_the_login_url_counts_as_success(self, page):
        loaded = _load(page, SPA_SILENT)
        # page.url is about:blank, which does not contain the login path.
        outcome = login_module.wait_for_result(loaded, "/auth/login", timeout_ms=1000)
        assert outcome.ok is True
        assert outcome.reason == "left the sign-in page"


class TestErrorClassification:
    @pytest.mark.parametrize(
        "message,expected",
        [
            ("Invalid username or password", "invalid_credentials"),
            ("The credentials you entered are incorrect", "invalid_credentials"),
            ("Your account has been locked", "account_locked"),
            ("Account disabled. Contact your administrator.", "account_locked"),
            ("Too many attempts, please wait", "account_locked"),
            ("Your password has expired", "password_expired"),
            ("Enter the verification code we sent you", "mfa_required"),
            ("Two-factor authentication required", "mfa_required"),
            ("Please complete the CAPTCHA", "captcha_required"),
            ("Company code is required", "extra_field_required"),
            ("Please select contractor", "extra_field_required"),
            ("Everything is fine", ""),
        ],
    )
    def test_messages_map_to_causes(self, message, expected):
        assert login_module.classify_error(message) == expected

    def test_reads_visible_messages_only(self, page):
        loaded = _load(
            page,
            "<div class='alert'>Visible problem</div>"
            "<div class='alert' style='display:none'>Hidden problem</div>",
        )
        messages = login_module.read_errors(loaded)
        assert "Visible problem" in messages
        assert "Hidden problem" not in messages


class TestExtraFields:
    def test_detects_an_additional_required_field(self, page):
        found = login_module.find_extra_fields(_load(page, EXTRA_FIELD_FORM))
        assert any("ompany" in name or "companyCode" in name for name in found)

    def test_does_not_flag_the_username_field(self, page):
        assert login_module.find_extra_fields(_load(page, PLACEHOLDER_ONLY)) == []

    def test_fills_a_configured_extra_field(self, page):
        loaded = _load(page, EXTRA_FIELD_FORM)
        filled = login_module.fill_extra_fields(
            loaded.main_frame, {"companyCode": "ACME-1"}
        )
        assert filled == ["companyCode"]
        assert loaded.locator("#co").input_value() == "ACME-1"

    def test_reads_a_value_from_the_environment(self, page, monkeypatch):
        monkeypatch.setenv("TEGG_COMPANY_CODE", "FROM-ENV")
        loaded = _load(page, EXTRA_FIELD_FORM)
        login_module.fill_extra_fields(
            loaded.main_frame, {"companyCode": "env:TEGG_COMPANY_CODE"}
        )
        assert loaded.locator("#co").input_value() == "FROM-ENV"

    def test_a_missing_environment_variable_is_a_clear_error(self, page):
        loaded = _load(page, EXTRA_FIELD_FORM)
        with pytest.raises(login_module.LoginFormError, match="not set"):
            login_module.fill_extra_fields(
                loaded.main_frame, {"companyCode": "env:DEFINITELY_NOT_SET_12345"}
            )

    def test_a_configured_field_that_does_not_exist_fails_closed(self, page):
        loaded = _load(page, PLACEHOLDER_ONLY)
        with pytest.raises(login_module.LoginFormError, match="no such control"):
            login_module.fill_extra_fields(loaded.main_frame, {"companyCode": "X"})


class TestRedaction:
    def test_removes_the_username(self):
        assert "user@example.invalid" not in login_module.redact(
            "logged in as user@example.invalid", "user@example.invalid"
        )

    def test_removes_html_and_url_encoded_forms(self):
        cleaned = login_module.redact(
            "a=user&#64;example.invalid b=user%40example.invalid",
            "user@example.invalid",
        )
        assert "example.invalid" not in cleaned

    def test_ignores_very_short_values(self):
        """Redacting a 2-character value would mangle the whole document."""
        assert login_module.redact("a book about ab", "ab") == "a book about ab"


class TestProbe:
    def test_reports_the_form_is_on_the_main_page(self, page):
        probe = login_module.probe(_load(page, TEGGPRO))
        assert probe.location == "main page"

    def test_reports_the_real_accessible_label(self, page):
        probe = login_module.probe(_load(page, TEGGPRO))
        assert "Please enter email address/username" in probe.label_style

    def test_detects_an_iframed_form(self, page):
        probe = login_module.probe(_load(page, IFRAMED))
        assert probe.location.startswith("iframe")

    def test_detects_when_there_is_no_form_at_all(self, page):
        probe = login_module.probe(_load(page, NO_PASSWORD))
        assert "no password field" in probe.location

    def test_describe_lists_inputs_and_buttons(self, page):
        described = login_module.probe(_load(page, TEGGPRO)).describe()
        assert "name='email'" in described
        assert "'Sign in'" in described

    def test_saves_evidence_without_any_field_values(self, page, tmp_path):
        """The probe types nothing, so its artifacts cannot leak a credential."""
        loaded = _load(page, TEGGPRO)
        loaded.locator("input[name=email]").fill("secret-user@example.invalid")
        loaded.locator("input[name=password]").fill("hunter2-secret")

        probe = login_module.probe(loaded, tmp_path)
        assert probe.artifacts
        for path in tmp_path.rglob("*"):
            if path.is_file() and path.suffix in (".json", ".html"):
                body = path.read_bytes()
                assert b"hunter2-secret" not in body
                assert b"secret-user@example.invalid" not in body
