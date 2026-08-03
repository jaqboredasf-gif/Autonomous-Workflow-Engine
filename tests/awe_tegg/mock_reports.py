"""Synthetic TEGG report PDFs, laid out the way the live ones are.

The real reports name real customers and cannot go in a repository, so the
fixtures are built here instead -- and built to the *geometry* that matters,
measured off live SSRS output on 2026-07-31:

  * a tick is a separate ``X`` run, 15-20 points left of the label it ticks and
    within 3 points vertically;
  * an unticked label is still drawn;
  * free text wraps into separate runs, and SSRS bottom-aligns each text box,
    so a continuation can be pushed below the *next* heading;
  * the severity criteria table puts each range directly under its severity
    word, and the measurement directly under its caption.

A fixture that only reproduced the words would pass whatever the parser did
with them. These reproduce the layout, so a parser that reads the page as a
stream of lines fails against them, which is the point.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

#: The label positions measured on live output. Same on every page.
CONSEQUENCE_X = {
    "Equipment Failure": 51.5,
    "Fire Hazard": 212.5,
    "Safety Hazard": 348.7,
    "Power/Business Interruption": 483.2,
}
CONSEQUENCE_Y = 529.7
RECOMMENDATION_X = {"Repair Equipment": 285.1, "Replace Equipment": 456.2}
RECOMMENDATION_Y = 435.2
CORRECTIVE_X = {
    "Fixed During Visit": 51.5,
    "Contractor Will Correct": 180.0,
    "Customer Will Correct": 330.0,
    "Estimate Required": 483.2,
}
CORRECTIVE_Y = 324.9
CORRECTED_X, CORRECTED_Y = 263.7, 343.4

#: A tick sits this far left of, and this far below, its label.
TICK_DX, TICK_DY = 20.0, -2.5


@dataclass
class Problem:
    """One page of an Equipment Item Problems Report."""

    tag_id: str = "01001"
    customer_id: str = "SW #1-1"
    equipment_type: str = "Switchgear - Vertical Section"
    location: str = "MAIN ROOM"
    observed_on: str = "5/8/2025"
    severity: str = "Alert"
    description: str = "A described problem that runs to several words"
    description_tail: str = ""
    consequence_text: str = ""
    repair_text: str = "A recommended repair that runs to several words"
    repair_tail: str = ""
    repair: tuple[str, ...] = ("Repair Equipment",)
    consequences: tuple[str, ...] = ("Safety Hazard",)
    corrective: tuple[str, ...] = ("Estimate Required",)
    corrected: bool = False
    #: An extra tick placed where no label can claim it, to prove the parser
    #: refuses rather than guesses.
    orphan_tick: tuple[float, float] | None = None


def write_equipment_item_problems(path: Path, problems: list[Problem]) -> Path:
    from reportlab.pdfgen import canvas

    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    pdf = canvas.Canvas(str(path), pagesize=(612, 792))

    for index, problem in enumerate(problems, start=1):
        def put(x: float, y: float, text: str, size: float = 8) -> None:
            pdf.setFont("Helvetica", size)
            pdf.drawString(x, y, text)

        put(113.8, 747.5, "25 Seventh Street , Pelham, NY  10803")
        put(113.8, 728.6, "Example Site - STD00000000XX-01/25-01", 10)
        put(496.8, 707.4, "Page", 10)
        put(558.0, 707.4, str(index), 10)
        put(113.8, 706.4, "Equipment Item Problems Report (Corrected)", 12)
        put(24.5, 702.6, problem.observed_on, 10)
        put(24.5, 692.0, "Technician:", 7)
        put(285.1, 692.0, "Location:", 7)
        put(293.1, 681.6, problem.location, 9)
        put(24.5, 669.8, "Tag ID:", 7)
        put(385.6, 669.8, "Equipment Type:", 7)
        put(32.5, 659.4, f"{problem.tag_id} {problem.customer_id}", 9)
        put(393.6, 659.4, problem.equipment_type, 9)

        put(32.5, 637.7, "Problem Description -", 11)
        put(190.1, 637.7, problem.severity, 11)
        put(24.5, 622.9, problem.description, 10)
        if problem.description_tail:
            put(24.5, 618.0, problem.description_tail, 10)

        put(42.5, 543.5, "Consequences if Not Corrected", 12)
        for label, x in CONSEQUENCE_X.items():
            put(x, CONSEQUENCE_Y, label)
            if label in problem.consequences:
                put(x - TICK_DX, CONSEQUENCE_Y + TICK_DY, "X")
        if problem.consequence_text:
            put(24.5, 512.0, problem.consequence_text, 10)

        put(42.5, 432.6, "Recommendations For Repair", 12)
        for label, x in RECOMMENDATION_X.items():
            put(x, RECOMMENDATION_Y, label)
            if label in problem.repair:
                put(x - TICK_DX, RECOMMENDATION_Y + TICK_DY, "X")
        put(24.5, 418.8, problem.repair_text, 10)

        put(CORRECTED_X, CORRECTED_Y, "Problem Corrected")
        if problem.corrected:
            put(CORRECTED_X - TICK_DX, CORRECTED_Y + TICK_DY, "X")
        put(42.5, 339.4, "Corrective Actions", 12)
        for label, x in CORRECTIVE_X.items():
            put(x, CORRECTIVE_Y, label)
            if label in problem.corrective:
                put(x - TICK_DX, CORRECTIVE_Y + TICK_DY, "X")
        # SSRS bottom-aligns its text boxes, so a wrapped repair instruction's
        # second line lands below the Corrective Actions heading.
        if problem.repair_tail:
            put(24.5, 305.5, problem.repair_tail, 10)

        if problem.orphan_tick is not None:
            put(problem.orphan_tick[0], problem.orphan_tick[1], "X")

        pdf.showPage()

    pdf.save()
    return path


@dataclass
class Sheet:
    """One infrared sheet ('A' page) of a Standard IR Report."""

    tag_id: str = "01001"
    customer_id: str = "SW #1-1"
    equipment_type: str = "Switchgear - Vertical Section"
    location: str = "MAIN ROOM"
    page_label: str = "2A"
    problem_c: float = 37.6
    difference_c: float = 7.8
    reference_c: float = 29.8
    bands: dict[str, str] = field(default_factory=lambda: {
        "Normal": "Less Than 4.1C",
        "Alert": "4.1C - 8.0C",
        "Severe": "8.1C - 15.0C",
        "Critical": "Greater Than 15.0C",
    })


def write_standard_ir(path: Path, sheets: list[Sheet]) -> Path:
    from reportlab.pdfgen import canvas

    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    pdf = canvas.Canvas(str(path), pagesize=(612, 792))
    band_x = {"Normal": 23.1, "Alert": 164.8, "Severe": 306.5, "Critical": 448.2}

    for sheet in sheets:
        def put(x: float, y: float, text: str, size: float = 8) -> None:
            pdf.setFont("Helvetica", size)
            pdf.drawString(x, y, text)

        put(119.0, 754.7, "25 Seventh Street , Pelham, NY  10803")
        put(119.0, 738.5, "Example Site - STD00000000XX-01/25-01", 10)
        put(497.0, 714.8, "Page", 10)
        put(558.2, 713.6, sheet.page_label, 10)
        put(119.0, 710.8, "Infrared Inspection Report Sheet (Corrected)", 15)
        put(260.8, 699.0, "Location:", 7)
        put(260.8, 689.5, sheet.location, 8)
        put(355.2, 676.5, "Equipment Type:", 7)
        put(355.2, 668.0, sheet.equipment_type, 7)
        put(24.5, 659.4, f"{sheet.tag_id} {sheet.customer_id}", 7)

        put(188.5, 647.5, "Severity Criteria for Similar Comparisons", 12)
        for name, x in band_x.items():
            put(x, 628.6, name, 14)
            put(x, 610.6, sheet.bands[name], 14)

        put(33.0, 592.6, "Reference Temperature", 14)
        put(221.5, 592.6, "Problem Temperature", 14)
        put(410.5, 592.6, "Difference Temperature", 14)
        put(33.0, 574.6, f"{sheet.reference_c}C", 14)
        put(221.5, 574.6, f"{sheet.problem_c}C", 14)
        put(410.5, 574.6, f"{sheet.difference_c}C", 14)
        pdf.showPage()

    pdf.save()
    return path
