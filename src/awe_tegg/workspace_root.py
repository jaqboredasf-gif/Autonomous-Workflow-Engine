"""Compatibility shim: this moved to :mod:`awe_runtime.workspace_root`.

It was extracted once it had been proved in this capability, because knowing
where your installation is -- and refusing to run from outside it -- is
something every AWE capability needs and none of them should own a copy of.

Kept as a re-export so imports written against the old location keep working.
"""

from __future__ import annotations

from awe_runtime.workspace_root import (      # noqa: F401
    ENV_ROOT,
    INSTALL_ROOT,
    MARKERS,
    NotInInstallation,
    describe_root,
    in_installation,
    install_root,
    looks_like_installation,
    require_installation,
    resolve,
)
