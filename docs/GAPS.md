# Gap register — what stands between this and a working automation

Status as of the current commit. Ordered by what blocks the most.

| # | Gap | Blocks | Who unblocks it | Est. |
|---|-----|--------|-----------------|------|
| 1 | Portal not reachable from the build environment | All portal automation | IT / infra | hours |
| 2 | Portal selectors not captured | All portal automation | Dev, at the live site | ~1 day |
| 3 | No sample `Certificates.docx` | Certificate stage | Paul | minutes to supply |
| 4 | "First checkbox group" is ambiguous | Certificate stage | Paul | minutes to clarify |
| 5 | Shared drive not reachable | Saving output to the drive | IT | hours |
| 6 | Service account / credential handling | Safe unattended runs | IT + Paul | ~1 day |
| 7 | Output filename separator unconfirmed | Final filename | Paul | minutes |
| 8 | Two static assets missing | Final merge | Paul | minutes to supply |
| 9 | No run log / audit trail | Support & trust | Dev | ~1 day |
| 10 | Where it runs is undecided | Going live | Team decision | — |

---

## 1. The portal is not reachable from this environment — BLOCKING

`tegg2.teggpro.com` is refused at the network gateway before any login is
attempted:

```
connect_rejected — gateway answered 403 to CONNECT — tegg2.teggpro.com:443
```

This is an allowlist denial, **not** an authentication failure. Supplying
credentials does not change it. Someone with access to the environment's
network policy has to add `tegg2.teggpro.com` to the allowlist, or the portal
stage has to be developed and run somewhere with normal outbound access (a
workstation, or a VM inside the corporate network).

Until this is resolved, no amount of code makes the download stage work.

## 2. Portal selectors have not been captured — BLOCKING

`src/tegg/portal.py` transcribes the SOP's navigation faithfully — every menu
name, every dropdown, every button label is recorded. What it does not have is
the mapping from those labels onto actual page elements (the CSS/ARIA
selectors). That mapping can only be written with the live site open.

There are 16 of them, listed in `portal.SELECTORS`. `tegg plan` prints which
are still outstanding. The code refuses to run rather than guessing.

Two things to watch for when this work happens, because they change the
estimate materially:

- **Report rendering.** "Print Report" → "Select a Format" → "Export" is the
  signature of an embedded report viewer (Crystal Reports or SSRS). These
  often render inside an iframe and stream the PDF through a postback, which
  is fiddlier to automate than a plain download link.
- **MFA.** If the portal ever challenges with a second factor, unattended
  automation needs a different approach entirely.

## 3. No sample `Certificates.docx` — BLOCKING the certificate stage

Word stores checkboxes three different ways (legacy form fields, content
controls, or literal `☐`/`☒` characters). Which one this document uses cannot
be determined without seeing one. `certificate.py` handles all three, but the
selectors are unvalidated.

**Ask:** one real `Certificates.docx`, with any customer identifiers scrubbed.

## 4. "Delete first group of checkboxes" is ambiguous — BLOCKING

The SOP says to delete the first group. It does not say how many boxes are in
that group or where the group ends. Deleting the wrong number silently
corrupts a document that goes to a customer, so the code **refuses to run**
this step rather than guess.

**Ask Paul:** in the sample document, exactly which boxes get deleted?

## 5. The shared drive is not reachable

The Google Drive connector returns nothing for "TEGG" — the `TEGG T SharedDrive`
is not visible to it. The likely causes are that it is a Shared Drive rather
than My Drive, that it lives on a different account, or that it is a Windows
file share rather than Google Drive at all.

The code sidesteps this for now: `--drive-root` takes any mounted path, so it
works against a mapped network drive, a synced folder, or a local directory
without caring which. But confirmation is needed of **what the drive actually
is** before the final save step can be trusted.

## 6. Credentials — needs a real answer before going live

The credentials supplied so far are Paul's own named user account. Automating
with a human's personal login has three problems:

1. **Audit trail** — every automated action looks like Paul did it manually.
2. **Fragility** — the automation breaks the next time he changes his password.
3. **Blast radius** — the credential ends up wherever the automation runs.

Those credentials were also pasted into a chat window, so they should be
treated as exposed and **rotated**.

**Recommended:** request a dedicated service account from the TEGG Pro vendor,
scoped to report generation only. Until then the code reads
`TEGG_USERNAME` / `TEGG_PASSWORD` from the environment and there is no code
path that reads a credential from a file, so nothing can be committed by
accident.

## 7. Output filename separator — needs confirmation

The SOP writes the final name as:

```
“Company Name””Site Name””Year” ESA Report.pdf
```

The quotes are placeholder markers, so the real separator is unclear — it
could be spaces, underscores, or nothing. Currently defaulting to single
spaces (`Acme Manufacturing Plant 3 - Toledo 2026 ESA Report.pdf`), set by
`assembly.output_template` in `config/workflow.yaml`.

**Ask Paul:** paste one real filename and this is settled.

## 8. Two static documents are missing

`ESA Table of Contents.pdf` and `TEGGPro View Customer Instructions.pdf` are
the same on every job and are not pulled from the portal. They need to be
dropped into `assets/static/`. Until then the merge stage stops and names them
as missing.

Also worth confirming: are these genuinely identical for every customer, or
does the table of contents vary by report length? If it varies, it has to be
generated rather than stored.

## 9. No run log or audit trail

Nothing currently records what was produced, from which agreement and site
visit, at what time, by whom. For a document that goes to a customer and may
be referenced in a warranty or insurance dispute, that record matters. A JSON
log per run, written next to the output, would cover it.

## 10. Where this runs is undecided

Three options, with real tradeoffs:

- **On Paul's workstation, run manually.** Simplest. No infrastructure, no
  service account strictly required. But it only helps when he runs it.
- **On a shared VM, run on demand.** Anyone can trigger it. Needs a service
  account and drive access sorted first.
- **Fully scheduled.** Highest leverage, but needs a trigger — something has
  to decide *which* site visits are ready to report on, and nothing in the SOP
  describes how Paul makes that decision today.

**Worth asking Paul:** how does he currently know a site visit is ready to be
reported? That answer determines whether full scheduling is even possible.

---

## Deliberately out of scope for now

- Quality-checking report *contents* (the automation reproduces the manual
  output faithfully, including any upstream data problems).
- Emailing or delivering the finished report to the customer.
- Backfilling historical reports.
