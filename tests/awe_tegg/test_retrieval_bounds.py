"""What the report-retrieval step is not allowed to do.

``documents.ReportRun`` is the one part of this system that clicks and types,
because rendering an SSRS report cannot be done any other way. That makes its
boundary the most important one in the repository and the least self-evident:
there is no "the object has no click method" argument available here, so the
limits have to be tested rather than asserted in a docstring.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from awe_tegg import documents as D                         # noqa: E402


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


# -- refusing controls that change things --------------------------------


@pytest.mark.parametrize(
    "label",
    [
        "Save", "Submit", "Approve", "Send", "Email", "E-mail", "Delete",
        "Remove", "Mark as Complete", "Sign", "Upload", "Publish",
        "Create Invoice", "Submit Report", "Send to Customer",
    ],
)
def test_a_control_that_changes_something_is_refused(label):
    with pytest.raises(D.ActionRefused) as caught:
        D.check_label(label)
    assert "not a read" in str(caught.value)


@pytest.mark.parametrize(
    "label",
    [
        "Reports", "Standard ESA Reports", "Print Report", "Export",
        "Standard IR Report", "Equipment Item Problems", "Exclude All Images",
        "Problem Count Summary",
    ],
)
def test_the_controls_this_route_needs_are_allowed(label):
    assert D.check_label(label) == label


def test_the_permitted_control_list_contains_nothing_that_writes():
    for label in D.PERMITTED_CONTROLS:
        assert D.check_label(label) == label


def test_a_report_named_like_a_mutation_is_refused_rather_than_opened():
    """The report tree is the portal's, not ours. A future entry called
    'Submit Findings' must not be clickable just because it is in the tree."""
    with pytest.raises(D.ActionRefused):
        D.check_label("Submit Findings")


# -- the budget -----------------------------------------------------------


def test_the_action_budget_stops_a_runaway_and_says_nothing_changed():
    clock = FakeClock()
    budget = D.RetrievalBudget(max_actions=3)
    for index in range(3):
        budget.spend(f"click {index}", clock)
    with pytest.raises(D.RetrievalError) as caught:
        budget.spend("one too many", clock)
    assert "nothing was changed" in str(caught.value)
    assert budget.spent_actions == 4


def test_the_time_budget_stops_a_hang_and_says_nothing_changed():
    clock = FakeClock()
    budget = D.RetrievalBudget(max_seconds=60.0)
    budget.spend("first", clock)
    clock.now = 61.0
    with pytest.raises(D.RetrievalError) as caught:
        budget.spend("later", clock)
    assert "nothing was changed" in str(caught.value)


def test_the_budget_records_everything_it_spent_so_a_run_can_be_audited():
    clock = FakeClock()
    budget = D.RetrievalBudget()
    budget.spend("open Reports", clock)
    budget.spend("click Print Report", clock)
    assert budget.to_dict()["trail"] == ["open Reports", "click Print Report"]
    assert budget.to_dict()["spent_actions"] == 2


# -- the route it will follow --------------------------------------------


def test_the_equipment_item_problems_report_is_reached_through_its_parent():
    """Clicking the parent only expands it. A run that stopped there would
    export whatever form happened to be showing -- which is how an earlier
    attempt produced an Arc Flash inventory and called it a problems report."""
    assert D.EQUIPMENT_ITEM_PROBLEMS == (
        "Equipment Item Problems", "Exclude All Images"
    )
    assert len(D.STANDARD_IR) == 1


def test_the_images_variant_chosen_is_the_one_without_images():
    """Same problem records, a fraction of the bytes and the render time."""
    assert D.EQUIPMENT_ITEM_PROBLEMS[-1] == "Exclude All Images"
