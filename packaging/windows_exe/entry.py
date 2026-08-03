"""The entry point PyInstaller freezes.

A frozen build has no console-script shims, so the thing ``pip install`` would
have generated as ``awe-tegg.exe`` has to exist as a real module. This is that,
and nothing else: no logic lives here, because logic that only runs in the
frozen build is logic that is never tested in the one that ships today.
"""

from __future__ import annotations

import multiprocessing
import sys

from awe_tegg.cli import main

if __name__ == "__main__":
    # Without this, a frozen build on Windows re-executes the whole program in
    # every worker process anything happens to spawn -- which for a tool that
    # drives a browser means several browsers.
    multiprocessing.freeze_support()
    sys.exit(main())
