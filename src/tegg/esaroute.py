"""The route to a Standard ESA report, ported from the run that proved it.

This is the navigation half of the working live export, extracted from the
throwaway script that first achieved it. Everything here is a discovery about
the real portal, not a preference:

  * The company-level ``/reports`` page is a dead end ("currently no
    agreements"). Reports live under ``/sales/documentation``.
  * A **site** must be selected before any tab renders anything. Searching the
    *customer* name does not surface its sites.
  * The search box is an ngx-bootstrap typeahead. ``fill()`` sets the value
    without raising input events, so no results appear; it must be typed.
  * ``Short Form`` / ``Long Form`` are ``<a>`` tags with no ``href`` inside
    ``tr.child-level-1``, **already expanded**. Clicking the ``Equipment
    Inventory`` parent collapses them, which is why the first attempts timed
    out. Click the leaf directly and expand only if it is genuinely hidden.
  * Because the leaves have no ``href``, ``get_by_role("link")`` never matches
    them; ``a:text-is('Short Form')`` does.

The tab clicks use ``get_by_text`` rather than a role selector for the same
reason: these are ``<span>``s and ``<p>``s in the live DOM, not links.
"""

from __future__ import annotations

from dataclasses import dataclass

from . import fieldmap

# Defaults matching config/workflow.yaml's esa_reports block.
SEARCH_PLACEHOLDER = "customer or site"
TYPEAHEAD_ITEM = "typeahead-container .dropdown-item, typeahead-container a"
REPORTS_TAB = "Reports"
ESA_LIST = "Standard ESA Reports"
PRINT_REPORT = "Print Report"
ACCORDION_PARENTS = ("Equipment Inventory",)


class RouteError(Exception):
    """A navigation step could not be completed."""


def settle(page, tries: int = 12, interval_ms: int = 600) -> bool:
    """Wait until the page stops saying it is loading.

    Returns whether it settled. Bounded on purpose: this is called between every
    step, so an unbounded wait here would hide a broken step as a slow one.
    """
    for _ in range(tries):
        try:
            if "loading" not in page.inner_text("body").lower():
                return True
        except Exception:
            pass
        page.wait_for_timeout(interval_ms)
    return False


def open_documentation(page, base_url: str, path: str = "/sales/documentation") -> None:
    page.goto(f"{base_url}{path}", wait_until="domcontentloaded")
    try:
        page.wait_for_load_state("networkidle", timeout=15000)
    except Exception:
        pass
    settle(page)


def select_site(
    page,
    site: str,
    *,
    placeholder: str = SEARCH_PLACEHOLDER,
    item_selector: str = TYPEAHEAD_ITEM,
    keystroke_delay_ms: int = 120,
    settle_ms: int = 2500,
) -> bool:
    """Type a site name into the typeahead and click the exact match.

    The exact match is required. A substring match would happily select
    "Riverside Depot 2" when the job is for "Riverside Depot", and every
    subsequent step would succeed against the wrong site.
    """
    box = page.locator(f"input[placeholder*='{placeholder}' i]").first
    box.click()
    try:
        box.fill("")
    except Exception:
        pass
    # Real keystrokes: fill() raises no input events and the typeahead ignores it.
    box.press_sequentially(site, delay=keystroke_delay_ms)
    page.wait_for_timeout(settle_ms)

    items = page.locator(item_selector)
    wanted = " ".join(site.split()).lower()
    for index in range(min(items.count(), 40)):
        item = items.nth(index)
        try:
            if not item.is_visible():
                continue
            if " ".join(item.inner_text().split()).lower() == wanted:
                item.click()
                page.wait_for_timeout(settle_ms)
                settle(page)
                return True
        except Exception:
            continue
    return False


def open_report_list(page, *, reports_tab: str = REPORTS_TAB,
                     esa_list: str = ESA_LIST, pause_ms: int = 1200) -> None:
    """Reports tab -> Standard ESA Reports."""
    for label in (reports_tab, esa_list):
        try:
            page.get_by_text(label, exact=True).first.click(timeout=20000)
        except Exception as exc:
            raise RouteError(
                f"could not open {label!r}: {str(exc).splitlines()[0][:120]}"
            ) from exc
        page.wait_for_timeout(pause_ms)
        settle(page)


def _visible_leaf(page, label: str):
    """The report's clickable leaf, if it is on screen."""
    for selector in (
        f"tr.child-level-1 a:text-is('{label}')",
        f"a:text-is('{label}')",
    ):
        locator = page.locator(selector)
        for index in range(min(locator.count(), 6)):
            try:
                if locator.nth(index).is_visible():
                    return locator.nth(index)
            except Exception:
                continue
    return None


def click_report(
    page,
    label: str,
    *,
    parents: tuple[str, ...] = ACCORDION_PARENTS,
    timeout_ms: int = 15000,
    pause_ms: int = 1500,
) -> None:
    """Open one report. Expands its accordion parent only if it must.

    Clicking the parent when the list is already open *collapses* it, so this
    checks for the leaf first and only ever expands as a recovery.
    """
    locator = _visible_leaf(page, label)
    if locator is None:
        for parent in parents:
            try:
                page.get_by_text(parent, exact=True).first.click(timeout=8000)
                page.wait_for_timeout(pause_ms)
                settle(page)
            except Exception:
                continue
            locator = _visible_leaf(page, label)
            if locator is not None:
                break
    if locator is None:
        raise RouteError(f"{label!r} is not visible in the report list")

    locator.scroll_into_view_if_needed(timeout=5000)
    locator.click(timeout=timeout_ms)
    page.wait_for_timeout(pause_ms)
    settle(page)


def read_controls(page) -> list[fieldmap.Control]:
    """Every visible dropdown on the report form, with its options.

    Read in one round trip: doing it a locator at a time is slow enough on the
    real form to be worth avoiding, and a form that re-renders midway would
    otherwise be read inconsistently.
    """
    try:
        raw = page.eval_on_selector_all(
            "select",
            """els => els.map((e, i) => ({
                index: i,
                name: e.getAttribute('name') || e.getAttribute('data-field')
                      || e.id || '',
                required: e.hasAttribute('required'),
                visible: !!(e.offsetParent || e.getClientRects().length),
                options: Array.from(e.options)
                    .map(o => (o.textContent || '').trim())
            }))""",
        )
    except Exception:
        raw = []
    return [
        fieldmap.Control(
            index=item["index"],
            options=[o for o in item["options"]],
            required=bool(item["required"]),
            name=item["name"],
        )
        for item in raw
        if item.get("visible")
    ]


def apply_plan(page, plan: fieldmap.Plan, *, settle_ms: int = 1200) -> list[str]:
    """Set every planned dropdown. Returns human-readable descriptions.

    The Agreement is set first and waited on, because on the real form it
    reloads the remaining controls.
    """
    applied: list[str] = []
    ordered = sorted(
        plan.assignments, key=lambda a: 0 if a.parameter == fieldmap.AGREEMENT else 1
    )
    selects = page.locator("select")
    for assignment in ordered:
        control = selects.nth(assignment.index)
        try:
            control.select_option(label=assignment.option, timeout=10000)
        except Exception as exc:
            raise RouteError(
                f"could not set {assignment.parameter} to "
                f"{assignment.option!r}: {str(exc).splitlines()[0][:120]}"
            ) from exc
        applied.append(f"{assignment.parameter}={assignment.option}")
        if assignment.parameter == fieldmap.AGREEMENT:
            page.wait_for_timeout(settle_ms)
            settle(page)
    return applied


@dataclass
class Prepared:
    """A report form, opened and filled, ready for Print Report."""

    label: str
    applied: list[str]
    plan: fieldmap.Plan


def prepare_report(
    page,
    label: str,
    *,
    agreement: str,
    order_by: str = fieldmap.DEFAULT_ORDER_BY,
    images: str = fieldmap.DEFAULT_IMAGES,
    site_visit: str = "",
    parents: tuple[str, ...] = ACCORDION_PARENTS,
) -> Prepared:
    """Open a report from the list and set its parameters.

    Raises :class:`RouteError` if the report's own parameters cannot be
    satisfied -- notably a form that does not offer this job's agreement, which
    means the wrong site or visit is selected and pressing on would export
    somebody else's data.
    """
    click_report(page, label, parents=parents)
    controls = read_controls(page)
    plan = fieldmap.plan(
        controls,
        agreement=agreement,
        order_by=order_by,
        images=images,
        site_visit=site_visit,
    )
    if plan.missing_fields:
        raise RouteError("; ".join(plan.missing_fields))
    applied = apply_plan(page, plan)
    if plan.unresolved:
        raise RouteError("; ".join(plan.unresolved))
    return Prepared(label=label, applied=applied, plan=plan)
