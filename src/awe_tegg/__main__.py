"""``python -m awe_tegg`` -- the operator entry point.

Kept to one line on purpose: the module a coworker types is not the place to
put behaviour, because it is the one place nothing is tested from.
"""

from .cli import main

raise SystemExit(main())
