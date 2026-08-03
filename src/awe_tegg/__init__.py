"""One bounded, read-only TEGG operation an operator can start on their own.

    sign in -> locate the workspace -> reach Documentation -> verify ->
    list the records -> finish

The package exists to prove one behaviour end to end: navigation knowledge that
has gone stale is *detected against the live portal*, corrected by bounded
read-only discovery, superseded through the normal validation rules, and reused
by the next run without rediscovering anything.

  ``guard``       the read-only boundary discovery works inside
  ``markers``     what proves a page really is the Documentation area
  ``discovery``   finding the current route, from live navigation only
  ``checkpoint``  the durable ledger a run resumes from
  ``operation``   the operation itself
  ``report``      the ten lines an operator reads
  ``cli``         ``python -m awe_tegg``

Credentials are read from the environment at the moment they are typed into the
sign-in form and are never written anywhere by anything here.
"""

from .checkpoint import RunLedger, make_run_id
from .discovery import discover_documentation
from .guard import Budget, MutationRefused, ReadOnlyPage
from .markers import DOCUMENTATION_MARKERS, verify
from .operation import OPERATION, OperationResult, Settings, resume, start

__all__ = [
    "OPERATION",
    "Budget",
    "DOCUMENTATION_MARKERS",
    "MutationRefused",
    "OperationResult",
    "ReadOnlyPage",
    "RunLedger",
    "Settings",
    "discover_documentation",
    "make_run_id",
    "resume",
    "start",
    "verify",
]
