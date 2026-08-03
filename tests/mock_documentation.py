"""A stand-in portal that behaves the way the live one actually behaved.

``mock_sitevisit`` reproduces the site-visit *route*. This one reproduces the
three properties that made the live Documentation navigation fail, because
those are what the repair has to be tested against:

  * **The area renders late.** A hard navigation returns an app shell with an
    empty body, and the content appears some hundreds of milliseconds later.
    A run that judges the page at ``domcontentloaded`` sees nothing -- which is
    indistinguishable from a route that has been deleted unless it waits.
  * **The navigation link carries no text.** The live sidebar renders an icon
    plus a nested span, so ``get_by_role("link", name="Documentation")`` on a
    blank page finds nothing and the "fall back to the labelled link" path is
    no help at all.
  * **It can move.** Set ``Handler.documentation_path`` and the old route
    starts answering "Nothing here" while the sidebar points somewhere new,
    which is the case bounded discovery exists for.

Every POST that is not the sign-in is recorded in ``Handler.mutations`` and
answered 405. A test asserting that list is empty is the strongest available
proof that a read-only run really was read-only: it checks the portal's side of
the conversation, not the client's intentions.
"""

from __future__ import annotations

import argparse
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

USERNAME = "portal-user"
PASSWORD = "test-password"
WORKSPACE = "Lippolis Electric, Inc."

DEFAULT_DOCUMENTATION_PATH = "/sales/documentation"
DASHBOARD_PATH = "/sales/gm-dashboard"

# identifier -> (customer, site, agreement, lead tech, start, end, status)
SITE_VISITS = (
    ("T26-174", "Red Apple Group", "180 Myrtle Ave", "STD53276001SM-05/21-02",
     "Colin Reid", "7/01/2026", "7/14/2026", "Completed"),
    ("T26-177", "Red Apple Group", "The Giovanni", "STD19167620SM-07/26-01",
     "Kavishwar Dhanraj", "7/30/2026", "10/31/2026", "Assigned"),
    ("T26-173", "Atlas-Capital", "The Factory", "STD88117209SM-05/25-02",
     "Colin Reid", "7/16/2026", "9/30/2026", "Incomplete"),
    ("T26-180", "Crestron Electronics", "22 Link Drive", "STD63802470NH-06/26-01",
     "Colin Reid", "6/02/2026", "6/20/2026", "Completed"),
    ("T26-181", "Borden Foods", "Cold Store 2", "STD41120033GM-04/26-01",
     "N/A", "5/03/2026", "5/19/2026", "Closed"),
)

#: How many of the rows above a marker-verified listing should classify as
#: completed. Kept beside the data so a test cannot drift from it.
COMPLETED_COUNT = sum(1 for row in SITE_VISITS if row[-1].lower() in
                      {"completed", "complete", "closed", "finished"})


def _shell(title: str, body: str, *, deferred: str = "", delay_ms: int = 0) -> bytes:
    """An app shell. ``deferred`` is injected into the body after ``delay_ms``.

    This is the whole point of the mock: before the timer fires, ``body`` is
    the only thing on the page, and a Documentation route's ``body`` is empty.
    """
    script = ""
    if deferred:
        payload = deferred.replace("\\", "\\\\").replace("`", "\\`")
        script = f"""<script>
          setTimeout(function () {{
            document.getElementById('outlet').innerHTML = `{payload}`;
          }}, {delay_ms});
        </script>"""
    return f"""<!doctype html><html><head><meta charset="utf-8">
<title>{title}</title></head><body>
<div id="outlet">{body}</div>
{script}
</body></html>""".encode()


def _sidebar(documentation_path: str, *, hide_documentation: bool = False) -> str:
    """The portal's own navigation -- icon links with no visible text.

    The Documentation entry is exactly the shape the live portal serves: an
    ``<i>`` icon, a nested span, no accessible name on the anchor itself.
    """
    documentation = "" if hide_documentation else (
        f'<a href="{documentation_path}" routerLink="{documentation_path}/">'
        '<i class="fas fa-file-signature" aria-hidden="true"></i>'
        '<span class="menu-item-parent">Documentation</span></a>'
    )
    return (
        '<nav>'
        f'<a href="{DASHBOARD_PATH}"><i class="fas fa-home"></i></a>'
        '<a href="/sales/business"><i class="fas fa-briefcase"></i></a>'
        f'{documentation}'
        '<a href="/sales/sales-builder"><i class="fas fa-tools"></i></a>'
        '<a href="/auth/login">Sign Out</a>'
        '</nav>'
    )


def _documentation_body() -> str:
    rows = "".join(
        f"<tr><td>{customer}</td><td>{site}</td><td>{agreement}</td>"
        f"<td>{identifier}</td><td>{tech}</td><td>{start}</td><td>{end}</td>"
        f"<td>{status}</td></tr>"
        for identifier, customer, site, agreement, tech, start, end, status
        in SITE_VISITS
    )
    return (
        "<h1>Documentation / Documentation Library</h1>"
        "<ul><li>Document Library</li><li>Reports</li><li>Site Visits</li>"
        "<li>Site Forms</li><li>Attach Images</li></ul>"
        "<label for='timeframe'>Choose timeframe</label>"
        "<select id='timeframe' name='timeframe'>"
        "<option>Recent</option><option>Past 30 days</option>"
        "<option>All Site Visits</option></select>"
        "<table><thead><tr>"
        "<th>Customer</th><th>Site Name</th><th>Agreement</th><th>Job Num</th>"
        "<th>Lead Tech</th><th>Start Date</th><th>End Date</th><th>Status</th>"
        f"</tr></thead><tbody>{rows}</tbody></table>"
    )


class Handler(BaseHTTPRequestHandler):
    #: Where the Documentation area currently lives. Move it to test discovery.
    documentation_path = DEFAULT_DOCUMENTATION_PATH
    #: How long the area takes to render after a hard navigation.
    render_delay_ms = 1200
    #: Drop the area out of the navigation entirely, to test escalation.
    hide_documentation = False
    #: Every non-login POST/PUT/DELETE that reached the portal. Must stay empty.
    mutations: list[str] = []
    #: Every path that was fetched, so a test can prove a route was not retried.
    fetched: list[str] = []

    def log_message(self, *args):                           # keep tests quiet
        pass

    # -- helpers ----------------------------------------------------------
    def _send(self, body: bytes, status: int = 200,
              content_type: str = "text/html; charset=utf-8"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _login_page(self, message: str = "") -> bytes:
        return _shell(
            "TEGGPro 2.0",
            f"""<p>{message}</p>
<form method="post" action="/auth/login">
  <label for="email">Please enter email address/username</label>
  <input id="email" name="email">
  <label for="password">Enter your password</label>
  <input id="password" name="password" type="password">
  <button type="submit">Sign in</button>
</form>""",
        )

    # -- routing ----------------------------------------------------------
    def do_GET(self):
        path = urlparse(self.path).path
        Handler.fetched.append(path)

        if path in ("/", "/auth/login"):
            self._send(self._login_page())
        elif path == DASHBOARD_PATH:
            self._send(_shell(
                "TEGGPro 2.0",
                _sidebar(Handler.documentation_path,
                         hide_documentation=Handler.hide_documentation)
                + f"<h1>Sales Overview</h1><p>Contractor: {WORKSPACE}</p>",
            ))
        elif path.rstrip("/") == Handler.documentation_path.rstrip("/"):
            # The shell arrives empty and fills in later, exactly like the
            # Angular route this mock exists to reproduce.
            self._send(_shell(
                "TEGGPro 2.0",
                "",
                deferred=_sidebar(Handler.documentation_path)
                + _documentation_body(),
                delay_ms=Handler.render_delay_ms,
            ))
        elif path == "/sales/business":
            self._send(_shell("TEGGPro 2.0", "<h1>Business</h1><p>Proposals.</p>"))
        elif path == "/sales/sales-builder":
            self._send(_shell("TEGGPro 2.0", "<h1>Sales Builder</h1>"))
        else:
            self._send(_shell("TEGGPro 2.0", "<h1>Not found</h1><p>Nothing here.</p>"),
                       status=404)

    def do_POST(self):
        if urlparse(self.path).path == "/auth/login":
            length = int(self.headers.get("Content-Length", 0))
            form = parse_qs(self.rfile.read(length).decode())
            if (form.get("email", [""])[0] == USERNAME
                    and form.get("password", [""])[0] == PASSWORD):
                self.send_response(302)
                self.send_header("Location", DASHBOARD_PATH)
                self.end_headers()
                return
            self._send(self._login_page("Sign-in failed."))
            return
        Handler.mutations.append(f"POST {self.path}")
        self._send(b"method not allowed", status=405, content_type="text/plain")

    def do_PUT(self):
        Handler.mutations.append(f"PUT {self.path}")
        self._send(b"method not allowed", status=405, content_type="text/plain")

    def do_DELETE(self):
        Handler.mutations.append(f"DELETE {self.path}")
        self._send(b"method not allowed", status=405, content_type="text/plain")


class MockDocumentationPortal:
    """Context manager serving the mock portal on a free port."""

    def __init__(self, port: int = 0, *, render_delay_ms: int = 1200) -> None:
        self.render_delay_ms = render_delay_ms
        self.server = HTTPServer(("127.0.0.1", port), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        host, port = self.server.server_address[:2]
        return f"http://{host}:{port}"

    @property
    def documentation_url(self) -> str:
        return self.url + Handler.documentation_path

    # -- knobs ------------------------------------------------------------
    def move_documentation(self, path: str) -> None:
        """Relocate the area, as a portal release would."""
        Handler.documentation_path = path

    def hide_documentation(self) -> None:
        """Take the area out of the navigation entirely."""
        Handler.hide_documentation = True

    @property
    def mutations(self) -> list[str]:
        return list(Handler.mutations)

    @property
    def fetched(self) -> list[str]:
        return list(Handler.fetched)

    def forget_traffic(self) -> None:
        Handler.fetched.clear()
        Handler.mutations.clear()

    # -- lifecycle --------------------------------------------------------
    def _reset(self) -> None:
        Handler.documentation_path = DEFAULT_DOCUMENTATION_PATH
        Handler.render_delay_ms = self.render_delay_ms
        Handler.hide_documentation = False
        Handler.mutations = []
        Handler.fetched = []

    def __enter__(self) -> "MockDocumentationPortal":
        self._reset()
        self.thread.start()
        return self

    def __exit__(self, *exc) -> None:
        self._reset()
        self.server.shutdown()
        self.server.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8898)
    parser.add_argument("--delay", type=int, default=1200)
    args = parser.parse_args()
    with MockDocumentationPortal(args.port, render_delay_ms=args.delay) as portal:
        print(f"serving {portal.url} (documentation renders after {args.delay} ms)")
        threading.Event().wait()
