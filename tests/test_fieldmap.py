"""Parameter planning, tested without a browser.

Every rule here was learned from the live form, so each test names the
behaviour it encodes rather than just the function it calls.
"""

from __future__ import annotations

from tegg import fieldmap
from tegg.fieldmap import Control

AGREEMENT = "STD88117209SM-05/25-01"


def _by_parameter(plan: fieldmap.Plan) -> dict[str, str]:
    return {a.parameter: a.option for a in plan.assignments}


def test_the_agreement_is_claimed_first_because_it_reloads_the_form():
    controls = [
        Control(0, ["Include Images", "No Images"], required=True),
        Control(1, [AGREEMENT, "STD00000000XX-01/25-04"], required=True),
    ]
    plan = fieldmap.plan(controls, agreement=AGREEMENT)
    assert plan.ok, plan.to_dict()
    assert plan.assignments[0].parameter == fieldmap.AGREEMENT
    assert plan.assignments[0].index == 1


def test_order_by_is_recognised_by_offering_both_locations_and_tag_id():
    controls = [
        Control(0, [AGREEMENT], required=True),
        Control(1, ["Locations", "Tag ID", "Equipment Type"], required=True),
    ]
    plan = fieldmap.plan(controls, agreement=AGREEMENT)
    assert _by_parameter(plan)[fieldmap.ORDER_BY] == "Locations"


def test_a_requested_order_by_the_form_does_not_offer_falls_back_to_locations():
    controls = [
        Control(0, [AGREEMENT], required=True),
        Control(1, ["Locations", "Tag ID"], required=True),
    ]
    plan = fieldmap.plan(controls, agreement=AGREEMENT, order_by="Serial Number")
    assert _by_parameter(plan)[fieldmap.ORDER_BY] == "Locations"
    assert plan.ok


def test_images_wins_over_order_by_when_a_control_offers_both():
    # Images is matched first deliberately: 'Include Images' is unambiguous,
    # where a control listing 'Locations' might be something else entirely.
    controls = [
        Control(0, [AGREEMENT], required=True),
        Control(1, ["Include Images", "No Images", "Locations", "Tag ID"]),
    ]
    plan = fieldmap.plan(controls, agreement=AGREEMENT)
    assert _by_parameter(plan)[fieldmap.IMAGES] == "Include Images"
    assert fieldmap.ORDER_BY not in _by_parameter(plan)


def test_a_site_visit_control_is_matched_by_the_visit_id():
    controls = [
        Control(0, [AGREEMENT], required=True),
        Control(1, ["T25-204", "T25-190"], required=True),
    ]
    plan = fieldmap.plan(controls, agreement=AGREEMENT, site_visit="T25-204")
    assert _by_parameter(plan)[fieldmap.SITE_VISIT] == "T25-204"


def test_one_control_is_never_assigned_twice():
    controls = [Control(0, [AGREEMENT, "Include Images", "Locations", "Tag ID"])]
    plan = fieldmap.plan(controls, agreement=AGREEMENT)
    assert len(plan.assignments) == 1
    assert {a.index for a in plan.assignments} == {0}


def test_an_agreement_the_form_does_not_offer_is_a_missing_field():
    # The important part: this is reported as a *job* problem, because it means
    # the wrong site or visit is selected, not that the driver is broken.
    controls = [Control(0, ["STD00000000XX-01/25-04"], required=True)]
    plan = fieldmap.plan(controls, agreement=AGREEMENT)
    assert not plan.ok
    assert plan.missing_fields
    assert AGREEMENT in plan.missing_fields[0]
    assert "STD00000000XX-01/25-04" in plan.missing_fields[0]


def test_a_required_control_nothing_matched_is_reported_as_unresolved():
    controls = [
        Control(0, [AGREEMENT], required=True),
        Control(1, ["Yes", "No"], required=True, name="Include Deficiencies"),
    ]
    plan = fieldmap.plan(controls, agreement=AGREEMENT)
    assert not plan.ok
    assert any("Include Deficiencies" in u for u in plan.unresolved)
    assert any("Yes, No" in u for u in plan.unresolved)


def test_an_optional_control_nothing_matched_is_left_alone():
    controls = [
        Control(0, [AGREEMENT], required=True),
        Control(1, ["Yes", "No"], required=False),
    ]
    plan = fieldmap.plan(controls, agreement=AGREEMENT)
    assert plan.ok, plan.to_dict()


def test_a_form_with_no_controls_still_reports_the_missing_agreement():
    plan = fieldmap.plan([], agreement=AGREEMENT)
    assert not plan.ok
    assert plan.missing_fields
    assert not plan.unresolved


def test_every_assignment_carries_the_reason_it_was_made():
    controls = [
        Control(0, [AGREEMENT], required=True),
        Control(1, ["Include Images", "No Images"]),
    ]
    plan = fieldmap.plan(controls, agreement=AGREEMENT)
    assert all(a.reason for a in plan.assignments)
