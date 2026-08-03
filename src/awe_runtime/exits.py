"""What an AWE command's exit code means. One contract, for every capability.

A scheduler, a cron entry or a coworker's shell script reads exactly one thing
from a run: the number it exited with. So that number has to answer a different
question for each outcome, and the same question the same way in every
capability.

The five:

    0  it worked
    1  it tried and could not finish
    2  you typed the command wrong
    3  it stopped on purpose and needs a person
    4  it never started -- this machine or this configuration is not ready

The distinction that matters most is **4 against 1**. "Not ready" means nothing
was attempted: no portal was contacted, no file was written, nothing changed,
and retrying without fixing something will produce the same result. "Failed"
means it started and something went wrong partway, which may be transient and
may be worth retrying. Collapsing those two costs an operator an afternoon.

The distinction that caused this module to exist is **2 against 3**. Both used
to be 2, because ``argparse`` exits 2 on a usage error and the capability had
independently chosen 2 for "needs a person". A caller could not tell a typo
from an escalation. ``argparse``'s 2 is a decades-old convention and is not
worth fighting, so escalation moved to 3.

Nothing here imports anything. It is a contract, not a mechanism.
"""

from __future__ import annotations

#: It worked. Whatever the capability promised to do, it did.
EXIT_OK = 0

#: It started and could not finish. May be transient; retrying is reasonable.
EXIT_FAILED = 1

#: The command line was wrong. This is ``argparse``'s own convention and is
#: reserved for it -- a capability must not use 2 for anything it decides.
EXIT_USAGE = 2

#: It stopped on purpose and handed the problem to a person. The run is
#: usually resumable and the output says what is needed.
EXIT_NEEDS_HUMAN = 3

#: It never started. Preflight found something wrong with the machine or the
#: configuration, nothing was attempted, and nothing was changed anywhere.
EXIT_NOT_READY = 4

_MEANING: dict[int, str] = {
    EXIT_OK: "finished; whatever it promised to do, it did",
    EXIT_FAILED: "started and could not finish; may be worth retrying",
    EXIT_USAGE: "the command line was wrong; nothing was attempted",
    EXIT_NEEDS_HUMAN: "stopped on purpose and needs a person; usually resumable",
    EXIT_NOT_READY: (
        "never started -- this machine or this configuration is not ready. "
        "Nothing was contacted and nothing was changed"
    ),
}


def describe_exit(code: int) -> str:
    """One line explaining an exit code, for an operator rather than a log."""
    return _MEANING.get(code, f"unrecognised exit code {code}")


def exit_table() -> str:
    """The contract as a Markdown table, so documentation cannot drift from it.

    Generated rather than transcribed on purpose: a runbook that lists these by
    hand is a runbook that will eventually be wrong.
    """
    lines = ["| code | meaning |", "|-----:|---------|"]
    for code in sorted(_MEANING):
        lines.append(f"| `{code}` | {_MEANING[code]} |")
    return "\n".join(lines)
