"""Everything needed to work out why a live sign-in did not complete.

A failed login is one of several very different problems wearing the same
coat: a selector that no longer matches, a consent overlay swallowing the
click, a field the form gained, an account that is locked, or credentials that
are simply wrong. Guessing between them costs login attempts, and login
attempts are the one resource that can lock an account.

So this module captures the whole picture in a single submission: the form's
real structure before anything is typed, what the page said before and after,
the network responses, the console, a Playwright trace, and screenshots either
side. One run should be enough to decide what to change.

Redaction is structural rather than best-effort. The password is never typed
into anything that gets saved and never leaves ``portal_credentials()``; the
username is scrubbed from every artifact by clearing input values in the DOM
before any snapshot or screenshot is taken. What is reported about a
credential is its presence, never its value.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# Anything on the page that could be sitting between the driver and the form.
OVERLAY_HINTS = (
    "cookie",
    "consent",
    "accept all",
    "privacy",
    "gdpr",
    "modal",
    "dialog",
    "banner",
)

# Words a portal uses when it is refusing a person rather than failing.
REJECTION_HINTS = (
    "invalid",
    "incorrect",
    "not recognised",
    "not recognized",
    "does not match",
    "try again",
)
LOCKOUT_HINTS = ("locked", "disabled", "suspended", "too many", "contact support")
EXPIRY_HINTS = (
    "expired",
    "must be changed",
    "must change your password",
    "change your password",
    "reset your password",
    "password change",
)
MFA_HINTS = ("verification code", "authenticator", "one-time", "two-factor", "2fa", "mfa")

# Classifications, matching the operator-facing vocabulary exactly.
SELECTOR_FAILURE = "AUTOMATION_SELECTOR_FAILURE"
FLOW_CHANGED = "PORTAL_FLOW_CHANGED"
CREDENTIAL_REJECTED = "CREDENTIAL_REJECTED"
LOCKED_OR_EXPIRED = "ACCOUNT_LOCKED_OR_EXPIRED"
ADDITIONAL_AUTH = "ADDITIONAL_AUTH_REQUIRED"
NETWORK_FAILURE = "NETWORK_OR_SERVER_FAILURE"
SUCCESS = "LOGIN_SUCCESSFUL"


def _text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _any(haystack: str, needles) -> bool:
    lowered = haystack.lower()
    return any(n in lowered for n in needles)


# --- reading the page ------------------------------------------------------

# Read every control's identifying attributes. Values are deliberately not
# collected: the point is to find the right selector, and a value could be a
# credential.
FORM_JS = """
() => {
  const pick = (el) => ({
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute('type') || '',
    name: el.getAttribute('name') || '',
    id: el.id || '',
    placeholder: el.getAttribute('placeholder') || '',
    autocomplete: el.getAttribute('autocomplete') || '',
    required: el.hasAttribute('required'),
    disabled: el.disabled === true,
    visible: !!(el.offsetParent || el.getClientRects().length),
    ariaLabel: el.getAttribute('aria-label') || '',
    label: (() => {
      if (el.id) {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l) return (l.textContent || '').trim();
      }
      const w = el.closest('label');
      return w ? (w.textContent || '').trim() : '';
    })(),
  });
  return {
    inputs: Array.from(document.querySelectorAll('input, select, textarea')).map(pick),
    buttons: Array.from(document.querySelectorAll(
      'button, input[type=submit], a[role=button]'
    )).map((el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '',
      id: el.id || '',
      name: el.getAttribute('name') || '',
      text: (el.textContent || el.value || '').trim().slice(0, 80),
      disabled: el.disabled === true,
      visible: !!(el.offsetParent || el.getClientRects().length),
    })),
    labels: Array.from(document.querySelectorAll('label'))
      .map((l) => (l.textContent || '').trim()).filter(Boolean).slice(0, 40),
    forms: Array.from(document.querySelectorAll('form')).map((f) => ({
      id: f.id || '', name: f.getAttribute('name') || '',
      action: f.getAttribute('action') || '', method: f.getAttribute('method') || '',
    })),
  };
}
"""

# Anything overlaying the form. A consent banner that intercepts the submit
# click looks exactly like a broken selector from the outside.
OVERLAY_JS = """
() => {
  const out = [];
  for (const el of Array.from(document.querySelectorAll('div,section,aside,dialog'))) {
    const style = getComputedStyle(el);
    if (!['fixed', 'sticky'].includes(style.position)) continue;
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 80 || rect.height < 40) continue;
    out.push({
      text: (el.textContent || '').trim().slice(0, 160),
      zIndex: style.zIndex,
      role: el.getAttribute('role') || '',
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
    if (out.length >= 8) break;
  }
  return out;
}
"""

# Visible messages: server-side validation, field errors, alerts.
MESSAGES_JS = """
() => {
  const selectors = [
    '[role=alert]', '.alert', '.error', '.invalid-feedback', '.validation-message',
    '.help-block', '.text-danger', '.ng-invalid ~ .error', '[aria-invalid=true]',
  ];
  const seen = new Set();
  const out = [];
  for (const selector of selectors) {
    for (const el of Array.from(document.querySelectorAll(selector))) {
      const visible = !!(el.offsetParent || el.getClientRects().length);
      const text = (el.textContent || '').trim();
      if (!visible || !text || seen.has(text)) continue;
      seen.add(text);
      out.push(text.slice(0, 240));
      if (out.length >= 12) return out;
    }
  }
  return out;
}
"""

# Clear every input value in the DOM before anything is saved, so no typed
# credential can reach a screenshot or an HTML snapshot.
SCRUB_JS = """
() => {
  for (const el of Array.from(document.querySelectorAll('input, textarea'))) {
    if (el.type === 'checkbox' || el.type === 'radio') continue;
    el.value = '';
    el.setAttribute('value', '');
  }
}
"""


def read_form(page) -> dict:
    try:
        return page.evaluate(FORM_JS)
    except Exception as exc:
        return {"error": _text(exc)[:200]}


def read_overlays(page) -> list[dict]:
    try:
        found = page.evaluate(OVERLAY_JS) or []
    except Exception:
        return []
    return [o for o in found if _any(o.get("text", ""), OVERLAY_HINTS)] or found


def read_messages(page) -> list[str]:
    try:
        return [_text(m) for m in (page.evaluate(MESSAGES_JS) or []) if _text(m)]
    except Exception:
        return []


def scrub(page) -> None:
    """Blank every input value everywhere before an artifact is written."""
    for frame in page.frames:
        try:
            frame.evaluate(SCRUB_JS)
        except Exception:
            continue


def redact(text: str, secrets) -> str:
    """Remove any credential value that reached a string despite everything."""
    out = str(text or "")
    for secret in secrets:
        if secret and len(secret) >= 3:
            out = out.replace(secret, "[REDACTED]")
    return out


# --- classification --------------------------------------------------------


def classify(
    *,
    succeeded: bool,
    messages: list[str],
    form_before: dict,
    url_before: str,
    url_after: str,
    responses: list[dict],
    extra_fields: list[str] | None = None,
) -> tuple[str, str]:
    """Name the failure, and say what the evidence for that name was.

    Ordered by how much the answer costs to get wrong. Anything the portal
    said out loud is believed first, because a visible rejection means further
    attempts risk a lockout.
    """
    if succeeded:
        return SUCCESS, "sign-in completed and was corroborated"

    said = " ".join(messages)

    if _any(said, LOCKOUT_HINTS):
        return LOCKED_OR_EXPIRED, f"the portal said: {said[:200]}"
    if _any(said, EXPIRY_HINTS):
        return LOCKED_OR_EXPIRED, f"the portal said: {said[:200]}"
    if _any(said, MFA_HINTS):
        return ADDITIONAL_AUTH, f"the portal said: {said[:200]}"
    if _any(said, REJECTION_HINTS):
        return CREDENTIAL_REJECTED, f"the portal said: {said[:200]}"

    if extra_fields:
        return (
            ADDITIONAL_AUTH,
            "the form carries a field the automation did not fill: "
            + ", ".join(extra_fields[:5]),
        )

    failed = [r for r in responses if int(r.get("status", 0)) >= 500]
    if failed:
        return (
            NETWORK_FAILURE,
            f"the sign-in request returned {failed[0].get('status')}",
        )
    if responses and all(int(r.get("status", 0)) >= 400 for r in responses):
        return (
            NETWORK_FAILURE,
            f"every sign-in request failed, first was {responses[0].get('status')}",
        )

    inputs = (form_before or {}).get("inputs") or []
    has_password = any(i.get("type") == "password" for i in inputs)
    if not has_password:
        return (
            SELECTOR_FAILURE,
            "no password input was found on the page at all",
        )

    if not responses:
        # The form was found and filled, the button was clicked, and nothing
        # was sent. Something swallowed the submit.
        return (
            SELECTOR_FAILURE,
            "the submit produced no sign-in request; the click did not reach "
            "the form (an overlay, the wrong button, or a disabled control)",
        )

    if url_after != url_before:
        return (
            FLOW_CHANGED,
            f"the page moved to {url_after} but the sign-in did not complete",
        )

    return (
        FLOW_CHANGED,
        "the request was sent and accepted, but the page neither navigated nor "
        "reported an error -- the post-sign-in step has changed",
    )


# --- the report ------------------------------------------------------------


@dataclass
class Diagnosis:
    """One diagnostic submission, in full."""

    classification: str = ""
    evidence: str = ""
    url_before: str = ""
    url_after: str = ""
    title_before: str = ""
    title_after: str = ""
    succeeded: bool = False
    indicators: list[str] = field(default_factory=list)
    messages_before: list[str] = field(default_factory=list)
    messages_after: list[str] = field(default_factory=list)
    form: dict = field(default_factory=dict)
    overlays: list[dict] = field(default_factory=list)
    iframes: list[str] = field(default_factory=list)
    responses: list[dict] = field(default_factory=list)
    console: list[str] = field(default_factory=list)
    new_cookies: list[str] = field(default_factory=list)
    extra_fields: list[str] = field(default_factory=list)
    artifacts: dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "classification": self.classification,
            "evidence": self.evidence,
            "succeeded": self.succeeded,
            "indicators": list(self.indicators),
            "url_before": self.url_before,
            "url_after": self.url_after,
            "title_before": self.title_before,
            "title_after": self.title_after,
            "messages_before": list(self.messages_before),
            "messages_after": list(self.messages_after),
            "form": dict(self.form),
            "overlays": list(self.overlays),
            "iframes": list(self.iframes),
            "responses": list(self.responses),
            "console": list(self.console),
            "new_cookies": list(self.new_cookies),
            "extra_fields": list(self.extra_fields),
            "artifacts": dict(self.artifacts),
        }

    def write(self, path: Path) -> Path:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.to_dict(), indent=2) + "\n", encoding="utf-8")
        return path

    def describe(self) -> str:
        lines = [
            f"classification  {self.classification}",
            f"evidence        {self.evidence}",
            f"url before      {self.url_before}",
            f"url after       {self.url_after}",
            f"title after     {self.title_after}",
        ]
        if self.indicators:
            lines.append(f"indicators      {', '.join(self.indicators)}")
        if self.messages_after:
            lines.append("page said       " + " | ".join(self.messages_after[:4]))
        if self.overlays:
            lines.append(f"overlays        {len(self.overlays)} covering the page")
        if self.iframes:
            lines.append(f"iframes         {', '.join(self.iframes[:4])}")
        if self.responses:
            lines.append(
                "sign-in calls   "
                + ", ".join(f"{r['status']} {r['url']}" for r in self.responses[-5:])
            )
        lines.append(
            f"new cookies     {', '.join(self.new_cookies) or '(none)'}"
        )
        if self.extra_fields:
            lines.append(f"unfilled fields {', '.join(self.extra_fields)}")
        return "\n".join(lines)


def corroborate(page, login_path: str, *, cookies_before: list[str], org: str = "") -> list[str]:
    """Independent indicators that a session really exists.

    A click is not evidence. Two of these are required before a sign-in is
    called successful, so that a form which merely hides itself during a
    spinner cannot be mistaken for an authenticated session.
    """
    from . import login as login_module

    found: list[str] = []
    try:
        if login_path and login_path not in page.url:
            found.append("url_left_login_route")
    except Exception:
        pass

    try:
        if not login_module.password_visible(page):
            found.append("login_form_gone")
    except Exception:
        pass

    try:
        after = {c["name"] for c in page.context.cookies()}
        if after - set(cookies_before or []):
            found.append("session_cookie_created")
    except Exception:
        pass

    if org:
        try:
            if page.get_by_text(org, exact=False).count() > 0:
                found.append("organization_name_visible")
        except Exception:
            pass

    try:
        for label in ("Sign out", "Log out", "Logout", "My Account", "Documentation"):
            if page.get_by_text(label, exact=False).count() > 0:
                found.append("authenticated_navigation_present")
                break
    except Exception:
        pass

    return found
