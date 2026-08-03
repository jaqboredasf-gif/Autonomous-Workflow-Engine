# Runbook — `documentation-read`

Read the TEGG Documentation area and list the completed site visits.

**Read-only.** It signs in, reads, and stops. It never submits a form, never
downloads a report, never marks anything complete, never sends anything, and
never deletes anything. The one thing it touches is the list's own timeframe
dropdown, which is a view filter the portal does not keep — and it tells you it
did that, every run, under "external changes performed".

You do not need Claude Code, or any AI tool, to run this.

---

## Once, on a new machine

```bash
cd ~/TEGG
python3 -m venv .venv
.venv/bin/pip install -e '.[portal,dev]'
.venv/bin/python -m playwright install chromium
```

## Every time

**1. Put the credentials in your terminal.** Type them; do not put them in a
file, and do not paste them into a chat window. They are used to sign in and
are never written to disk by this tool.

```bash
export TEGG_USERNAME='your portal username'
export TEGG_PASSWORD='your portal password'
```

**2. Check the machine is ready.**

```bash
cd ~/TEGG
.venv/bin/python -m awe_tegg preflight --service-file config/service.documentation-read.yaml
```

You want four `OK` lines. If something says `MISSING`, that line tells you what
to do about it.

**3. Run it.**

```bash
./scripts/documentation-read.sh
```

or, the same thing spelled out:

```bash
.venv/bin/python -m awe_tegg run documentation-read \
  --service-file config/service.documentation-read.yaml
```

Add `--headed` if you want to watch the browser do it. It takes about a minute;
most of that is paging through the visit list.

---

## What you get back

```
run id                  documentation-read-20260731T163012+0000
status                  completed  (finished, read-only, nothing left to do)
steps completed         7/7
    done  open_knowledge
    done  sign_in
    done  locate_workspace
    done  reach_documentation
    done  verify_documentation
    done  list_records
    done  finish

records found           121
    read from 20 page(s) of the documentation list (12 row(s) per page)
    T26-170  New York College of Podiatric Medicine  8/31/2026  [Completed]
    ...

knowledge used
    procedure:documentation-read.reach-documentation  v3  (VERIFIED)

stale knowledge detected
    none -- everything the run believed still held

corrected knowledge created
    none -- nothing needed correcting

human action required
    none

external changes performed
    client-side view filter: list timeframe set to 'All Site Visits'
    (nothing submitted, nothing kept by the portal)

safe resume command     python -m awe_tegg resume --run-id <run id>
evidence                work/operations/<run id>/evidence
```

The full list of records, the screenshots and the page captures are in the
evidence folder. That folder names real customers, so it stays on your machine
— it is never committed.

### Exit codes, if you are scripting this

| code | meaning |
|-----:|---------|
| `0` | finished, read-only |
| `1` | could not continue |
| `2` | stopped and needs a person — read "human action required" |

---

## The four lines to actually read

**`status`** — `completed` means it finished. Anything else is explained by the
next three.

**`human action required`** — if this is not `none`, that is your job list. The
run stopped on purpose rather than guessing. Nothing was changed in the portal.

**`stale knowledge detected`** — the tool believed something about the portal
that turned out not to hold any more. This is normal and healthy; it means the
tool noticed instead of failing quietly. It says which belief and why.

**`corrected knowledge created`** — the tool worked out the current answer and
wrote it down. The next run will use it and be faster. Nothing for you to do.

---

## If it stops part-way

Every verified step is written to disk the moment it is verified, so an
interrupted run is never wasted. Close the laptop, lose the network, kill the
terminal — the answer to "how far did it get" is on disk.

```bash
.venv/bin/python -m awe_tegg status            # every run, and where each got to
.venv/bin/python -m awe_tegg resume --run-id <run id>
```

Resume signs in again — a browser session cannot be saved — and then carries on
from the last verified step. It does **not** redo the expensive part: if the
run had already worked out where the Documentation area lives, that is already
written down and is not worked out twice.

**Resuming a run that already finished does nothing at all.** It reprints the
answer, in about a tenth of a second, without opening a browser and without
touching the portal. That is deliberate: re-reading a customer's records for no
reason is not free.

---

## When it needs you

### "no route proved to be the Documentation area"

The portal moved the area somewhere the tool could not find from the navigation
it was shown. Nothing was changed. Open the portal by hand, find where
Documentation now lives, and tell whoever maintains this tool — the fix is one
line of knowledge, not a code change.

### "TEGG_USERNAME and TEGG_PASSWORD not set"

Step 1 above, in *this* terminal. Each terminal window is separate.

### "the portal rejected the credentials"

Sign in to the portal in a normal browser first. If that works and this does
not, the account may have picked up a second-factor prompt — this tool cannot
answer one, and says so rather than retrying.

### "signed in, but the page never named the Lippolis workspace"

The sign-in landed in a different contractor's workspace. The run refuses to
read anything at that point, on purpose. Check which account is being used.

---

## What it is allowed to do, and what it is not

| | |
|---|---|
| sign in | yes |
| read pages, links, tables | yes |
| set the list's own timeframe filter | yes — reported every run |
| navigate, at most 12 pages, within 2 minutes, on `tegg2.teggpro.com` only | yes |
| click, type, submit, download, delete | **no — refused in code, not by convention** |
| save a password, cookie, token or session | **no** |
| use another contractor's knowledge | **no — refused** |

The "refused in code" ones are not policy. The object the discovery step is
given has no `click`, no `fill` and no `submit` on it; asking for one raises.
There are tests that try all of them.

---

## Where things live

| | |
|---|---|
| this run's ledger, evidence, screenshots | `work/operations/<run id>/` |
| what the tool believes about the portal | `data/operational_knowledge/lippolis/tegg-pro/production/` |
| every change to those beliefs, with why | `.../history.jsonl` |
| the non-secret service settings | `config/service.documentation-read.yaml` |

To see what the tool currently believes, and what it has stopped believing:

```bash
.venv/bin/tegg knowledge inspect
.venv/bin/tegg knowledge degraded      # the work queue, if anything broke
.venv/bin/tegg knowledge changes --limit 3
```

---

## What this does not do yet

It lists the completed site visits. It does **not** open one, download the
certificate, pull the ESA reports, or build a report. Those steps exist in this
repository (`tegg run --site-visit <id>`) but have not been through the same
live proof, so they are not part of this operation and are not offered here.
