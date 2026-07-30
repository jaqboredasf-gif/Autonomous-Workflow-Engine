"""A stand-in portal that follows the *site visit* route.

Unlike ``mock_portal``, which reproduces the company-level Reports flow, this
one reproduces the route that actually works on the real site:

    Documentation -> a completed site visit -> Document Library -> Certificates

It also reproduces the two things the real portal did that broke the original
assumptions: the generic Reports page says "currently no agreements", and the
certificate is served as a legacy binary ``.doc`` rather than a ``.docx``.

Run standalone to poke at it::

    python tests/mock_sitevisit.py --port 8899
"""

from __future__ import annotations

import argparse
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

from mock_portal import make_pdf

USERNAME = "PLippolis1"
PASSWORD = "test-password"

# identifier -> (customer, site, date, status)
SITE_VISITS = {
    "71999": ("Acme Manufacturing", "Plant 3 - Toledo", "05/14/2026", "Completed"),
    "72104": ("Borden Foods", "Cold Store 2", "06/02/2026", "Completed"),
    "72200": ("Cutler Steel", "Mill A", "07/01/2026", "In Progress"),
    # A record deliberately named as a test rig. This is the shape a live
    # portal needs before automation may write to anything: the classification
    # is driven by the name, because the portal has no sandbox status.
    "72900": ("ZZ-AUTOMATION TEST", "Test Rig", "07/15/2026", "Draft"),
}

# label -> (slug, download filename, pages)
REPORTS = {
    "Problem Count Summary": ("pcs", "ProblemCountSummary.pdf", 2),
    "Equipment Inventory and Short Form": (
        "eis", "EquipmentInventoryShortForm.pdf", 5,
    ),
    "Equipment Inventory and Long Form": (
        "eil", "EquipmentInventoryLongForm.pdf", 12,
    ),
    "Standard IR Report": ("sir", "StandardIRReport.pdf", 9),
    "Equipment Item Problems and Include All Images": (
        "eip", "EquipmentItemProblem_AllImages.pdf", 7,
    ),
    "EDS Component Problem Summary and All Problems": (
        "eds", "EDSAllProblemsOnly.pdf", 4,
    ),
}
SLUGS = {slug: (name, filename, pages) for name, (slug, filename, pages) in REPORTS.items()}

# A legacy OLE2 document, exactly the shape the real portal hands over.
LEGACY_DOC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 512 + b"TEGG certificate"


def _page(title: str, body: str) -> bytes:
    return f"""<!doctype html><html><head><meta charset="utf-8">
<title>{title} - TEGG Pro</title></head><body>
<nav>
  <a href="/sales/gm-dashboard">Dashboard</a>
  <a href="/documentation">Documentation</a>
  <a href="/reports">Reports</a>
  <a href="/auth/logout">Log Out</a>
</nav>
<h1>{title}</h1>
{body}
</body></html>""".encode()


class Handler(BaseHTTPRequestHandler):
    # Toggled by tests to simulate a dropped session.
    expire_session = False
    # Tests that need a genuinely convertible document override this with a
    # real LibreOffice-produced .doc.
    certificate_bytes = LEGACY_DOC

    def log_message(self, *args):  # keep the test output clean
        pass

    # -- helpers ----------------------------------------------------------
    def _send(self, body: bytes, content_type="text/html; charset=utf-8", extra=None):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _login_page(self, message=""):
        return _page(
            "Sign In",
            f"""<p>{message}</p>
<form method="post" action="/auth/login">
  <label for="userid">User Id</label><input id="userid" name="userid">
  <label for="password">Password</label>
  <input id="password" name="password" type="password">
  <input type="submit" value="Log In">
</form>""",
        )

    # -- routing ----------------------------------------------------------
    def do_GET(self):
        path = urlparse(self.path).path

        if Handler.expire_session and path != "/auth/login":
            self._send(self._login_page("Your session has expired."))
            return

        if path in ("/", "/auth/login"):
            self._send(self._login_page())
        elif path == "/sales/gm-dashboard":
            self._send(_page("Dashboard", "<p>Welcome.</p>"))
        elif path == "/reports":
            # The trap the original driver fell into.
            self._send(
                _page("Reports", "<p>There are currently no agreements to report on.</p>")
            )
        elif path in ("/sales/documentation", "/documentation"):
            # The live portal serves this at /sales/documentation, which is what
            # config/workflow.yaml points at. /documentation stays as an alias so
            # older tests that hard-code it keep working.
            self._send(_page("Documentation", self._visit_table()))
        elif path.startswith("/site-visit/") and path.endswith("/documents"):
            self._send(self._document_library(path.split("/")[2]))
        elif path.startswith("/site-visit/"):
            self._send(self._visit_page(path.split("/")[2]))
        elif path == "/download/certificate":
            self._send(
                Handler.certificate_bytes,
                "application/msword",
                {"Content-Disposition": 'attachment; filename="Certificates71999.doc"'},
            )
        elif path.startswith("/download/"):
            slug = path.rsplit("/", 1)[-1]
            if slug not in SLUGS:
                self._send(_page("Not found", "<p>No such report.</p>"))
                return
            label, filename, pages = SLUGS[slug]
            self._send(
                make_pdf(label, pages),
                "application/pdf",
                {"Content-Disposition": f'attachment; filename="{filename}"'},
            )
        else:
            self._send(_page("Not found", "<p>Nothing here.</p>"))

    def do_POST(self):
        if urlparse(self.path).path != "/auth/login":
            self._send(_page("Not found", "<p>Nothing here.</p>"))
            return
        length = int(self.headers.get("Content-Length", 0))
        form = parse_qs(self.rfile.read(length).decode())
        if (
            form.get("userid", [""])[0] == USERNAME
            and form.get("password", [""])[0] == PASSWORD
        ):
            Handler.expire_session = False
            self.send_response(302)
            self.send_header("Location", "/sales/gm-dashboard")
            self.end_headers()
            return
        self._send(self._login_page("Sign-in failed."))

    # -- pages ------------------------------------------------------------
    def _visit_table(self):
        rows = []
        for identifier, (customer, site, date, status) in SITE_VISITS.items():
            rows.append(
                f"<tr><td><a href='/site-visit/{identifier}'>{customer}</a></td>"
                f"<td>{site}</td><td>{date}</td><td>{status}</td></tr>"
            )
        return (
            "<table><tr><th>Customer</th><th>Site</th><th>Date</th>"
            "<th>Status</th></tr>" + "".join(rows) + "</table>"
        )

    def _visit_page(self, identifier):
        if identifier not in SITE_VISITS:
            return _page("Site Visit", "<p>Unknown site visit.</p>")
        customer, site, date, status = SITE_VISITS[identifier]
        return _page(
            f"Site Visit {identifier}",
            f"""<p>Customer: {customer}</p><p>Site: {site}</p>
<p>Date: {date}</p><p>Status: {status}</p>
<ul>
  <li><a href="/site-visit/{identifier}/documents">Document Library</a></li>
  <li><a href="/site-visit/{identifier}">Equipment</a></li>
</ul>""",
        )

    def _document_library(self, identifier):
        links = [
            '<li><a href="/download/certificate">Certificates</a></li>'
        ]
        for label, (slug, _, _) in REPORTS.items():
            links.append(f'<li><a href="/download/{slug}">{label}</a></li>')
        return _page(
            f"Document Library - {identifier}",
            f"<p>Site visit {identifier}</p><ul>{''.join(links)}</ul>",
        )


class MockSiteVisitPortal:
    """Context manager serving the mock portal on a free port."""

    def __init__(self, port: int = 0, certificate_bytes: bytes | None = None) -> None:
        self.certificate_bytes = certificate_bytes
        self.server = HTTPServer(("127.0.0.1", port), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        host, port = self.server.server_address[:2]
        return f"http://{host}:{port}"

    def expire(self) -> None:
        """Make every subsequent request bounce to the sign-in page."""
        Handler.expire_session = True

    def __enter__(self) -> "MockSiteVisitPortal":
        Handler.expire_session = False
        Handler.certificate_bytes = self.certificate_bytes or LEGACY_DOC
        self.thread.start()
        return self

    def __exit__(self, *exc) -> None:
        Handler.expire_session = False
        Handler.certificate_bytes = LEGACY_DOC
        self.server.shutdown()
        self.server.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8899)
    args = parser.parse_args()
    with MockSiteVisitPortal(args.port) as portal:
        print(f"serving {portal.url}")
        threading.Event().wait()
