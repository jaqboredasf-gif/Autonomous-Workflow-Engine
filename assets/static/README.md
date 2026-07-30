# Static assets

Two documents in the ESA report are the same on every job and are not exported
from the portal. Drop the real files here, named exactly:

- `ESA Table of Contents.pdf`
- `TEGGPro View Customer Instructions.pdf`

`tegg doctor` reports whether both are present. Until they are, `tegg build`
stops and names them as missing rather than producing a report with two
sections silently absent.

## Why these are not in version control

Both are matched by the blanket `*.pdf` rule in `.gitignore`, deliberately:
`TEGGPro View Customer Instructions.pdf` carries the contractor's branding, a
named staff email address and a customer-portal URL. Neither file is ours to
publish, so neither is committed.

That leaves a fresh clone unable to assemble a ten-section report. To run the
controlled mock without the real documents:

    python -m tegg.mock_runner --synthesize-assets

That writes stand-ins with these exact filenames, each stamped
`SYNTHETIC STAND-IN -- NOT THE REAL SECTION` in its text layer. An existing
file is never overwritten, so running it in a checkout that already holds the
real assets is safe. Any run that uses a stand-in marks the deliverable
`finalization_status: blocked` and says so in the summary -- a report assembled
with one in it must not be sent.

One open question for Paul: is the table of contents genuinely identical for
every report, or does it change with report length? If it varies it has to be
generated per job rather than stored here. See docs/GAPS.md #8.
