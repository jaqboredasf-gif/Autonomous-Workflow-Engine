"""Report classification.

The costly failure here is silent: a report that lands in the wrong slot still
produces a plausible-looking PDF, and nobody notices until a customer does. So
the discriminating cases -- short vs long form, EDS vs the problem summary --
get the most attention, and anything genuinely ambiguous must say so rather
than pick.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from tegg import canonical  # noqa: E402


class TestClassify:
    @pytest.mark.parametrize(
        "text,expected",
        [
            # Portal labels, as the SOP words them.
            ("Equipment Inventory and Short Form", canonical.EQUIPMENT_INVENTORY_SHORT),
            ("Equipment Inventory and Long Form", canonical.EQUIPMENT_INVENTORY_LONG),
            ("Problem Count Summary", canonical.PROBLEM_COUNT_SUMMARY),
            ("Standard IR Report", canonical.STANDARD_IR),
            (
                "Equipment Item Problems and Include All Images",
                canonical.EQUIPMENT_ITEM_PROBLEMS,
            ),
            (
                "EDS Component Problem Summary and All Problems",
                canonical.EDS_ALL_PROBLEMS,
            ),
            ("Certificates", canonical.CERTIFICATE),
            # Downloaded filenames, which look nothing like the labels.
            ("EquipmentInventoryShortForm.pdf", canonical.EQUIPMENT_INVENTORY_SHORT),
            ("EquipmentInventoryLongForm.pdf", canonical.EQUIPMENT_INVENTORY_LONG),
            ("ProblemCountSummary.pdf", canonical.PROBLEM_COUNT_SUMMARY),
            ("EDSAllProblemsOnly.pdf", canonical.EDS_ALL_PROBLEMS),
            (
                "EquipmentItemProblem_AllImages.pdf",
                canonical.EQUIPMENT_ITEM_PROBLEMS,
            ),
            ("Certificates71999.doc", canonical.CERTIFICATE),
            ("ESA Table of Contents.pdf", canonical.TABLE_OF_CONTENTS),
            (
                "TEGGPro View Customer Instructions.pdf",
                canonical.CUSTOMER_INSTRUCTIONS,
            ),
        ],
    )
    def test_recognises(self, text, expected):
        assert canonical.classify(text).key == expected

    def test_browser_suffix_is_ignored(self):
        """Downloading twice gives ' (1)', which must not change the type."""
        assert (
            canonical.classify("ProblemCountSummary (1).pdf").key
            == canonical.PROBLEM_COUNT_SUMMARY
        )

    def test_short_and_long_never_collide(self):
        """The one-word difference that would swap two sections."""
        short = canonical.classify("Equipment Inventory and Short Form")
        long = canonical.classify("Equipment Inventory and Long Form")
        assert short.key == canonical.EQUIPMENT_INVENTORY_SHORT
        assert long.key == canonical.EQUIPMENT_INVENTORY_LONG
        assert short.key != long.key

    def test_eds_does_not_steal_the_problem_count_summary(self):
        """Both carry 'Problem' and 'Summary'; only one carries EDS."""
        assert (
            canonical.classify("EDS Component Problem Summary").key
            == canonical.EDS_ALL_PROBLEMS
        )
        assert (
            canonical.classify("Problem Count Summary").key
            == canonical.PROBLEM_COUNT_SUMMARY
        )

    def test_split_halves_do_not_reclassify_as_the_whole(self):
        assert (
            canonical.classify("StandardIRReport no cover.pdf").key
            == canonical.STANDARD_IR_NO_COVER
        )
        assert canonical.classify("Cover.pdf").key == canonical.COVER

    def test_unrelated_text_matches_nothing(self):
        for text in ("Log Out", "Dashboard", "", "Help", "Print Report"):
            assert canonical.classify(text).key is None

    def test_ambiguity_is_reported_not_guessed(self):
        """A label matching two types equally must never be silently resolved."""
        result = canonical.classify("Cover no cover")
        assert result.key is None or not result.ambiguous
        # Constructed collision: identical evidence for both inventory forms.
        both = canonical.classify("Inventory Short Long")
        if both.ambiguous:
            assert not both.ok
            assert len(both.candidates) > 1


class TestBusinessOrder:
    def test_matches_the_order_the_business_requires(self):
        assert canonical.BUSINESS_ORDER == [
            canonical.COVER,
            canonical.TABLE_OF_CONTENTS,
            canonical.CERTIFICATE,
            canonical.PROBLEM_COUNT_SUMMARY,
            canonical.EQUIPMENT_INVENTORY_SHORT,
            canonical.EQUIPMENT_INVENTORY_LONG,
            canonical.STANDARD_IR_NO_COVER,
            canonical.EQUIPMENT_ITEM_PROBLEMS,
            canonical.EDS_ALL_PROBLEMS,
            canonical.CUSTOMER_INSTRUCTIONS,
        ]

    def test_ten_sections(self):
        assert len(canonical.BUSINESS_ORDER) == 10

    def test_every_section_has_a_filename_and_title(self):
        for key in canonical.BUSINESS_ORDER:
            assert canonical.output_filename(key)
            assert canonical.title(key) != key

    def test_unknown_type_is_an_error(self):
        with pytest.raises(KeyError):
            canonical.output_filename("not_a_report")

    def test_required_portal_types_exclude_static_and_derived(self):
        assert canonical.COVER not in canonical.REQUIRED_PORTAL_TYPES
        assert canonical.TABLE_OF_CONTENTS not in canonical.REQUIRED_PORTAL_TYPES
        assert canonical.CERTIFICATE in canonical.REQUIRED_PORTAL_TYPES
        assert canonical.STANDARD_IR in canonical.REQUIRED_PORTAL_TYPES
