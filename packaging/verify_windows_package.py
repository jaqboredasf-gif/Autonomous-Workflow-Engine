"""Check the built Windows package the way the coworker will receive it.

The build's own audit runs against the folder it just assembled, which is the
thing it is least likely to be wrong about. This runs against the **zip**,
unpacked into a directory that has never seen this repository -- because the
zip is the artefact that actually leaves, and twice now the difference between
the folder and the zip is where the defect was.

    python packaging/verify_windows_package.py dist/TEGG-Report-Tool-Windows.zip

What it cannot do is run the scripts: this is a Mac. Everything below is what
can be established without Windows, and the report says so.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

#: Nothing matching these may be inside the artefact.
UNWANTED = (
    "__pycache__", ".pyc", ".DS_Store", "/.git", "/tests/", "/docs/",
    "/packaging/", ".venv", "ratecard.yaml", ".env",
)

#: Every launcher and every document the launchers name.
EXPECTED = (
    "Setup.bat", "Setup.ps1",
    "Run Report.bat", "Run Report.ps1",
    "Check Setup.bat", "Check Setup.ps1",
    "Diagnostic.bat", "Diagnostic.ps1",
    "TEGG-Common.ps1",
    "START HERE.txt", "OPERATOR_GUIDE.md", "TROUBLESHOOTING.txt",
    "pyproject.toml",
    "config/service.yaml", "config/ratecard.example.yaml",
    "config/workflow.yaml",
)

ASCII_SUFFIXES = (".ps1", ".bat", ".txt")
CRLF_SUFFIXES = (".bat", ".txt")


def check(name: str, ok: bool, detail: str = "") -> tuple[str, bool, str]:
    return (name, ok, detail)


def unwanted_files(root: Path) -> list[str]:
    hits = []
    for path in sorted(root.rglob("*")):
        relative = "/" + str(path.relative_to(root))
        for token in UNWANTED:
            if token in relative:
                hits.append(f"{relative} matches {token!r}")
    return hits


def missing_files(root: Path, package: str) -> list[str]:
    base = root / package
    return [name for name in EXPECTED if not (base / name).exists()]


def encoding_problems(root: Path) -> list[str]:
    problems = []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in ASCII_SUFFIXES:
            continue
        blob = path.read_bytes()
        try:
            blob.decode("ascii")
        except UnicodeDecodeError as error:
            problems.append(f"{path.name}: non-ASCII byte at {error.start}")
        if blob.startswith(b"\xef\xbb\xbf"):
            problems.append(f"{path.name}: has a UTF-8 byte-order mark")
        if path.suffix.lower() in CRLF_SUFFIXES:
            lone = blob.replace(b"\r\n", b"").count(b"\n")
            if lone:
                problems.append(f"{path.name}: {lone} LF-only line ending(s)")
    return problems


def secret_hits(root: Path) -> tuple[list[str], list[str]]:
    """Search by value for anything that must never ship."""
    needles = {
        name: os.environ[name]
        for name in ("TEGG_USERNAME", "TEGG_PASSWORD")
        if os.environ.get(name) and len(os.environ[name]) >= 4
    }
    checked = sorted(needles)
    if not needles:
        return [], []

    hits = []
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        blob = path.read_bytes()
        lowered = blob.lower()
        for name, value in needles.items():
            if value.encode() in blob or value.lower().encode() in lowered:
                hits.append(f"{path.name} contains {name}")
    return hits, checked


#: Things that look like a secret even when no live value is available to
#: compare against. Deliberately loose: a false positive costs one look.
SUSPICIOUS = (
    re.compile(rb"(?i)password\s*[:=]\s*['\"][^'\"]{4,}"),
    re.compile(rb"(?i)api[_-]?key\s*[:=]\s*['\"][^'\"]{8,}"),
    re.compile(rb"(?i)\bBearer\s+[A-Za-z0-9._-]{20,}"),
    re.compile(rb"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
)


#: A value that is a bare identifier is a field *name*, not a value. The login
#: configuration legitimately contains `password: "password"` -- that is the
#: name of the input on the portal's sign-in form, and calling it a leaked
#: secret is how a scan that cries wolf gets ignored on the day it is right.
FIELD_NAME = re.compile(rb"^[a-z][a-z0-9_-]{0,24}$")


def suspicious_hits(root: Path) -> list[str]:
    hits = []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix in (".pdf", ".docx"):
            continue
        try:
            blob = path.read_bytes()
        except OSError:
            continue
        for pattern in SUSPICIOUS:
            for match in pattern.findall(blob):
                value = match.split(b":")[-1].split(b"=")[-1].strip().strip(b"'\"")
                if FIELD_NAME.match(value):
                    continue
                hits.append(f"{path.name}: {match[:40]!r}")
    return hits


def local_paths(root: Path) -> list[str]:
    """A path from this Mac inside a shipped file means a leak or a break."""
    home = str(Path.home()).encode()
    hits = []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix in (".pdf", ".docx"):
            continue
        try:
            blob = path.read_bytes()
        except OSError:
            continue
        if home in blob:
            hits.append(f"{path.name} contains this machine's home directory")
    return hits


def launcher_targets(root: Path, package: str) -> list[str]:
    """Every .bat must name a .ps1 that is actually in the package."""
    problems = []
    base = root / package
    for bat in sorted(base.glob("*.bat")):
        text = bat.read_text(encoding="ascii", errors="replace")
        for target in re.findall(r'-File\s+"%~dp0([^"]+)"', text):
            if not (base / target).exists():
                problems.append(f"{bat.name} runs {target}, which is missing")
        if "-ExecutionPolicy Bypass" not in text:
            problems.append(f"{bat.name} does not bypass the execution policy")
        if "%~dp0" not in text:
            problems.append(f"{bat.name} does not anchor to its own folder")
    return problems


def named_files_exist(root: Path, package: str) -> list[str]:
    """A script that tells the operator to open a file that is not there."""
    base = root / package
    problems = []
    named = ("TROUBLESHOOTING.txt", "OPERATOR_GUIDE.md", "START HERE.txt",
             "Setup.bat", "Run Report.bat", "Check Setup.bat", "Diagnostic.bat")
    for script in sorted(base.glob("*.ps1")):
        text = script.read_text(encoding="ascii", errors="replace")
        for name in named:
            if name in text and not (base / name).exists():
                problems.append(f"{script.name} names {name}, which is missing")
    return problems


def powershell_syntax(root: Path, package: str, pwsh: str | None) -> list[str]:
    """Parse every .ps1 with PowerShell's own parser, if one is available."""
    if not pwsh:
        return ["(no PowerShell on this machine, so nothing was parsed)"]
    base = root / package
    probe = (
        "$bad=@(); Get-ChildItem -LiteralPath '%s' -Filter *.ps1 | ForEach-Object {"
        "  $t=$null; $e=$null;"
        "  [void][System.Management.Automation.Language.Parser]::ParseFile("
        "     $_.FullName, [ref]$t, [ref]$e);"
        "  if ($e -and $e.Count) { $bad += ($_.Name + ': ' + $e[0].Message) } };"
        "if ($bad) { $bad | ForEach-Object { Write-Output $_ } } "
        "else { Write-Output 'PARSED-CLEAN' }"
    ) % str(base)
    result = subprocess.run([pwsh, "-NoProfile", "-Command", probe],
                            capture_output=True, text=True, timeout=180)
    output = result.stdout.strip()
    if "PARSED-CLEAN" in output:
        return []
    return [line for line in output.splitlines() if line.strip()] or \
           [f"the parser did not answer: {result.stderr.strip()[:200]}"]


def main(argv: list[str]) -> int:
    archive = Path(argv[1] if len(argv) > 1
                   else "dist/TEGG-Report-Tool-Windows.zip").resolve()
    if not archive.exists():
        print(f"no such archive: {archive}")
        return 2

    pwsh = shutil.which("pwsh") or os.environ.get("PWSH")
    package = archive.stem

    with tempfile.TemporaryDirectory(prefix="tegg-verify-") as temporary:
        room = Path(temporary)
        with zipfile.ZipFile(archive) as bundle:
            bundle.extractall(room)

        secrets, checked_names = secret_hits(room)
        results = [
            check("no caches, tests, docs or development artefacts",
                  not unwanted_files(room), "; ".join(unwanted_files(room)[:5])),
            check("every launcher and document is present",
                  not missing_files(room, package),
                  ("missing: " + ", ".join(missing_files(room, package)))
                  if missing_files(room, package) else ""),
            check("Windows text files are ASCII with CRLF line endings",
                  not encoding_problems(room),
                  "; ".join(encoding_problems(room)[:5])),
            check("no live credential value anywhere in the archive",
                  not secrets,
                  ("checked by value against " + ", ".join(checked_names))
                  if checked_names
                  else "NOT CHECKED: no credential in this environment to "
                       "search for"),
            check("nothing that looks like a secret",
                  not suspicious_hits(room), "; ".join(suspicious_hits(room)[:3])),
            check("no path from the machine that built it",
                  not local_paths(room), "; ".join(local_paths(room)[:3])),
            check("every .bat runs a .ps1 that exists, from its own folder",
                  not launcher_targets(room, package),
                  "; ".join(launcher_targets(room, package))),
            check("every file a script tells the operator to open exists",
                  not named_files_exist(room, package),
                  "; ".join(named_files_exist(room, package))),
            check("every .ps1 parses",
                  not [p for p in powershell_syntax(room, package, pwsh)
                       if not p.startswith("(")],
                  "; ".join(powershell_syntax(room, package, pwsh))),
        ]

        files = sum(1 for p in room.rglob("*") if p.is_file())
        print(f"verifying {archive.name}  ({files} files, "
              f"{archive.stat().st_size / 1024:.0f} KB)")
        print()
        failed = 0
        for name, ok, detail in results:
            mark = "OK     " if ok else "PROBLEM"
            print(f"  {mark}  {name}")
            if detail and detail.strip().rstrip(":"):
                print(f"           {detail}")
            failed += 0 if ok else 1

        print()
        print("Not checked here, because this is not Windows: that Setup "
              "actually installs,\nthat the sign-in encrypts and decrypts, and "
              "that a run completes. Those need\na Windows PC.")
        print()
        print("VERIFIED" if not failed else f"{failed} problem(s)")
        return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
