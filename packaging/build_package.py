"""Build the folder a coworker actually receives.

The repository is not the product. It carries 40 test files, a maintainer's
handoff, a live-evidence log, packaging machinery and the history of how the
thing was built -- none of which a coworker needs, and some of which invites
them to open something that will confuse them.

So the distributable is assembled by an allowlist, not by deleting things from
a copy. An allowlist fails safe: forget to exclude something and it is simply
absent, and the clean-room test catches it. A denylist fails the other way, and
the thing you forget to exclude is the thing you did not think about.

    python packaging/build_package.py                        -> dist/TEGG-Report-Tool/
    python packaging/build_package.py --zip                  -> dist/TEGG-Report-Tool.zip
    python packaging/build_package.py --platform windows --zip
                                        -> dist/TEGG-Report-Tool-Windows.zip
    python packaging/build_package.py --platform all --zip   -> both

One implementation, two surfaces. Everything a run actually does is the same
Python on both operating systems; what differs is the half-dozen files a
coworker double-clicks, where the sign-in is kept, and which sentence to print
when something is missing. Those are the only things ``--platform`` changes,
and keeping them to a table means a fix to the operation reaches both packages
without anybody remembering to port it.

What goes in, and why each is needed at runtime:

  src/awe_tegg, src/awe_knowledge, src/awe_runtime, src/awe_estimating, src/tegg
      The operation imports ``tegg.fetch`` and ``tegg.evidence``, so the older
      package travels too, and ``awe_estimating`` since pricing moved out of
      the capability. Verified by import, not assumed: ``verify_imports``
      caught ``awe_estimating`` missing from this list, which had already
      shipped a macOS package that could not start.
  data/operational_knowledge
      What earlier runs learned about the portal. Without it a coworker's
      first run rediscovers the route from scratch; with it, it just works.
      Contains no credential and no customer record.
  config/service.yaml, config/ratecard.example.yaml
      The two files a coworker may edit.
  scripts/, and the three .command launchers
      What they double-click.

What stays out, and why:

  tests/            developer-only, and the fixtures look like real data
  docs/ (most)      maintainer documents; the operator gets one runbook
  packaging/        this file
  work/, .venv/     machine state, and work/ holds customer documents
  config/ratecard.yaml     somebody's real commercial rates
  .git/             the coworker is not a developer and must not need Git
"""

from __future__ import annotations

import argparse
import os
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
    "src/awe_estimating",
    "src/tegg",
    "data/operational_knowledge",
    "assets/static",
)

#: Everything a run needs whatever machine it is on. The Python is the
#: product; the launchers are the surface, and there is one set per platform.
SHARED_FILES = {
    "config/service.yaml": "config/service.yaml",
    "config/ratecard.example.yaml": "config/ratecard.example.yaml",
    "config/workflow.yaml": "config/workflow.yaml",
}

#: The macOS surface: three double-clickable .command files and a bash helper.
MACOS_FILES = {
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

#: The Windows surface. The .bat files are what gets double-clicked; each one
#: exists only to run the .ps1 of the same name with the execution policy
#: bypassed for that single run, which is the thing a downloaded script cannot
#: do for itself. The shell scripts do not travel: nothing on Windows runs them
#: and a folder of files that do nothing is a folder of questions.
WINDOWS_FILES = {
    "packaging/operator/windows/Setup.bat": "Setup.bat",
    "packaging/operator/windows/Setup.ps1": "Setup.ps1",
    "packaging/operator/windows/Run Report.bat": "Run Report.bat",
    "packaging/operator/windows/Run Report.ps1": "Run Report.ps1",
    "packaging/operator/windows/Check Setup.bat": "Check Setup.bat",
    "packaging/operator/windows/Check Setup.ps1": "Check Setup.ps1",
    "packaging/operator/windows/Diagnostic.bat": "Diagnostic.bat",
    "packaging/operator/windows/Diagnostic.ps1": "Diagnostic.ps1",
    "packaging/operator/windows/TEGG-Common.ps1": "TEGG-Common.ps1",
    "packaging/operator/windows/START HERE.txt": "START HERE.txt",
    "packaging/operator/windows/OPERATOR_GUIDE.md": "OPERATOR_GUIDE.md",
    "packaging/operator/windows/TROUBLESHOOTING.txt": "TROUBLESHOOTING.txt",
    "packaging/operator/pyproject.toml": "pyproject.toml",
}

#: What each platform is called, what its package is called, and which files
#: make up its surface.
PLATFORMS = {
    "macos": {
        "suffix": "",
        "files": MACOS_FILES,
        "required": ("Setup.command", "Run Report.command", "START HERE.txt",
                     "OPERATOR_GUIDE.md", "config/service.yaml"),
        "executable_bits": ("Setup.command", "Run Report.command",
                            "Check Setup.command"),
        "text_must_be_ascii": (),
    },
    "windows": {
        "suffix": "-Windows",
        "files": WINDOWS_FILES,
        "required": ("Setup.bat", "Setup.ps1", "Run Report.bat",
                     "Run Report.ps1", "Check Setup.bat", "Check Setup.ps1",
                     "Diagnostic.bat", "Diagnostic.ps1", "TEGG-Common.ps1",
                     "START HERE.txt", "OPERATOR_GUIDE.md",
                     "TROUBLESHOOTING.txt", "config/service.yaml"),
        "executable_bits": (),
        # Windows PowerShell 5.1 -- the only shell every Windows PC is
        # guaranteed to have -- reads a .ps1 with no byte-order mark as the
        # machine's ANSI code page. One curly quote in a comment then arrives
        # on somebody else's PC as mojibake, and in the wrong place it is a
        # parse error. So the Windows surface is ASCII, and it is checked.
        "text_must_be_ascii": (".ps1", ".bat", ".txt"),
    },
}

#: Never copied, whatever else says so. Checked against every file that would
#: be written, so a new match inside an allowed directory is still caught.
FORBIDDEN = (
    "ratecard.yaml",            # somebody's real rates
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


def build(destination: Path, *, platform: str = "macos", quiet: bool = False) -> Path:
    profile = PLATFORMS[platform]
    files = dict(SHARED_FILES)
    files.update(profile["files"])

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

    for relative, into in files.items():
        source = ROOT / relative
        if not source.is_file():
            raise SystemExit(f"missing file: {relative}")
        target = destination / into
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        if target.suffix in EXECUTABLE:
            target.chmod(0o755)
    say(f"  {len(files)} operator file(s) copied")

    say(f"  {sanitize_knowledge(destination)} absolute path(s) made relative "
        "in the knowledge store")

    for relative in EMPTY_DIRECTORIES:
        (destination / relative).mkdir(parents=True, exist_ok=True)
        (destination / relative / ".keep").write_text(
            "This folder is where the tool writes its results.\n", encoding="utf-8"
        )

    return destination


def sanitize_knowledge(package: Path) -> int:
    """Take this machine out of the knowledge the coworker receives.

    The knowledge store records, against each thing an earlier run learned, the
    screenshot that proved it -- as an absolute path, because that is what the
    run had. Shipped unchanged, every one of those names the maintainer's home
    directory, and on a Windows PC they are not even the right shape.

    The record is worth keeping; the machine it was made on is not. So the path
    is made relative to the installation, which is what it always meant.
    """
    changed = 0
    prefixes = (str(ROOT) + "/", str(Path.home()) + "/")
    for path in sorted(package.rglob("*")):
        if not path.is_file() or path.suffix not in (".json", ".jsonl"):
            continue
        text = path.read_text(encoding="utf-8")
        rewritten = text
        for prefix in prefixes:
            if prefix in rewritten:
                rewritten = rewritten.replace(prefix, "")
        if rewritten != text:
            path.write_text(rewritten, encoding="utf-8")
            changed += text.count(str(ROOT)) or 1
    return changed


def audit(package: Path, *, platform: str = "macos") -> list[str]:
    """Everything about the package that should stop it being sent."""
    profile = PLATFORMS[platform]
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

    for required in profile["required"]:
        if not (package / required).exists():
            problems.append(f"{required} is missing")

    for relative in profile["executable_bits"]:
        path = package / relative
        if path.exists() and not path.stat().st_mode & 0o111:
            problems.append(f"{relative} is not executable")

    # The build machine must not be identifiable from the artefact, and a path
    # from it is also simply wrong on the coworker's PC.
    for path in sorted(package.rglob("*")):
        if not path.is_file() or path.suffix in (".pdf", ".docx", ".png"):
            continue
        try:
            blob = path.read_bytes()
        except OSError:                                     # pragma: no cover
            continue
        if str(Path.home()).encode() in blob:
            problems.append(
                f"{path.relative_to(package)} contains the path of the machine "
                "that built this"
            )

    problems.extend(audit_windows_text(package, profile))
    return problems


def audit_windows_text(package: Path, profile: dict) -> list[str]:
    """The two ways a text file breaks when it crosses to Windows.

    Neither shows up in a code review on a Mac, and both are silent until the
    file is in front of the coworker: a non-ASCII byte becomes mojibake under
    the ANSI code page Windows PowerShell 5.1 assumes, and a lone LF makes
    Notepad -- which is what a stuck operator will actually open -- render the
    whole troubleshooting sheet as a single line.
    """
    suffixes = profile["text_must_be_ascii"]
    if not suffixes:
        return []

    problems: list[str] = []
    for path in sorted(package.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in suffixes:
            continue
        blob = path.read_bytes()
        try:
            blob.decode("ascii")
        except UnicodeDecodeError as error:
            problems.append(
                f"{path.relative_to(package)} is not ASCII at byte "
                f"{error.start}: Windows PowerShell would misread it"
            )
        if path.suffix.lower() in (".bat", ".txt"):
            lone_lf = blob.replace(b"\r\n", b"").count(b"\n")
            if lone_lf:
                problems.append(
                    f"{path.relative_to(package)} has {lone_lf} line(s) ending "
                    "in LF rather than CRLF"
                )
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
    """Prove the package can import what it needs, using only its own files.

    ``-B``/``PYTHONDONTWRITEBYTECODE`` is not a detail. Importing writes
    ``__pycache__`` beside every module it touches, inside the package, *after*
    the audit that would have rejected it -- which is how 60-odd ``.pyc`` files
    compiled by this Mac's Python 3.14 ended up in a zip sent to somebody
    else's machine. The sweep below is the second half of the fix: proof rather
    than a promise, since anything else that runs here would do the same.
    """
    probe = (
        "import sys; sys.path.insert(0, 'src');"
        "import awe_tegg.cli, awe_tegg.visit_operation, awe_runtime, "
        "awe_knowledge, awe_estimating, tegg.fetch, tegg.evidence;"
        "print('ok')"
    )
    environment = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
    result = subprocess.run(
        [sys.executable, "-B", "-c", probe], cwd=package, env=environment,
        capture_output=True, text=True, timeout=120,
    )

    swept = 0
    for cache in sorted(package.rglob("__pycache__"), reverse=True):
        if cache.is_dir():
            shutil.rmtree(cache, ignore_errors=True)
            swept += 1

    if result.returncode != 0 or "ok" not in result.stdout:
        return [f"the package cannot import itself: {result.stderr.strip()[:400]}"]
    if swept:
        return [f"{swept} __pycache__ director(ies) were created by the import "
                "check and removed; something is still writing bytecode"]
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


def build_one(destination: Path, platform: str, *, want_zip: bool,
              quiet: bool) -> tuple[int, Path]:
    package = destination / (PACKAGE_NAME + PLATFORMS[platform]["suffix"])
    print(f"building {package}  [{platform}]")
    build(package, platform=platform, quiet=quiet)

    print("auditing")
    problems = (audit(package, platform=platform)
                + scan_for_secrets(package)
                + verify_imports(package))
    real = [p for p in problems if not p.startswith("(")]
    for problem in problems:
        print(f"  {'note:' if problem.startswith('(') else 'PROBLEM:'} {problem}")
    if real:
        print(f"\n{len(real)} problem(s). The package was NOT approved for sending.")
        return 1, package

    files = sum(1 for p in package.rglob("*") if p.is_file())
    size = sum(p.stat().st_size for p in package.rglob("*") if p.is_file())
    print(f"  clean: {files} file(s), {size / 1024:.0f} KB")

    if want_zip:
        archive = make_zip(package)
        print(f"  wrote {archive} ({archive.stat().st_size / 1024:.0f} KB)")
        return 0, archive
    return 0, package


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build the coworker package.")
    parser.add_argument("--into", default=str(ROOT / "dist"), type=Path)
    parser.add_argument("--zip", action="store_true", help="Also produce a .zip")
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument(
        "--platform", default="macos", choices=(*PLATFORMS, "all"),
        help="which operator surface to build (default: macos)",
    )
    args = parser.parse_args(argv)

    wanted = list(PLATFORMS) if args.platform == "all" else [args.platform]
    sent: list[Path] = []
    for platform in wanted:
        code, artefact = build_one(Path(args.into), platform,
                                   want_zip=args.zip, quiet=args.quiet)
        if code:
            return code
        sent.append(artefact)
        print()

    print("Send:")
    for artefact in sent:
        print(f"  {artefact.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
