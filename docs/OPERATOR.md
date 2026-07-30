# Operator guide — building an ESA report

This is the day-to-day guide. It assumes the tool is already installed; if it
is not, do [Setup](#setup-once-per-machine) first.

The tool does the downloading, splitting, converting and merging. **You still
tick the certificate boxes by hand** — see [The certificate](#the-certificate).

---

## The short version

```bash
cd ~/TEGG
export TEGG_USERNAME='your-portal-user'
export TEGG_PASSWORD='your-portal-password'

.venv/bin/tegg portal list-completed          # 1. which site visits are ready
.venv/bin/tegg run --site-visit 71999         # 2. build the report
```

The report lands in `work/jobs/<job-id>/output/` named
`DRAFT - <Customer> <Site> <Year> ESA Report.pdf`.

Open it, tick the certificate, and when you are happy, send it. Nothing is
emailed or uploaded by the tool — that is deliberate.

---

## Setup (once per machine)

```bash
git clone <repo> ~/TEGG
cd ~/TEGG
python3 -m venv .venv
.venv/bin/pip install -e ".[dev,portal]"
.venv/bin/python -m playwright install chromium
```

LibreOffice is required to convert the certificate:

* macOS — `brew install --cask libreoffice`
* Windows — install LibreOffice normally

Then check everything is in place:

```bash
.venv/bin/tegg doctor
```

Every line should say `OK`. If the portal line says `BLOCKED`, your credentials
are not set — see below.

### Credentials

The tool reads them from the environment and from nowhere else. They are never
written to a config file, never logged, and never included in the evidence
files.

```bash
export TEGG_USERNAME='your-portal-user'
export TEGG_PASSWORD='your-portal-password'
```

To avoid typing them each time, add those two lines to `~/.zshrc`. If your
password contains a `$` or a backtick, use single quotes exactly as shown.

---

## The commands

### 0. Check the sign-in page (only if login fails)

```bash
.venv/bin/tegg portal probe-login --headed
```

Prints the sign-in page's real structure — every frame, label, input and button
— and shows which controls a real sign-in would use. **It needs no credentials
and types nothing**, so it is always safe to run and its output is safe to
share.

Use it whenever login fails with "the sign-in form could not be located". The
portal's field wording has changed before: it labels the username field
`Please enter email address/username`, not `User Id`, and its button reads
`Sign in`, not `Log In`.

To diagnose a sign-in that submits but does not get through:

```bash
.venv/bin/tegg portal probe-login --submit --headed
```

This signs in for real and reports what the portal did: the URL and title
afterwards, any visible error message and what it means, cookies before and
after, the sign-in responses and redirect chain, iframes, and any extra fields
on the form. **The password is never printed, saved or screenshotted, and your
username is redacted from every saved file.**

It names the cause rather than guessing — invalid credentials, locked account,
expired password, MFA, CAPTCHA, or a missing required field — so you know
whether it is something you can fix or something for the portal administrator.

### Contractor is required

The sign-in page has a **required** Contractor dropdown. If it is not set, the
form silently refuses to submit and it looks like a credential failure. Yours is
configured in `config/workflow.yaml`:

```yaml
portal:
  contractor: "Lippolis"      # matches the option "TEGGPro Lippolis"
```

A short name is fine — it matches the `TEGGPro `-prefixed option. If it matches
none, or more than one, the run stops and lists the valid options.

### 1. See what is ready to report on

```bash
.venv/bin/tegg portal list-completed
```

Prints every **completed** site visit with its identifier, date and customer:

```
2 completed site visit(s):

  [71999]  05/14/2026  Acme Manufacturing  Plant 3 - Toledo
  [72104]  06/02/2026  Borden Foods  Cold Store 2
```

Read-only — it downloads nothing.

### 2. Look at one site visit before committing to it

```bash
.venv/bin/tegg portal inspect --site-visit 71999
```

Shows what that site visit offers, which documents were recognised, and which
required reports were **not** found. Still downloads nothing. Use this when a
run reports something missing.

### 3. Build the report

```bash
.venv/bin/tegg run --site-visit 71999
```

This signs in, opens that one site visit, downloads the certificate and the six
reports, converts the certificate, splits the IR cover off, and merges all ten
sections in the required order.

Add `--headed` to watch the browser work. Useful the first time, or when
something is not being found.

### 4. Check on a job

```bash
.venv/bin/tegg status                       # list all jobs
.venv/bin/tegg status --job-id 71999-20260729
```

### 5. Carry on after a failure

```bash
.venv/bin/tegg resume --job-id 71999-20260729
```

Anything already downloaded is **not** downloaded again. Only what is still
missing is fetched. If everything is already present, it does not open the
browser at all.

Add `--force` to re-download everything from scratch.

---

## What you get

```
work/jobs/71999-20260729/
  manifest.json     what was downloaded, from where, when, and its checksum
  source/           the original downloads, never modified
  converted/        the certificate as PDF, the split IR cover and body
  output/           the finished report
  evidence/         screenshots and page snapshots from the portal
  logs/
```

Keep the whole folder. `manifest.json` is the audit trail — it records every
source file, how it was matched, its checksum and page count. An ESA report can
be referenced in a warranty or insurance dispute years later.

---

## The certificate

**The tool does not tick the certificate boxes.** It downloads the certificate,
converts it, and includes it in the report unchanged.

The reason is in the document itself. The TEGG certificate's checkboxes are not
form fields — they are Wingdings characters, two per line (one for Yes, one for
No), across eleven items. There is no reliable way to set them automatically
without risking the wrong box being ticked on a customer-facing legal
attestation. So it does not guess.

Every report is therefore produced as a **DRAFT**, watermarked and named
`DRAFT - ...`, and the run finishes by telling you:

```
HUMAN REVIEW REQUIRED before this goes to the customer:
  - certificate checkboxes were not edited automatically: ...
    Tick section B by hand before sending.
```

To see exactly what a certificate contains:

```bash
.venv/bin/tegg certificate-inspect work/jobs/<job-id>/source/Certificates71999.doc
```

Once you have ticked the boxes by hand and are happy with the report, it is
ready to send. There is no "approve" step in the tool.

---

## When something goes wrong

Everything fails with a sentence, not a stack trace, and nothing is half-built:
if a required section is missing, no report is written at all.

| What you see | What it means | What to do |
|---|---|---|
| `TEGG_USERNAME and TEGG_PASSWORD must be set` | Credentials not exported | See [Credentials](#credentials) |
| `the sign-in form could not be located` | The page structure changed | `tegg portal probe-login --headed` |
| `login did not complete` | Wrong credentials, or the contractor was rejected | Check them; then look in `evidence/` |
| `requires a contractor to be chosen` | `portal.contractor` unset in config | Set it — see [Contractor is required](#contractor-is-required) |
| `contractor 'X' is not one of the N options` | Name does not match any option | Use one of the listed names |
| `no completed site visits were found` | The Documentation page did not list any | Run with `--headed` and check `evidence/` |
| `N completed site visits are available and none was chosen` | You omitted `--site-visit` | Re-run with the identifier |
| `refusing to continue against the wrong context` | The page opened was not the site visit asked for | Report it — this is the safety catch working |
| `the portal session expired` | Signed out mid-run | `tegg resume --job-id <id>` |
| `BUILD BLOCKED -- N required section(s) missing` | A report could not be produced | `tegg portal inspect --site-visit <id>` to see why |
| `currently no agreements` in the evidence | The company-level Reports page was reached | This page is a dead end; the site-visit route is the correct one |

### The evidence folder

Every run writes `evidence/observations.json` plus a screenshot, an HTML
snapshot and a control inventory for each page it reached. If a run cannot find
something, that folder shows exactly what the page actually contained.

If the portal's wording differs from what the tool expects, it is a **config
change, not a code change**. Edit the `portal:` block in
`config/workflow.yaml`:

```yaml
portal:
  documentation_labels: ["Documentation", "Documents"]
  document_library_labels: ["Document Library", "Documents"]
  certificate_labels: ["Certificates", "Certificate"]
  report_routes: []        # extra links to follow inside a site visit
```

---

## What the tool will never do

By design, it cannot: send email, upload the report anywhere, change anything
in the portal, mark a site visit complete, edit an agreement, or delete
anything. It signs in, reads, and downloads. Everything else happens on your
machine, and sending the report to the customer stays a human decision.
