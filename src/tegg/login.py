"""Finding the sign-in form, whatever the portal calls its fields.

The first live attempt failed on ``get_by_label("User Id")``: a single strict
accessible-label lookup, which assumes the page labels its inputs and labels
them with exactly that wording. Real sign-in pages routinely do none of that --
they use placeholders, ARIA labels, bare `name` attributes, or put the whole
form in an iframe.

So the form is located by *anchoring on the password field*, which is the one
element that is unambiguous: `input[type=password]`. Once that is found, the
frame containing it is the login form's frame, and the username field is the
text input that precedes it. Everything else is a refinement on top of that.

Two rules:

  * **Fail closed.** If the anchor is missing, or there are several plausible
    forms and no way to choose, stop and dump the page structure. Never fill a
    field that merely looked promising.
  * **Never handle credential values.** This module locates controls and
    reports structure. It reads no values, and the probe output is safe to
    save, print and attach to a bug report.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Wordings seen in the wild for the same field. Compared case-insensitively
# and ignoring spaces and punctuation.
USERNAME_WORDS = (
    "userid",
    "user",
    "username",
    "usename",
    "loginid",
    "login",
    "logon",
    "email",
    "emailaddress",
    "account",
    "accountid",
    "member",
    "memberid",
    "signin",
)
PASSWORD_WORDS = ("password", "passwd", "pwd", "pass")
SUBMIT_WORDS = (
    "login",
    "logon",
    "signin",
    "submit",
    "continue",
    "enter",
    "go",
    "next",
)

# Input types that could plausibly hold a username.
USERNAME_TYPES = ("text", "email", "tel", "")


class LoginFormError(Exception):
    """The sign-in form could not be located with confidence."""


# What a sign-in page says when it refuses, and what that actually means.
# Ordered: the first match wins, so put the specific before the generic.
ERROR_PATTERNS: tuple[tuple[str, str], ...] = (
    ("locked", "account_locked"),
    ("disabled", "account_locked"),
    ("suspended", "account_locked"),
    ("too many attempts", "account_locked"),
    ("expired", "password_expired"),
    ("must change your password", "password_expired"),
    ("verification code", "mfa_required"),
    ("authentication code", "mfa_required"),
    ("one-time", "mfa_required"),
    ("two-factor", "mfa_required"),
    ("multi-factor", "mfa_required"),
    ("captcha", "captcha_required"),
    ("recaptcha", "captcha_required"),
    ("not a robot", "captcha_required"),
    ("company code", "extra_field_required"),
    ("company id", "extra_field_required"),
    ("account code", "extra_field_required"),
    ("customer id", "extra_field_required"),
    ("select contractor", "extra_field_required"),
    ("contractor is required", "extra_field_required"),
    ("required", "extra_field_required"),
    ("invalid", "invalid_credentials"),
    ("incorrect", "invalid_credentials"),
    ("not recognised", "invalid_credentials"),
    ("not recognized", "invalid_credentials"),
    ("does not match", "invalid_credentials"),
    ("failed", "invalid_credentials"),
    ("unable to sign in", "invalid_credentials"),
)

# Where sign-in pages put their error text.
ERROR_SELECTORS = (
    "[role=alert]",
    ".alert",
    ".alert-danger",
    ".error",
    ".text-danger",
    ".invalid-feedback",
    ".validation-summary-errors",
    ".field-validation-error",
    ".toast-message",
    ".ng-invalid-message",
    "[class*=error i]",
)

# Extra credentials some portals demand beyond username and password.
EXTRA_FIELD_WORDS = (
    "companycode",
    "companyid",
    "company",
    "accountcode",
    "accountnumber",
    "customerid",
    "customercode",
    "clientid",
    "domain",
    "tenant",
    "organisation",
    "organization",
    "contractor",
    "location",
    "branch",
    "pin",
    "code",
    "token",
    "otp",
)


def classify_error(text: str) -> str:
    """Map a visible sign-in error to a cause. '' when nothing matches."""
    lowered = (text or "").lower()
    for phrase, label in ERROR_PATTERNS:
        if phrase in lowered:
            return label
    return ""


def read_errors(page_or_frame) -> list[str]:
    """Every visible error message on the page, de-duplicated.

    Styled error containers are checked first. Plenty of portals render the
    rejection as ordinary unstyled text, though, so as a fallback the visible
    text is scanned for the phrases in ERROR_PATTERNS -- otherwise a rejected
    sign-in looks identical to a form that never submitted.
    """
    found: list[str] = []
    for selector in ERROR_SELECTORS:
        try:
            locator = page_or_frame.locator(selector)
            for index in range(min(locator.count(), 8)):
                item = locator.nth(index)
                if not item.is_visible():
                    continue
                text = (item.inner_text() or "").strip()
                text = " ".join(text.split())
                if text and text not in found and len(text) < 400:
                    found.append(text)
        except Exception:
            continue
    if found:
        return found

    try:
        body = page_or_frame.inner_text("body")
    except Exception:
        return found

    # A <select>'s options are part of the page text, so a dropdown whose
    # placeholder reads "Select Contractor" would otherwise be mistaken for an
    # error telling us to select a contractor. Exclude every option's text.
    option_texts: set[str] = set()
    try:
        option_texts = {
            " ".join(str(text).split()).lower()
            for text in page_or_frame.eval_on_selector_all(
                "option", "els => els.map(e => e.textContent || '')"
            )
        }
    except Exception:
        pass

    for line in (body or "").splitlines():
        line = " ".join(line.split())
        if not line or len(line) >= 200:  # long lines are prose, not banners
            continue
        if line.lower() in option_texts:
            continue
        if classify_error(line) and line not in found:
            found.append(line)
    return found[:4]


def redact(text: str, *secrets: str) -> str:
    """Remove credential values from anything about to be saved or printed.

    The password is never handled by this module, but the username appears in
    the DOM after a failed sign-in, so it is scrubbed from every artifact.
    """
    result = str(text or "")
    for secret in secrets:
        if secret and len(secret) >= 3:
            result = result.replace(secret, "[REDACTED]")
            # Forms often echo the value HTML-escaped or URL-encoded.
            result = result.replace(secret.replace("@", "&#64;"), "[REDACTED]")
            result = result.replace(secret.replace("@", "%40"), "[REDACTED]")
    return result


def _norm(value: str) -> str:
    return "".join(c for c in str(value or "").lower() if c.isalnum())


def _matches(value: str, words: tuple[str, ...]) -> str:
    """Return the word that ``value`` matches, or ''. Longest match wins."""
    haystack = _norm(value)
    if not haystack:
        return ""
    best = ""
    for word in words:
        if word in haystack and len(word) > len(best):
            best = word
    return best


# ---------------------------------------------------------------------------
# Structure capture -- no credentials involved
# ---------------------------------------------------------------------------

_INPUT_SCRIPT = """
els => els.map(e => {
    let labelText = '';
    if (e.id) {
        const l = document.querySelector('label[for="' + CSS.escape(e.id) + '"]');
        if (l) labelText = (l.innerText || '').trim();
    }
    if (!labelText) {
        const parent = e.closest('label');
        if (parent) labelText = (parent.innerText || '').trim();
    }
    const rect = e.getBoundingClientRect();
    return {
        tag: e.tagName.toLowerCase(),
        type: (e.getAttribute('type') || '').toLowerCase(),
        id: e.id || '',
        name: e.getAttribute('name') || '',
        placeholder: e.getAttribute('placeholder') || '',
        aria_label: e.getAttribute('aria-label') || '',
        aria_labelledby: e.getAttribute('aria-labelledby') || '',
        autocomplete: e.getAttribute('autocomplete') || '',
        title: e.getAttribute('title') || '',
        label: labelText,
        visible: !!(rect.width && rect.height),
    };
})
"""

_LABEL_SCRIPT = """
els => els.map(e => ({
    text: (e.innerText || '').trim(),
    for: e.getAttribute('for') || ''
})).filter(x => x.text)
"""

_BUTTON_SCRIPT = """
els => els.map(e => ({
    tag: e.tagName.toLowerCase(),
    text: ((e.innerText || e.value || '')).trim(),
    type: (e.getAttribute('type') || '').toLowerCase(),
    id: e.id || '',
    name: e.getAttribute('name') || ''
})).filter(x => x.text)
"""


def describe_frame(frame) -> dict[str, Any]:
    """Everything about one frame's form controls. Reads no values."""
    data: dict[str, Any] = {"url": frame.url, "name": frame.name}
    try:
        data["title"] = frame.title()
    except Exception:
        data["title"] = ""
    for key, selector, script in (
        ("inputs", "input, select, textarea", _INPUT_SCRIPT),
        ("labels", "label", _LABEL_SCRIPT),
        ("buttons", "button, input[type=submit], input[type=button], [role=button]",
         _BUTTON_SCRIPT),
    ):
        try:
            data[key] = frame.eval_on_selector_all(selector, script)
        except Exception as exc:
            data[key] = {"error": str(exc)[:200]}
    try:
        data["password_inputs"] = frame.locator("input[type=password]").count()
    except Exception:
        data["password_inputs"] = 0
    return data


@dataclass
class LoginProbe:
    """What the sign-in page actually contains."""

    url: str = ""
    title: str = ""
    frames: list[dict[str, Any]] = field(default_factory=list)
    artifacts: list[str] = field(default_factory=list)
    at: str = ""

    @property
    def form_frame(self) -> dict[str, Any] | None:
        """The frame holding the password field, if exactly one has it."""
        candidates = [f for f in self.frames if f.get("password_inputs")]
        return candidates[0] if len(candidates) == 1 else None

    @property
    def location(self) -> str:
        """Where the form lives: main page, an iframe, or nowhere findable."""
        frame = self.form_frame
        if frame is None:
            if any(f.get("password_inputs") for f in self.frames):
                return "several frames contain a password field"
            return "no password field found on the page or in any frame"
        return "main page" if frame is self.frames[0] else f"iframe {frame.get('url')}"

    @property
    def label_style(self) -> str:
        """How the username field is identified, which is what broke before."""
        frame = self.form_frame
        if not frame:
            return "unknown"
        for entry in frame.get("inputs") or []:
            if entry.get("type") == "password":
                continue
            if entry.get("label"):
                return f"accessible label: {entry['label']!r}"
            if entry.get("aria_label"):
                return f"aria-label: {entry['aria_label']!r}"
            if entry.get("placeholder"):
                return f"placeholder: {entry['placeholder']!r}"
            if entry.get("name") or entry.get("id"):
                return f"name/id only: name={entry.get('name')!r} id={entry.get('id')!r}"
        return "no non-password input found"

    def describe(self) -> str:
        lines = [
            f"url            : {self.url}",
            f"title          : {self.title}",
            f"frames         : {len(self.frames)}",
            f"form location  : {self.location}",
            f"username field : {self.label_style}",
        ]
        for index, frame in enumerate(self.frames):
            tag = "main page" if index == 0 else f"iframe: {frame.get('url')}"
            lines += ["", f"--- {tag} ---"]
            if frame.get("name"):
                lines.append(f"  frame name: {frame['name']}")
            labels = frame.get("labels") or []
            lines.append(f"  labels ({len(labels)}):")
            for label in labels[:25]:
                lines.append(f"    {label.get('text')!r}  for={label.get('for')!r}")
            inputs = frame.get("inputs") or []
            lines.append(f"  inputs ({len(inputs)}):")
            for entry in inputs[:30]:
                lines.append(
                    "    type={type!r} id={id!r} name={name!r} "
                    "placeholder={placeholder!r} aria-label={aria_label!r} "
                    "autocomplete={autocomplete!r} label={label!r} "
                    "visible={visible}".format(**entry)
                )
            buttons = frame.get("buttons") or []
            lines.append(f"  buttons ({len(buttons)}):")
            for button in buttons[:25]:
                lines.append(
                    f"    {button.get('text')!r} "
                    f"type={button.get('type')!r} id={button.get('id')!r}"
                )
        if self.artifacts:
            lines += ["", "saved: " + ", ".join(self.artifacts)]
        return "\n".join(lines)


def probe(page, evidence_dir: Path | None = None) -> LoginProbe:
    """Capture the sign-in page's structure, before any credential is typed.

    Everything captured here is structural -- attribute names, labels, button
    text. No field values are read, so the output is safe to save and share.
    """
    result = LoginProbe(at=datetime.now(timezone.utc).isoformat(timespec="seconds"))
    result.url = page.url
    try:
        result.title = page.title()
    except Exception:
        pass

    result.frames.append(describe_frame(page.main_frame))
    for frame in page.frames:
        if frame is page.main_frame:
            continue
        result.frames.append(describe_frame(frame))

    if evidence_dir is None:
        return result

    directory = Path(evidence_dir)
    directory.mkdir(parents=True, exist_ok=True)
    stamp = result.at.replace(":", "").replace("-", "")

    try:
        path = directory / f"login-{stamp}.png"
        page.screenshot(path=str(path), full_page=True)
        result.artifacts.append(path.name)
    except Exception:
        pass
    try:
        path = directory / f"login-{stamp}.html"
        path.write_text(page.content(), encoding="utf-8")
        result.artifacts.append(path.name)
    except Exception:
        pass
    for index, frame in enumerate(page.frames):
        if frame is page.main_frame:
            continue
        try:
            path = directory / f"login-{stamp}-iframe{index}.html"
            path.write_text(frame.content(), encoding="utf-8")
            result.artifacts.append(path.name)
        except Exception:
            pass
    try:
        path = directory / f"login-{stamp}.json"
        path.write_text(
            json.dumps(
                {
                    "at": result.at,
                    "url": result.url,
                    "title": result.title,
                    "location": result.location,
                    "label_style": result.label_style,
                    "frames": result.frames,
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        result.artifacts.append(path.name)
    except Exception:
        pass

    return result


# ---------------------------------------------------------------------------
# Locating the controls
# ---------------------------------------------------------------------------


@dataclass
class LoginForm:
    """Located sign-in controls, and how each was found."""

    frame: Any
    username: Any
    password: Any
    submit: Any | None
    contractor: Any | None = None
    contractor_required: bool = False
    contractor_options: list[str] = field(default_factory=list)
    how: dict[str, str] = field(default_factory=dict)

    def describe(self) -> str:
        return "  ".join(f"{k}={v}" for k, v in self.how.items())

    def select_contractor(self, wanted: str) -> str:
        """Choose the contractor, matching loosely. Returns what was chosen.

        The live portal lists contractors as "TEGGPro <Name>", so a config
        value of "Lippolis" has to match "TEGGPro Lippolis". Anything that
        matches more than one option fails closed rather than picking.
        """
        if self.contractor is None:
            raise LoginFormError("no contractor control on this page")

        options = list(self.contractor_options)
        target = _norm(wanted)
        exact = [o for o in options if _norm(o) == target]
        partial = [o for o in options if target and target in _norm(o)]
        matches = exact or partial

        if not matches:
            raise LoginFormError(
                f"contractor {wanted!r} is not one of the {len(options)} options "
                f"offered. Set portal.contractor in config/workflow.yaml to one "
                f"of: {', '.join(options[:12])}"
                + (" ..." if len(options) > 12 else "")
            )
        if len(matches) > 1:
            raise LoginFormError(
                f"contractor {wanted!r} matches {len(matches)} options "
                f"({', '.join(matches)}); use the exact name."
            )

        self.contractor.select_option(label=matches[0])
        return matches[0]


def _entry_score(entry: dict[str, Any], words: tuple[str, ...]) -> tuple[int, str]:
    """How strongly one input matches a set of field wordings."""
    checks = (
        ("label", entry.get("label")),
        ("aria-label", entry.get("aria_label")),
        ("placeholder", entry.get("placeholder")),
        ("name", entry.get("name")),
        ("id", entry.get("id")),
        ("autocomplete", entry.get("autocomplete")),
        ("title", entry.get("title")),
    )
    best_len, best_how = 0, ""
    for source, value in checks:
        word = _matches(value, words)
        if len(word) > best_len:
            best_len, best_how = len(word), f"{source}={value!r}"
    return best_len, best_how


def _locate(frame, entry: dict[str, Any]):
    """A locator for one described input, by the most stable attribute it has."""
    if entry.get("id"):
        return frame.locator(f"#{_css_escape(entry['id'])}")
    if entry.get("name"):
        return frame.locator(f"[name={_quote(entry['name'])}]")
    if entry.get("placeholder"):
        return frame.get_by_placeholder(entry["placeholder"], exact=True)
    if entry.get("aria_label"):
        return frame.get_by_label(entry["aria_label"], exact=True)
    return None


def _css_escape(value: str) -> str:
    out = []
    for char in str(value):
        out.append(char if (char.isalnum() or char in "-_") else f"\\{char}")
    return "".join(out)


def _quote(value: str) -> str:
    return '"' + str(value).replace('"', '\\"') + '"'


def locate(page, hints: dict[str, str] | None = None) -> LoginForm:
    """Find the sign-in controls, or fail closed with a readable reason.

    ``hints`` may carry explicit wording from config (``username``,
    ``password``, ``submit``); those are tried first but are never required.
    """
    hints = hints or {}
    described = probe(page)

    frames = [page.main_frame] + [f for f in page.frames if f is not page.main_frame]
    with_password = [
        (frame, data)
        for frame, data in zip(frames, described.frames)
        if data.get("password_inputs")
    ]

    if not with_password:
        raise LoginFormError(
            "no password field was found on the sign-in page or in any of its "
            f"{len(frames)} frame(s). The page may not have loaded, or sign-in "
            "may happen elsewhere.\n\n" + described.describe()
        )
    if len(with_password) > 1:
        raise LoginFormError(
            f"{len(with_password)} frames contain a password field; refusing to "
            "guess which is the sign-in form.\n\n" + described.describe()
        )

    frame, data = with_password[0]
    inputs = [e for e in (data.get("inputs") or []) if e.get("tag") == "input"]

    # -- password: the anchor -------------------------------------------
    password_entries = [e for e in inputs if e.get("type") == "password"]
    if len(password_entries) != 1:
        raise LoginFormError(
            f"expected exactly one password field, found {len(password_entries)}."
            "\n\n" + described.describe()
        )
    password_entry = password_entries[0]
    password = _locate(frame, password_entry) or frame.locator("input[type=password]")

    how = {"password": _describe_entry(password_entry)}

    # -- username -------------------------------------------------------
    candidates = [
        e for e in inputs
        if e.get("type") in USERNAME_TYPES and e.get("visible", True)
    ]
    if not candidates:
        candidates = [e for e in inputs if e.get("type") in USERNAME_TYPES]

    username_entry = _choose_username(candidates, inputs, password_entry, hints)
    if username_entry is None:
        raise LoginFormError(
            "the password field was found but no username field could be "
            "identified with confidence.\n\n" + described.describe()
        )
    username = _locate(frame, username_entry)
    if username is None:
        raise LoginFormError(
            "the username field has no id, name, placeholder or aria-label to "
            "target.\n\n" + described.describe()
        )
    how["username"] = _describe_entry(username_entry)

    # -- submit ---------------------------------------------------------
    submit, submit_how = _choose_submit(frame, data, hints)
    how["submit"] = submit_how

    # -- contractor: optional control, but required by this portal -------
    contractor, contractor_required, options = _locate_contractor(frame, data)
    if contractor is not None:
        how["contractor"] = (
            f"{len(options)} option(s)"
            + (", required" if contractor_required else ", optional")
        )

    return LoginForm(
        frame=frame,
        username=username,
        password=password,
        submit=submit,
        contractor=contractor,
        contractor_required=contractor_required,
        contractor_options=options,
        how=how,
    )


def _locate_contractor(frame, data: dict[str, Any]):
    """Find a contractor picker, if the sign-in page has one.

    On the live portal this is a `<select name="contractorConnection">` marked
    `required`, so sign-in silently will not submit until it is set. It also
    carries a bogus `type="contractorConnection"` attribute, which is why it
    does not look like an ordinary select at first glance.
    """
    entries = [
        e
        for e in (data.get("inputs") or [])
        if "contractor" in _norm(e.get("name")) or "contractor" in _norm(e.get("id"))
    ]
    if not entries:
        return None, False, []

    entry = entries[0]
    if entry.get("name"):
        locator = frame.locator(f"select[name={_quote(entry['name'])}]")
    elif entry.get("id"):
        locator = frame.locator(f"select#{_css_escape(entry['id'])}")
    else:
        return None, False, []

    try:
        if not locator.count():
            return None, False, []
        # Only options that can actually be chosen. The live portal's first
        # option is a disabled "Select Contractor" placeholder, and trying to
        # select it hangs until the action times out.
        options = [
            entry["text"]
            for entry in locator.first.evaluate(
                """el => Array.from(el.options).map(o => ({
                    text: (o.textContent || '').trim(),
                    value: o.value,
                    disabled: o.disabled
                }))"""
            )
            if entry["text"] and not entry["disabled"] and entry["value"] != "none"
        ]
    except Exception:
        return None, False, []

    required = False
    try:
        required = locator.first.get_attribute("required") is not None
    except Exception:
        pass
    return locator.first, required, options


def _describe_entry(entry: dict[str, Any]) -> str:
    for key in ("label", "aria_label", "placeholder", "name", "id"):
        if entry.get(key):
            return f"{key}={entry[key]!r}"
    return f"type={entry.get('type')!r}"


def _choose_username(
    candidates: list[dict[str, Any]],
    inputs: list[dict[str, Any]],
    password_entry: dict[str, Any],
    hints: dict[str, str],
) -> dict[str, Any] | None:
    """Pick the username field, preferring evidence over position."""
    if not candidates:
        return None

    # 1. An explicit hint from config, matched against every attribute.
    hint = hints.get("username")
    if hint:
        scored = [(_entry_score(e, (_norm(hint),))[0], e) for e in candidates]
        best = max(scored, key=lambda pair: pair[0])
        if best[0]:
            return best[1]

    # 2. autocomplete is the strongest standard signal there is.
    for entry in candidates:
        if _norm(entry.get("autocomplete")) in ("username", "email"):
            return entry

    # 3. Recognised wording in any attribute.
    scored = [(_entry_score(e, USERNAME_WORDS)[0], e) for e in candidates]
    ranked = sorted(scored, key=lambda pair: pair[0], reverse=True)
    if ranked and ranked[0][0]:
        top = ranked[0][0]
        if len([s for s, _ in ranked if s == top]) == 1:
            return ranked[0][1]

    # 4. Scoped fallback: exactly one plausible field, or the one immediately
    #    before the password box. Anything less certain fails closed.
    if len(candidates) == 1:
        return candidates[0]
    try:
        position = inputs.index(password_entry)
    except ValueError:
        return None
    preceding = [e for e in inputs[:position] if e in candidates]
    if len(preceding) == 1:
        return preceding[0]
    if preceding:
        return preceding[-1]
    return None


def _choose_submit(frame, data: dict[str, Any], hints: dict[str, str]):
    """Find the sign-in button. Falls back to submitting the form itself."""
    buttons = data.get("buttons") or []

    hint = hints.get("submit")
    if hint:
        for button in buttons:
            if _norm(hint) and _norm(hint) in _norm(button.get("text")):
                return _button_locator(frame, button), f"text={button['text']!r}"

    ranked = sorted(
        ((len(_matches(b.get("text"), SUBMIT_WORDS)), b) for b in buttons),
        key=lambda pair: pair[0],
        reverse=True,
    )
    if ranked and ranked[0][0]:
        button = ranked[0][1]
        return _button_locator(frame, button), f"text={button['text']!r}"

    if len(buttons) == 1:
        return _button_locator(frame, buttons[0]), f"only button {buttons[0]['text']!r}"

    # No button: pressing Enter in the password field submits most forms.
    return None, "none found; will press Enter in the password field"


@dataclass
class LoginOutcome:
    """What happened after the sign-in form was submitted."""

    ok: bool = False
    reason: str = ""
    detail: str = ""
    url: str = ""
    title: str = ""
    errors: list[str] = field(default_factory=list)
    extra_fields: list[str] = field(default_factory=list)
    new_cookies: list[str] = field(default_factory=list)
    waited_ms: int = 0

    def describe(self) -> str:
        lines = [
            f"result       : {'SUCCESS' if self.ok else 'FAILED'}",
            f"reason       : {self.reason or '(none)'}",
            f"detail       : {self.detail or '(none)'}",
            f"url          : {self.url}",
            f"title        : {self.title}",
            f"waited       : {self.waited_ms} ms",
        ]
        if self.errors:
            lines += ["", "visible messages:"]
            lines += [f"  {message}" for message in self.errors]
        if self.extra_fields:
            lines += ["", "additional fields on the form:"]
            lines += [f"  {name}" for name in self.extra_fields]
        if self.new_cookies:
            lines += ["", f"new cookies: {', '.join(self.new_cookies)}"]
        return "\n".join(lines)


def password_visible(page) -> bool:
    """Whether a usable password box is still on screen.

    Counting elements is not enough: an Angular app routinely leaves the
    sign-in component in the DOM but hidden after a successful login.
    """
    try:
        locator = page.locator("input[type=password]")
        for index in range(min(locator.count(), 5)):
            if locator.nth(index).is_visible():
                return True
    except Exception:
        return False
    return False


def find_extra_fields(page) -> list[str]:
    """Required-looking fields beyond username and password.

    A portal that wants a company code or a contractor will simply refuse to
    submit, which looks identical to a rejected password.
    """
    names: list[str] = []
    try:
        described = describe_frame(page.main_frame)
    except Exception:
        return names
    for entry in described.get("inputs") or []:
        if entry.get("type") in ("password", "hidden", "submit", "button"):
            continue
        haystack = " ".join(
            str(entry.get(key) or "")
            for key in ("label", "aria_label", "placeholder", "name", "id")
        )
        word = _matches(haystack, EXTRA_FIELD_WORDS)
        if not word:
            continue
        if _matches(haystack, USERNAME_WORDS):
            continue
        label = _describe_entry(entry)
        if label not in names:
            names.append(label)
    return names


def fill_extra_fields(frame, spec: dict[str, str]) -> list[str]:
    """Fill additional sign-in fields declared in config.

    ``spec`` maps a field's name/id/label fragment to a value. A value of
    ``env:NAME`` is read from the environment, so a second secret never has to
    live in the config file. Returns what was filled, values excluded.
    """
    import os

    filled: list[str] = []
    for key, raw in (spec or {}).items():
        value = str(raw)
        if value.startswith("env:"):
            value = os.environ.get(value[4:], "")
            if not value:
                raise LoginFormError(
                    f"extra sign-in field {key!r} needs environment variable "
                    f"{raw[4:]}, which is not set"
                )
        locator = None
        for candidate in (
            f"[name={_quote(key)}]",
            f"#{_css_escape(key)}",
            f"[name*={_quote(key)} i]",
            f"[id*={_quote(key)} i]",
        ):
            try:
                found = frame.locator(candidate)
                if found.count():
                    locator = found.first
                    break
            except Exception:
                continue
        if locator is None:
            try:
                locator = frame.get_by_label(key, exact=False).first
                if not locator.count():
                    locator = None
            except Exception:
                locator = None
        if locator is None:
            raise LoginFormError(
                f"extra sign-in field {key!r} is configured but no such control "
                "is on the sign-in page"
            )
        try:
            tag = locator.evaluate("el => el.tagName.toLowerCase()")
        except Exception:
            tag = "input"
        if tag == "select":
            locator.select_option(label=value)
        else:
            locator.fill(value)
        filled.append(key)
    return filled


def wait_for_result(
    page,
    login_path: str = "",
    *,
    timeout_ms: int = 30000,
    poll_ms: int = 250,
    cookies_before: list[str] | None = None,
) -> LoginOutcome:
    """Wait for the sign-in to resolve, then say what happened.

    Submitting an Angular form triggers no page navigation, so
    ``wait_for_load_state`` returns immediately and a check made straight
    afterwards always sees the form still there. This polls for a real
    outcome instead: the form going away, the route changing, or an error
    message appearing.
    """
    outcome = LoginOutcome()
    before = set(cookies_before or [])
    waited = 0

    while waited <= timeout_ms:
        # Success is checked first: if the form has gone or the route changed,
        # that is decisive, and stray words on the page must not override it.
        left_login_page = bool(login_path) and login_path not in page.url
        if left_login_page or not password_visible(page):
            outcome.ok = True
            outcome.reason = (
                "left the sign-in page" if left_login_page else "sign-in form gone"
            )
            break

        errors = read_errors(page)
        if errors:
            outcome.errors = errors
            outcome.detail = errors[0]
            outcome.reason = classify_error(" ".join(errors)) or "rejected"
            break

        page.wait_for_timeout(poll_ms)
        waited += poll_ms

    outcome.waited_ms = waited
    try:
        outcome.url = page.url
        outcome.title = page.title()
    except Exception:
        pass

    if not outcome.ok and not outcome.reason:
        outcome.reason = "no_response"
        outcome.detail = (
            "the sign-in page neither navigated away nor showed an error within "
            f"{timeout_ms} ms"
        )

    if not outcome.ok:
        outcome.extra_fields = find_extra_fields(page)
        if outcome.extra_fields and outcome.reason in ("no_response", "rejected"):
            outcome.reason = "extra_field_required"

    try:
        after = {c["name"] for c in page.context.cookies()}
        outcome.new_cookies = sorted(after - before)
    except Exception:
        pass

    return outcome


def _button_locator(frame, button: dict[str, Any]):
    if button.get("id"):
        return frame.locator(f"#{_css_escape(button['id'])}")
    if button.get("name"):
        return frame.locator(f"[name={_quote(button['name'])}]")
    text = button.get("text") or ""
    if button.get("tag") == "input":
        return frame.locator(f"input[value={_quote(text)}]")
    return frame.get_by_role("button", name=text, exact=False).first
