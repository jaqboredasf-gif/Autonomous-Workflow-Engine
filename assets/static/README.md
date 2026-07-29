# Static assets

Two documents in the ESA report are the same on every job and are not exported
from the portal. Drop the real files here, named exactly:

- `ESA Table of Contents.pdf`
- `TEGGPro View Customer Instructions.pdf`

`tegg doctor` reports whether both are present. Until they are, `tegg build`
stops and names them as missing rather than producing a report with two
sections silently absent.

One open question for Paul: is the table of contents genuinely identical for
every report, or does it change with report length? If it varies it has to be
generated per job rather than stored here. See docs/GAPS.md #8.
