"""Login diagnosis: the classifier, and the guarantee that nothing leaks.

The classifier decides whether a human should try again. Getting
CREDENTIAL_REJECTED wrong in the optimistic direction costs a locked account,
so every branch is pinned here.
"""

from __future__ import annotations

import pytest

from tegg import logindiag

FORM_WITH_PASSWORD = {
    "inputs": [
        {"type": "text", "name": "email"},
        {"type": "password", "name": "password"},
    ]
}
FORM_WITHOUT_PASSWORD = {"inputs": [{"type": "text", "name": "search"}]}


def _classify(**kwargs):
    base = dict(
        succeeded=False,
        messages=[],
        form_before=FORM_WITH_PASSWORD,
        url_before="https://example.test/auth/login",
        url_after="https://example.test/auth/login",
        responses=[{"status": 200, "url": "https://example.test/api/auth"}],
        extra_fields=[],
    )
    base.update(kwargs)
    return logindiag.classify(**base)


# --- what the portal says wins ---------------------------------------------


@pytest.mark.parametrize(
    "message",
    [
        "Invalid username or password",
        "The credentials you entered are incorrect",
        "User not recognised. Please try again.",
    ],
)
def test_a_visible_rejection_is_classified_as_rejected(message):
    # Must be believed, because the correct response is to stop submitting.
    verdict, evidence = _classify(messages=[message])
    assert verdict == logindiag.CREDENTIAL_REJECTED
    assert message[:20] in evidence


@pytest.mark.parametrize(
    "message",
    [
        "Your account has been locked",
        "Account disabled. Contact support.",
        "Too many failed attempts",
    ],
)
def test_a_lockout_message_outranks_a_rejection_message(message):
    verdict, _ = _classify(messages=[message])
    assert verdict == logindiag.LOCKED_OR_EXPIRED


@pytest.mark.parametrize(
    "message", ["Your password has expired", "You must change your password"]
)
def test_an_expiry_message_is_not_read_as_a_bad_password(message):
    # Retrying cannot fix an expired password, so it must not be classified as
    # a rejection that invites another attempt.
    verdict, _ = _classify(messages=[message])
    assert verdict == logindiag.LOCKED_OR_EXPIRED


@pytest.mark.parametrize(
    "message", ["Enter your verification code", "Open your authenticator app"]
)
def test_a_second_factor_prompt_is_additional_auth(message):
    verdict, _ = _classify(messages=[message])
    assert verdict == logindiag.ADDITIONAL_AUTH


def test_an_unfilled_required_field_is_additional_auth():
    verdict, evidence = _classify(extra_fields=["securityAnswer"])
    assert verdict == logindiag.ADDITIONAL_AUTH
    assert "securityAnswer" in evidence


# --- inferring when the portal says nothing ---------------------------------


def test_no_password_input_at_all_is_a_selector_failure():
    verdict, evidence = _classify(form_before=FORM_WITHOUT_PASSWORD, responses=[])
    assert verdict == logindiag.SELECTOR_FAILURE
    assert "password input" in evidence


def test_a_submit_that_sent_nothing_is_a_selector_failure():
    # The form was found and filled and the button was clicked, yet no request
    # left the browser. Something ate the click.
    verdict, evidence = _classify(responses=[])
    assert verdict == logindiag.SELECTOR_FAILURE
    assert "did not reach the form" in evidence


def test_a_server_error_is_not_blamed_on_the_credentials():
    verdict, evidence = _classify(
        responses=[{"status": 500, "url": "https://example.test/api/auth"}]
    )
    assert verdict == logindiag.NETWORK_FAILURE
    assert "500" in evidence


def test_requests_that_all_fail_are_a_network_failure():
    verdict, _ = _classify(
        responses=[{"status": 403, "url": "https://example.test/api/auth"}]
    )
    assert verdict == logindiag.NETWORK_FAILURE


def test_a_request_that_succeeded_but_went_nowhere_is_a_changed_flow():
    # The exact shape of the reported live failure: submitted, accepted, still
    # on the sign-in page, nothing said.
    verdict, evidence = _classify()
    assert verdict == logindiag.FLOW_CHANGED
    assert "post-sign-in step has changed" in evidence


def test_moving_to_a_new_url_without_completing_is_a_changed_flow():
    verdict, evidence = _classify(url_after="https://example.test/auth/interstitial")
    assert verdict == logindiag.FLOW_CHANGED
    assert "interstitial" in evidence


def test_success_is_reported_as_success():
    verdict, _ = _classify(succeeded=True)
    assert verdict == logindiag.SUCCESS


# --- redaction --------------------------------------------------------------


def test_redact_removes_a_credential_that_reached_a_string():
    secret = "not-a-real-password-4b2c"
    out = logindiag.redact(f"login failed for {secret}", ["someuser", secret])
    assert secret not in out
    assert "[REDACTED]" in out


def test_redact_ignores_values_too_short_to_be_meaningful():
    # Redacting "ab" would blank half the page and hide the evidence.
    assert logindiag.redact("a cabbage", ["ab"]) == "a cabbage"


def test_redact_handles_empty_input():
    assert logindiag.redact("", ["secret"]) == ""
    assert logindiag.redact("text", []) == "text"


# --- the report -------------------------------------------------------------


def test_a_diagnosis_serialises_and_round_trips(tmp_path):
    report = logindiag.Diagnosis(
        classification=logindiag.FLOW_CHANGED,
        evidence="nothing happened",
        url_before="https://example.test/auth/login",
        url_after="https://example.test/auth/login",
    )
    path = report.write(tmp_path / "nested" / "diagnosis.json")
    assert path.is_file()
    import json

    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["classification"] == logindiag.FLOW_CHANGED
    assert data["succeeded"] is False


def test_describe_names_the_classification_and_the_evidence():
    report = logindiag.Diagnosis(
        classification=logindiag.CREDENTIAL_REJECTED,
        evidence="the portal said: Invalid username or password",
        messages_after=["Invalid username or password"],
    )
    text = report.describe()
    assert logindiag.CREDENTIAL_REJECTED in text
    assert "Invalid username" in text


def test_the_overlay_hints_cover_the_usual_consent_wording():
    assert logindiag._any("We use cookies", logindiag.OVERLAY_HINTS)
    assert logindiag._any("Accept All", logindiag.OVERLAY_HINTS)
    assert not logindiag._any("Sign in to your account", logindiag.OVERLAY_HINTS)
