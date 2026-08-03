# PyInstaller build description for the Windows executable.
#
#   pyinstaller packaging\windows_exe\tegg-report-tool.spec --noconfirm
#
# UNBUILT AND UNTESTED at the time of writing. PyInstaller does not
# cross-compile: a Windows .exe can only be produced on Windows, and this
# repository is developed on macOS. Everything here is written to be correct
# and is reviewed, but nothing in this file has been run. See
# EXECUTABLE_BUILD.md, which says the same thing at more length and lists what
# to check the first time it is run on a real PC.
#
# The script-based package next door is the one that ships. This is the
# follow-on, and it is deliberately not on the critical path.

import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_submodules

# SPECPATH is set by PyInstaller to the directory holding this file.
ROOT = Path(SPECPATH).resolve().parents[1]      # noqa: F821  (PyInstaller global)
SRC = ROOT / "src"

block_cipher = None

# Playwright is the awkward dependency. It carries a Node driver of its own,
# which is a real file on disk rather than an importable module, so it has to
# be collected wholesale or the frozen build imports cleanly and then fails at
# the moment it tries to open a browser.
playwright_datas, playwright_binaries, playwright_hidden = collect_all("playwright")

hidden = list(playwright_hidden)
for package in ("awe_tegg", "awe_runtime", "awe_knowledge", "awe_estimating",
                "tegg"):
    hidden += collect_submodules(package)
hidden += [
    # Imported lazily inside functions, so the analysis does not see them.
    "yaml",
    "pypdf",
    "docx",
    "reportlab",
    "reportlab.pdfgen",
    "reportlab.lib.pagesizes",
]

# What travels inside the executable. Note what is NOT here: config/ and
# data/operational_knowledge stay beside the .exe as ordinary files, because a
# coworker is meant to be able to edit the rate card and because the knowledge
# store is written to as the tool learns. Anything the tool writes cannot live
# inside a read-only bundle that is re-extracted on every launch.
datas = list(playwright_datas) + [
    (str(ROOT / "assets" / "static"), "assets/static"),
]

a = Analysis(                                             # noqa: F821
    [str(Path(SPECPATH) / "entry.py")],                   # noqa: F821
    pathex=[str(SRC)],
    binaries=list(playwright_binaries),
    datas=datas,
    hiddenimports=hidden,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # Nothing here is needed by a tool that drives a browser and writes text,
    # and each one costs tens of megabytes.
    excludes=["tkinter", "matplotlib", "numpy", "pytest", "IPython"],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)     # noqa: F821

exe = EXE(                                                # noqa: F821
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="awe-tegg",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,          # UPX compression is one of the strongest triggers for
                        # a false-positive antivirus detection. Not worth the
                        # 20 MB.
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,       # The operator needs to read what it is doing.
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    # A manifest asking for anything above the invoking user's own rights would
    # put a UAC prompt in front of a coworker who has no administrator
    # password. This tool needs none.
    uac_admin=False,
    uac_uiaccess=False,
)
