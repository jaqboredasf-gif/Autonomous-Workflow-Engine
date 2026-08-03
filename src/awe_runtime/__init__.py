"""Shared runtime for AWE capabilities.

What lives here is what more than one capability needs and none of them should
own: how a command reports its outcome, where a capability's files are, and how
it tells an operator their machine is not ready.

The rule for adding to this package: it goes here when it is **already**
general and **already** proven in a capability, not when it looks like it might
be reusable one day. Everything currently in here was extracted from the TEGG
capability after it was live-proven, which is the only evidence that the
abstraction is the right shape.

Deliberately not here yet, and why:

  * the run ledger (``awe_tegg.checkpoint``) is close to general -- it already
    takes its step list from the operation rather than a module constant -- but
    it has only ever had one consumer, so its shape is a guess until a second
    capability disagrees with it;
  * the knowledge layer (``awe_knowledge``) is already its own package and
    already portal-agnostic;
  * the report retrieval, the findings parser and the estimate are TEGG's, and
    should stay TEGG's.
"""

from .locking import AlreadyRunning, LockInfo, RunLock, process_alive
from .retention import (
    DEFAULT_KEEP_DAYS,
    RunInfo,
    human_bytes,
    remove,
    scan,
    sweepable,
)
from .exits import (
    EXIT_FAILED,
    EXIT_NEEDS_HUMAN,
    EXIT_NOT_READY,
    EXIT_OK,
    EXIT_USAGE,
    describe_exit,
    exit_table,
)
from .workspace_root import (
    ENV_ROOT,
    NotInInstallation,
    describe_root,
    in_installation,
    install_root,
    looks_like_installation,
    require_installation,
    resolve,
)

__all__ = [
    "AlreadyRunning",
    "DEFAULT_KEEP_DAYS",
    "ENV_ROOT",
    "EXIT_FAILED",
    "EXIT_NEEDS_HUMAN",
    "EXIT_NOT_READY",
    "EXIT_OK",
    "EXIT_USAGE",
    "LockInfo",
    "NotInInstallation",
    "RunInfo",
    "RunLock",
    "describe_exit",
    "describe_root",
    "exit_table",
    "human_bytes",
    "in_installation",
    "install_root",
    "looks_like_installation",
    "process_alive",
    "require_installation",
    "remove",
    "resolve",
    "scan",
    "sweepable",
]
