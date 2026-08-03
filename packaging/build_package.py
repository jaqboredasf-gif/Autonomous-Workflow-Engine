"""Build the folder a coworker actually receives.

The repository is not the product. It carries 40 test files, a maintainer's
handoff, a live-evidence log, packaging machinery and the history of how the
thing was built -- none of which a coworker needs, and some of which invites
them to open something that will confuse them.

So the distributable is assembled by an allowlist, not by deleting things from
a copy. An allowlist fails safe: forget to exclude something and it is simply
absent, and the clean-room test catches it. A denylist fails the other way, and
the thing you forget to exclude is the thing you did not think about.

    python packaging/build_package.py            -> dist/TEGG-Report-Tool/
    python packaging/build_package.py --zip      -> dist/TEGG-Report-Tool.zip

What goes in, and why each is needed at runtime:

  src/awe_tegg, src/awe_knowledge, src/awe_runtime, src/tegg
      The operation imports ``tegg.fetch`` and ``tegg.evidence``, so the older
      package travels too. Verified by import, not assumed -- see --verify.
  data/operational_knowledge
      What earlier runs learned about the portal. Without it a coworker's
      first run rediscovers the route from scratch; with it, it just works.
      Contains no credential and no customer record.
  config/service.yaml, config/estimating.example.yaml
      The two files a coworker may edit.
  scripts/, and the three .command launchers
      What they double-click.

What stays out, and why:

  tests/            developer-only, and the fixtures look like real data
  docs/ (most)      maintainer documents; the operator gets one runbook
  packaging/        this file
  work/, .venv/     machine state, and work/ holds customer documents
  config/estimating.yaml   somebody's real commercial rates
  .git/             the coworker is not a developer and must not need Git
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKAGE_NAME = "TEGG-Report-Tool"

#: Directories copied whole. Anything not listed does not travel.
DIRECTORIES = (
    "src/awe_tegg",
    "src/awe_knowledge",
    "src/awe_runtime",
    "src/tegg",
    "data/operational_knowledge",
    "assets/static",
)

#: Individual files, with their destination path in the package.
FILES = {
    "config/service.yaml": "config/service.yaml",
    "config/estimating.example.yaml": "config/estimating.example.yaml",
    "config/workflow.yaml": "config/workflow.yaml",
    "scripts/_awe.sh": "scripts/_awe.sh",
    "scripts/visit-findings.sh": "scripts/visit-findings.sh",
    "scripts/documentation-read.sh": "scripts/documentation-read.sh",
    "packaging/operator/Setup.command": "Setup.command",
    "packaging/operator/Run Report.command": "Run Report.command",
    "packaging/operator/Check Setup.command": "Check Setup.command",
    "packaging/operator/START HERE.txt": "START HERE.txt",
    "packaging/operator/OPERATOR_GUIDE.md": "OPERATOR_GUIDE.md",
    "packaging/operator/pyproject.toml": "pyproject.toml",
}

#: Never copied, whatever else says so. Checked against every file that would
#: be written, so a new match inside an allowed directory is still caught.
FORBIDDEN = (
    "estimating.yaml",          # somebody's real rates
    ".env",
    "credentials",
    ".pyc",
    "__pycache__",
    ".DS_Store",
)

#: Made empty in the package, so the first run has somewhere to write and the
#: coworker can see where things will appear.
EMPTY_DIRECTORIES = ("work", "output")

EXECUTABLE = (".command", ".sh")


def forbidden(path: Path) -> str:
    name = str(path)
    for token in FORBIDDEN:
        if token in name:
            return token
    return ""


def build(destination: Path, *, quiet: bool = False) -> Path:
    def say(message: str) -> None:
        if not quiet:
            print(message)

    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True)

    copied = skipped = 0
    for relative in DIRECTORIES:
        source = ROOT / relative
        if not source.is_dir():
            raise SystemExit(f"missing directory: {relative}")
        for item in sorted(source.rglob("*")):
            if not item.is_file():
                continue
            reason = forbidden(item.relative_to(ROOT))
            if reason:
                skipped += 1
                continue
            target = destination / item.relative_to(ROOT)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(item, target)
            copied += 1
    say(f"  {copied} source file(s) copied, {skipped} skipped by the forbidden list")

    for relative, into in FILES.items():
        source = ROOT / relative
        if not source.is_file():
            raise SystemExit(f"missing file: {relative}")
        target = destination / into
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        if target.suffix in EXECUTABLE:
            target.chmod(0o755)
    say(f"  {len(FILES)} operator file(s) copied")

    for relative in EMPTY_DIRECTORIES:
        (destination / relative).mkdir(parents=True, exist_ok=True)
        (destination / relative / ".keep").write_text(
            "This folder is where the tool writes its results.\n", encoding="utf-8"
        )

    return destination


def audit(package: Path) -> list[str]:
    """Everything about the package that should stop it being sent."""
    problems: list[str] = []

    for path in package.rglob("*"):
        if not path.is_file():
            continue
        reason = forbidden(path.relative_to(package))
        if reason:
            problems.append(f"{path.relative_to(package)} matches {reason!r}")

    for unwanted in ("tests", ".git", ".venv", "packaging", "docs"):
        if (package / unwanted).exists():
            problems.append(f"{unwanted}/ must not be in the package")

    for required in ("Setup.command", "Run Report.command", "START HERE.txt",
                     "OPERATOR_GUIDE.md", "config/service.yaml"):
        if not (package / required).exists():
            problems.append(f"{required} is missing")

    for relative in ("Setup.command", "Run Report.command", "Check Setup.command"):
        path = package / relative
        if path.exists() and not path.stat().st_mode & 0o111:
            problems.append(f"{relative} is not executable")

    return problems


def scan_for_secrets(package: Path) -> list[str]:
    """Refuse to ship anything carrying a live credential value.

    Checked by value against the environment, the same way the repository's own
    sweep works. A package is the one artefact that definitely leaves this
    machine, so this is the last place it can be caught.
    """
    import os

    needles = {
        name: os.environ[name].encode()
        for name in ("TEGG_USERNAME", "TEGG_PASSWORD")
        if os.environ.get(name) and len(os.environ[name]) >= 4
    }
    if not needles:
        return ["(no credentials in this environment, so none could be checked for)"]

    hits: list[str] = []
    for path in package.rglob("*"):
        if not path.is_file():
            continue
        try:
            blob = path.read_bytes()
        except OSError:                                     # pragma: no cover
            continue
        for name, value in needles.items():
            if value in blob or value.lower() in blob:
                hits.append(f"{path.relative_to(package)} contains {name}")
    return hits


def verify_imports(package: Path) -> list[str]:
    """Prove the package can import what it needs, using only its own files."""
    probe = (
        "import sys; sys.path.insert(0, 'src');"
        "import awe_tegg.cli, awe_tegg.visit_operation, awe_runtime, "
        "awe_knowledge, tegg.fetch, tegg.evidence;"
        "print('ok')"
    )
    result = subprocess.run(
        [sys.executable, "-c", probe], cwd=package,
        capture_output=True, text=True, timeout=120,
    )
    if result.returncode != 0 or "ok" not in result.stdout:
        return [f"the package cannot import itself: {result.stderr.strip()[:400]}"]
    return []


def make_zip(package: Path) -> Path:
    archive = package.with_suffix(".zip")
    archive.unlink(missing_ok=True)
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
        for path in sorted(package.rglob("*")):
            if path.is_file():
                info = zipfile.ZipInfo(str(Path(package.name) / path.relative_to(package)))
                info.external_attr = (path.stat().st_mode & 0xFFFF) << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                bundle.writestr(info, path.read_bytes())
    return archive


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build the coworker package.")
    parser.add_argument("--into", default=str(ROOT / "dist"), type=Path)
    parser.add_argument("--zip", action="store_true", help="Also produce a .zip")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(argv)

    package = Path(args.into) / PACKAGE_NAME
    print(f"building {package}")
    build(package, quiet=args.quiet)

    print("auditing")
    problems = audit(package) + scan_for_secrets(package) + verify_imports(package)
    real = [p for p in problems if not p.startswith("(")]
    for problem in problems:
        print(f"  {'note:' if problem.startswith('(') else 'PROBLEM:'} {problem}")
    if real:
        print(f"\n{len(real)} problem(s). The package was NOT approved for sending.")
        return 1

    files = sum(1 for p in package.rglob("*") if p.is_file())
    size = sum(p.stat().st_size for p in package.rglob("*") if p.is_file())
    print(f"  clean: {files} file(s), {size / 1024:.0f} KB")

    if args.zip:
        archive = make_zip(package)
        print(f"\nwrote {archive} ({archive.stat().st_size / 1024:.0f} KB)")
    print(f"\nSend: {package if not args.zip else package.with_suffix('.zip')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
