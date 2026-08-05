"""A stand-in for the portal's report route, faithful to the awkward parts.

``documents.ReportRun`` was written against a live portal whose report flow is
unusual in four ways that each broke an earlier assumption. A mock that only
served PDFs would pass whatever the driver did, so this one reproduces the
mechanics that actually matter:

  * **The site search is an ngx-bootstrap typeahead.** It renders results into
    a ``<typeahead-container>`` only in response to real keystrokes -- a
    ``fill()`` sets the value and fires nothing. Results are grouped Customers
    then Sites, and the *site* entry is the one that carries agreements, so a
    driver that takes the first match lands on the customer and silently
    renders empty reports.
  * **Some reports are a parent that only expands.** "Equipment Inventory" is
    not a report; "Short Form" underneath it is.
  * **Print Report opens a new tab**, several seconds later, and the SSRS
    toolbar in it is not usable immediately.
  * **The PDF arrives as an inline response**, not a download event and not a
    navigation.

It also reproduces the failure that produced the empty-looking report in the
first place: a site whose agreement list says "There are currently no
agreements..." still renders and still exports, just with nothing in it.

Every request the server sees is recorded, so a test can assert what the driver
did rather than only what it got back.
"""

from __future__ import annotations

import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

from mock_portal import make_pdf

#: label -> (report id, page count). Leaf reports.
#:
#: The decoys matter. The live Standard ESA Reports list offers *four* other
#: reports whose name ends in "Summary" -- Inventory, Visual Inspection,
#: Tasking Completion -- and they are here so that a route which matched on
#: the word "Summary" would fetch the wrong document and fail a test, rather
#: than passing against a mock that only offered the right answer.
REPORTS: dict[str, tuple[str, int]] = {
    "Standard IR Report": ("sir", 9),
    "Problem Count Summary": ("pcs", 3),
    "Inventory Summary": ("decoy-inv", 2),
    "Visual Inspection Summary": ("decoy-vis", 2),
    "Tasking Completion Summary": ("decoy-task", 2),
}

#: parent label -> {child label: (report id, pages)}
NESTED: dict[str, dict[str, tuple[str, int]]] = {
    "Equipment Item Problems": {
        "Exclude All Images": ("eip", 7),
        "Include All Images": ("eipi", 22),
    },
    "Equipment Inventory": {
        # Two genuinely different documents, not two names for one. Different
        # ids, different page counts, so a run that fetched one twice and
        # filed it as both is detectable.
        "Short Form": ("eis", 5),
        "Long Form": ("eil", 12),
    },
    "EDS Component Problem Summary": {
        "All Problems": ("eds", 4),
        "Corrected Problems Only": ("edsc", 1),
        "Uncorrected Problems Only": ("edsu", 3),
    },
}

#: The Document Library route. Different tab, different parameter, different
#: action, and the file comes back as a legacy .doc rather than a PDF.
CERTIFICATE_SOLUTIONS = ("STD88117209SM-05/25-01", "DES01258249SM-01/25-01")

AGREEMENT = "STD88117209SM-05/25-01"
CUSTOMER = "Atlas Capital"
SITE = "The Factory"

_STYLE = "<style>body{font-family:sans-serif}a{display:block;margin:4px}</style>"


class Handler(BaseHTTPRequestHandler):
    #: Every path requested, for assertions about what the driver touched.
    seen: list[str] = []
    #: Anything that would change a record. Must stay empty.
    mutations: list[str] = []
    #: Reports whose parameter form should claim no agreements exist.
    barren_sites: set[str] = set()
    #: Report ids that should fail to export, to exercise a short package.
    refuse: set[str] = set()

    def log_message(self, *args) -> None:      # noqa: D102 - quiet in tests
        pass

    # -- helpers ----------------------------------------------------------
    def _send(self, body: bytes, content_type: str = "text/html") -> None:
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _html(self, body: str) -> None:
        self._send(f"<html><head>{_STYLE}</head><body>{body}</body></html>".encode())

    # -- routing ----------------------------------------------------------
    def do_GET(self) -> None:                                  # noqa: N802
        parsed = urlparse(self.path)
        path, query = parsed.path, parse_qs(parsed.query)
        Handler.seen.append(path)

        if path == "/sales/documentation":
            return self._documentation()
        if path == "/typeahead":
            return self._typeahead(query.get("q", [""])[0])
        if path == "/site":
            return self._site_selected(query.get("name", [""])[0])
        if path == "/reports":
            return self._report_list()
        if path == "/library":
            return self._document_library()
        if path == "/certificates":
            return self._certificates()
        if path == "/certificate-file":
            return self._certificate_file()
        if path == "/report":
            return self._report_form(query.get("id", [""])[0],
                                     query.get("label", [""])[0])
        if path == "/viewer":
            return self._viewer(query.get("id", [""])[0])
        if path == "/export":
            return self._export(query.get("id", [""])[0])
        return self._html("<h1>not found</h1>")

    def do_POST(self) -> None:                                 # noqa: N802
        # Nothing in this flow may post. Recorded so a test can prove it.
        Handler.mutations.append(self.path)
        self._html("<p>this mock refuses posts</p>")

    # -- screens ----------------------------------------------------------
    def _documentation(self) -> None:
        """The search box. Only real keystrokes fill the typeahead."""
        # Not an f-string: the script below is full of braces and there is
        # nothing to interpolate.
        self._html("""
          <h1>Documentation</h1>
          <input id="search" placeholder="Enter customer or site name"
                 autocomplete="off">
          <typeahead-container id="results"></typeahead-container>
          <script>
            const box = document.getElementById('search');
            // 'input' fires on real typing. Playwright's fill() sets .value
            // and fires 'input' too, so the realism that matters here is that
            // results arrive asynchronously and are grouped.
            box.addEventListener('input', async () => {
              const q = box.value;
              if (!q) { document.getElementById('results').innerHTML = ''; return; }
              const r = await fetch('/typeahead?q=' + encodeURIComponent(q));
              document.getElementById('results').innerHTML = await r.text();
            });
          </script>
        """)

    def _typeahead(self, query: str) -> None:
        """Customers first, then Sites. The site entry is the one that works."""
        if not query:
            return self._send(b"", "text/html")
        rows = [
            '<div class="dropdown-header">Customers</div>',
            f'<a class="dropdown-item" href="/site?name=customer">{CUSTOMER}</a>',
            '<div class="dropdown-header">Sites</div>',
            f'<a class="dropdown-item" href="/site?name=site">{SITE}</a>',
        ]
        self._send("".join(rows).encode(), "text/html")

    def _site_selected(self, which: str) -> None:
        barren = " (no agreements)" if which == "customer" else ""
        if which == "customer":
            Handler.barren_sites.add("current")
        else:
            Handler.barren_sites.discard("current")
        self._html(f"""
          <h1>{SITE}{barren}</h1>
          <a href="/reports">Reports</a>
          <a href="/library">Document Library</a>
        """)

    # -- the Document Library route ---------------------------------------
    def _document_library(self) -> None:
        """A different tab from Reports, with its own sections."""
        self._html("""
          <h1>Document Library</h1>
          <a href="/library">Document Library</a>
          <a href="/reports">Reports</a>
          <a href="/certificates">Certificates</a>
          <a href="/library">Agreements</a>
          <a href="/library">Proof of Guarantee</a>
        """)

    def _certificates(self) -> None:
        """Solution -- not Agreement -- then Print/Generate Document."""
        options = "".join(f"<option>{s}</option>" for s in CERTIFICATE_SOLUTIONS)
        self._html(f"""
          <h1>Certificates</h1>
          <a href="/library">Document Library</a>
          <a href="/reports">Reports</a>
          <a href="/certificates">Certificates</a>
          <label>Solution</label>
          <select id="solution">{options}</select>
          <a href="/certificate-file">Print/Generate Document</a>
        """)

    def _certificate_file(self) -> None:
        """A legacy .doc, as the live portal serves it."""
        if "certificate" in Handler.refuse:
            # The portal reports this in-page and keeps its chrome, rather
            # than blanking the window -- so the run can carry on to the
            # reports, which is the behaviour the operator needs.
            self._html("""
              <h1>Certificates</h1>
              <a href="/library">Document Library</a>
              <a href="/reports">Reports</a>
              <a href="/certificates">Certificates</a>
              <p>No certificate is available for this solution.</p>
            """)
            return
        from mock_portal import make_docx

        body = make_docx()
        self.send_response(200)
        self.send_header("Content-Type", "application/msword")
        self.send_header("Content-Disposition",
                         'attachment; filename="Certificates71999.doc"')
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _report_links(self) -> str:
        """The report tree. It stays on screen while a form is open.

        This matters: the live portal renders the parameter form *beside* the
        report list, so a run that fetches five reports walks the tree five
        times from the same page. A mock that replaced the list with the form
        would let a driver pass that could only ever fetch one report -- which
        is close to the defect being fixed here.
        """
        links = [
            # The tab bar stays on screen, so the Document Library route is
            # reachable from the reports page and vice versa.
            '<a href="/library">Document Library</a>',
            '<a href="/reports">Standard ESA Reports</a>',
        ]
        for label, (rid, _) in REPORTS.items():
            links.append(f'<a href="/report?id={rid}&label={label}">{label}</a>')
        for parent, children in NESTED.items():
            # The parent is a link that only expands -- it has no report id.
            links.append(f'<a href="/reports">{parent}</a>')
            for child, (rid, _) in children.items():
                links.append(f'<a href="/report?id={rid}&label={child}">{child}</a>')
        return "".join(links)

    def _report_list(self) -> None:
        self._html("<h1>Reports</h1>" + self._report_links())

    def _report_form(self, report_id: str, label: str) -> None:
        """The parameter form, with the report tree still beside it."""
        if "current" in Handler.barren_sites:
            agreements = "<option>There are currently no agreements for this site</option>"
        else:
            agreements = f"<option>{AGREEMENT}</option><option>OTHER-01/25-01</option>"
        self._html(f"""
          <h1>Reports</h1>
          {self._report_links()}
          <hr>
          <h2>{label}</h2>
          <select id="agreement">{agreements}</select>
          <select id="images"><option>Include Images</option>
                              <option>Exclude Images</option></select>
          <select id="order"><option>Locations</option><option>Tag ID</option></select>
          <a href="/viewer?id={report_id}" target="_blank">Print Report</a>
        """)

    def _viewer(self, report_id: str) -> None:
        """The SSRS viewer. Its toolbar is deliberately late to become usable."""
        self._html(f"""
          <h1>Report Viewer</h1>
          <select id="ReportViewer1_ctl01_ctl05_ctl00" disabled>
            <option>Select a format</option>
            <option>Acrobat (PDF) file</option>
          </select>
          <a id="ReportViewer1_ctl01_ctl05_ctl01"
             href="/export?id={report_id}">Export</a>
          <script>
            // The real toolbar is unusable for several seconds after load.
            setTimeout(() => {{
              document.getElementById(
                'ReportViewer1_ctl01_ctl05_ctl00').disabled = false;
            }}, 1200);
          </script>
        """)

    def _export(self, report_id: str) -> None:
        """The PDF, as an inline response -- no download event, no navigation."""
        if report_id in Handler.refuse:
            self.send_response(500)
            self.end_headers()
            self.wfile.write(b"report generation failed")
            return
        pages = 4
        for _, (rid, count) in REPORTS.items():
            if rid == report_id:
                pages = count
        for children in NESTED.values():
            for _, (rid, count) in children.items():
                if rid == report_id:
                    pages = count
        body = make_pdf(f"TEGG report {report_id}", pages)
        self.send_response(200)
        self.send_header("Content-Type", "application/pdf")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class MockSSRSPortal:
    """Serves the report route on a loopback port."""

    def __init__(self, port: int = 0) -> None:
        self.server = HTTPServer(("127.0.0.1", port), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        host, port = self.server.server_address[:2]
        return f"http://{host}:{port}"

    @property
    def documentation_url(self) -> str:
        return self.url + "/sales/documentation"

    @property
    def seen(self) -> list[str]:
        return list(Handler.seen)

    @property
    def mutations(self) -> list[str]:
        return list(Handler.mutations)

    def refuse(self, *report_ids: str) -> None:
        """Make these reports fail to export, to produce a short package."""
        Handler.refuse.update(report_ids)

    def __enter__(self) -> "MockSSRSPortal":
        Handler.seen.clear()
        Handler.mutations.clear()
        Handler.refuse.clear()
        Handler.barren_sites.clear()
        self.thread.start()
        return self

    def __exit__(self, *exc) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
