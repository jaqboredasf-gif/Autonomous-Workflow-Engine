"""Where a capability's installation is, and whether you are standing in it.

Every path an operation needs -- the run folder, the rate card, the service
file, the knowledge store -- used to be resolved against whatever directory the
coworker happened to be in. That produced a specific and bad failure:

    $ cd /tmp
    $ python -m awe_tegg run visit-findings

signed into the live portal, retrieved two real customers' inspection reports
into ``/tmp/work/operations/.../documents/``, parsed them, generated
recommendations, and only then stopped -- on a missing rate card. Meanwhile the
knowledge store, whose root is absolute, was updated in the *real* repository.
Half the run's state went somewhere nobody would look for it, the other half
went where it always goes, and 1.5 MB of customer data was left in a
world-readable directory.

Two things fix that, and both live here:

  * **One anchor.** Relative defaults resolve against the installation, not
    against the shell's working directory. ``work/`` means *this* ``work/``,
    wherever you are standing.
  * **A refusal that names the real problem.** A run started from outside the
    installation is stopped before the browser opens, and told so in those
    words -- rather than being allowed to proceed and fail nine steps later on
    whichever file it happened to miss first.

An explicit ``--work-root`` or ``--rate-card`` is always honoured as given. The
anchor is about defaults, and about knowing when the defaults are a guess.
"""

from __future__ import annotations

import os
from pathlib import Path

#: The installation root: the directory holding ``src/``, ``config/`` and
#: ``docs/``. Derived from this file rather than from the process, so it is the
#: same answer however the tool was started.
INSTALL_ROOT = Path(__file__).resolve().parents[2]

#: What tells us a directory really is an installation of this tool, rather
#: than somewhere that merely has a folder with the right name.
MARKERS = ("pyproject.toml", "src", "config")

#: Override for tests and for anyone running an unusual layout.
ENV_ROOT = "AWE_ROOT"


class NotInInstallation(RuntimeError):
    """The command was started somewhere it cannot safely use its defaults."""


def install_root() -> Path:
    """The installation this code belongs to."""
    override = os.environ.get(ENV_ROOT)
    if override:
        return Path(override).expanduser().resolve()
    return INSTALL_ROOT


def looks_like_installation(path: Path) -> bool:
    return all((Path(path) / marker).exists() for marker in MARKERS)


def resolve(path: Path | str, *, root: Path | None = None) -> Path:
    """Make a path absolute against the installation rather than the shell.

    An absolute path is returned unchanged: somebody who typed one meant it.
    """
    candidate = Path(path).expanduser()
    if candidate.is_absolute():
        return candidate
    return (Path(root) if root else install_root()) / candidate


def in_installation(cwd: Path | None = None) -> bool:
    """Whether the shell is inside the installation this code belongs to."""
    here = Path(cwd or Path.cwd()).resolve()
    root = install_root()
    return here == root or root in here.parents


def require_installation(cwd: Path | None = None) -> Path:
    """Refuse, in words, when the defaults would be a guess.

    Called before anything expensive. The message names the real problem --
    where you are standing -- because the symptom a coworker would otherwise
    see is a missing rate card, which sends them looking in entirely the wrong
    place.
    """
    root = install_root()
    if in_installation(cwd):
        return root
    here = Path(cwd or Path.cwd()).resolve()
    raise NotInInstallation(
        f"this command was started in {here}, which is not inside the "
        f"installation at {root}.\n"
        f"    Run it from there instead:  cd {root}\n"
        "    Everything it needs -- the service file, the rate card, the run "
        "folder -- lives under that directory, and a run started elsewhere "
        "would write customer documents somewhere you did not intend."
    )


def describe_root() -> str:
    root = install_root()
    if os.environ.get(ENV_ROOT):
        return f"{root}  (from {ENV_ROOT})"
    return str(root)
