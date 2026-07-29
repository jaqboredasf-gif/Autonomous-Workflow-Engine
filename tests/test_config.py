import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from tegg.config import ConfigError, Job, Workflow, sanitize_component  # noqa: E402
from tegg.paths import JobFolder  # noqa: E402

REAL_WORKFLOW = ROOT / "config" / "workflow.yaml"
REAL_JOB = ROOT / "config" / "job.example.yaml"


@pytest.fixture
def job():
    return Job.from_file(REAL_JOB)


@pytest.fixture
def workflow():
    return Workflow.from_file(REAL_WORKFLOW)


class TestSanitize:
    def test_strips_path_separators(self):
        assert sanitize_component("A/B") == "A-B"
        assert sanitize_component("A\\B") == "A-B"

    def test_collapses_whitespace(self):
        assert sanitize_component("  Acme   Corp  ") == "Acme Corp"

    def test_strips_trailing_dot(self):
        # Trailing dots break folder creation on Windows.
        assert sanitize_component("Acme Inc.") == "Acme Inc"

    @pytest.mark.parametrize("value", ["", "   ", "..."])
    def test_rejects_values_that_sanitize_to_nothing(self, value):
        with pytest.raises(ConfigError):
            sanitize_component(value)

    def test_illegal_only_input_becomes_dashes_not_empty(self):
        # Not empty, so it is allowed through rather than rejected.
        assert sanitize_component("///") == "---"


class TestJob:
    def test_loads_the_example(self, job):
        assert job.company == "Acme Manufacturing"
        assert job.agreement == "AG-118422"

    def test_year_is_a_string(self, job):
        # YAML parses 2026 as int; it must be usable as a folder name.
        assert job.year == "2026"

    def test_missing_fields_are_named(self, tmp_path):
        bad = tmp_path / "bad.yaml"
        bad.write_text("company: Acme\n")
        with pytest.raises(ConfigError, match="site.*year.*agreement"):
            Job.from_file(bad)

    def test_missing_file(self, tmp_path):
        with pytest.raises(ConfigError, match="not found"):
            Job.from_file(tmp_path / "nope.yaml")


class TestWorkflow:
    def test_real_workflow_loads(self, workflow):
        assert len(workflow.documents) == 7
        assert len(workflow.assembly_order) == 10

    def test_every_document_has_required_fields(self, workflow):
        for document in workflow.documents:
            assert document["key"]
            assert document["filename"]
            assert document["nav"]

    def test_placeholders_resolve(self, workflow, job):
        short_form = next(
            d for d in workflow.documents if d["key"] == "equipment_inventory_short"
        )
        params = workflow.resolve_params(short_form, job)
        assert params["agreement"] == "AG-118422"
        assert params["site_visit"] == "2026-05-14"
        assert params["order_by"] == "Locations"

    def test_unknown_placeholder_is_reported(self, workflow, job):
        with pytest.raises(ConfigError, match="unknown placeholder"):
            workflow.resolve_params(
                {"key": "x", "params": {"a": "{nope}"}}, job
            )

    def test_output_name(self, workflow, job):
        assert (
            workflow.output_name(job)
            == "Acme Manufacturing Plant 3 - Toledo 2026 ESA Report.pdf"
        )

    def test_certificate_answers_match_the_sop(self, workflow):
        section_b = workflow.certificate["section_b"]
        assert section_b["yes_items"] == [1, 2, 3, 4, 5, 9]
        assert section_b["no_items"] == [6, 7, 8, 10]
        # Every item 1-10 is accounted for exactly once.
        combined = sorted(section_b["yes_items"] + section_b["no_items"])
        assert combined == list(range(1, 11))

    def test_split_covers_the_whole_ir_report(self, workflow):
        pages = [o["pages"] for o in workflow.splits[0]["outputs"]]
        assert pages == ["1", "2-"]

    def test_assembly_order_is_covered_by_documents_splits_and_assets(
        self, workflow
    ):
        """Nothing in the merge order can come from nowhere."""
        produced = {d["filename"] for d in workflow.documents}
        produced |= {
            o["name"] for s in workflow.splits for o in s["outputs"]
        }
        produced |= set(workflow.static_assets)
        produced.add(workflow.certificate["output"])

        unaccounted = [n for n in workflow.assembly_order if n not in produced]
        assert unaccounted == [], f"nothing produces: {unaccounted}"

    def test_rejects_workflow_missing_a_section(self, tmp_path):
        bad = tmp_path / "bad.yaml"
        bad.write_text("documents: []\n")
        with pytest.raises(ConfigError, match="missing"):
            Workflow.from_file(bad)


class TestJobFolder:
    def test_path_layout(self, tmp_path, job, workflow):
        folder = JobFolder(tmp_path, workflow.raw["destination"]["root"], job)
        assert folder.path.parts[-3:] == (
            "Acme Manufacturing",
            "Plant 3 - Toledo",
            "2026",
        )
        assert "z. TEGG Job Folders (Reports Only)" in str(folder.path)

    def test_ensure_creates_all_levels(self, tmp_path, job, workflow):
        folder = JobFolder(tmp_path, workflow.raw["destination"]["root"], job)
        assert len(folder.created_levels()) == 3
        created = folder.ensure()
        assert created.is_dir()
        assert folder.created_levels() == []

    def test_ensure_reuses_an_existing_folder(self, tmp_path, job, workflow):
        folder = JobFolder(tmp_path, workflow.raw["destination"]["root"], job)
        folder.ensure()
        marker = folder.path / "existing.txt"
        marker.write_text("prior work")
        folder.ensure()
        assert marker.read_text() == "prior work"
