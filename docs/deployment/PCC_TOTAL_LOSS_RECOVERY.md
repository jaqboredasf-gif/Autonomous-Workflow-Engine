# If the server dies tomorrow

**The one question the rest of the deployment documentation does not answer.**

`docs/deployment/PCC_PRODUCTION_ACCEPTANCE.md` §I covers rollback — something went wrong *on a
machine you still have*. `PCC_VM_INSTALLATION_RUNBOOK.md` covers a first install onto a fresh
machine that has never held data. This covers the case in between and worse than both: **LIPELE-RDS02
is gone, and the purchasing records have to come back onto something else.**

It is written now, before there is anything to lose, because a recovery order invented on the day is
a recovery order that restores the database before the environment file and discovers at 4pm that
nobody wrote down which organization id the records were created under.

---

## What actually holds state

Six things exist. Only two of them cannot be rebuilt from this repository, and one of those is a
five-minute regeneration.

| # | Thing | Where it lives | Rebuildable? | If lost |
|---|---|---|---|---|
| 1 | **Application code** | this repository, commit named in `deployment/APPROVED_RELEASE.md` | **yes** — clone and build, or re-copy the release `.zip` | nothing; it is not state |
| 2 | **The database** | Windows `C:\ProgramData\pcc\data\pcc.sqlite` · Linux `/var/lib/pcc/pcc.sqlite` (plus `-wal`, `-shm`) | **NO** | every request, purchase order, receipt and audit row. This is the company's record |
| 3 | **Uploaded and generated files** | **inside the database** — attachments and receipt images are rows, not files on disk | **NO**, and see below | the same loss as #2; there is no second place to check |
| 4 | **Configuration** | Windows `C:\ProgramData\pcc\pcc.env` · Linux `/etc/pcc.env` | **partly** — the template is `config/production.env.template`; the *values* are Lippolis's | see §"The two values nobody can guess" |
| 5 | **Secrets** | `SESSION_SECRET` in the same env file | **yes** — regenerate | everybody is signed out once. **No data loss.** Rotating it is a mild inconvenience, not an incident (`PCC_SECRETS_CHECKLIST.md` §1) |
| 6 | **Evidence / measurement records** | **inside the database** — every execution, timestamp and actor | **NO** | the case for what PCC did. It cannot be reconstructed from paper afterwards |

**Read #3 twice.** Attachments are stored *in* the SQLite file, not beside it. That is convenient —
one file is the whole backup — and it is a trap for anyone who assumes there is a separate uploads
directory worth copying. There is not. **Backing up `pcc.sqlite` backs up the attachments. Backing
up everything *except* `pcc.sqlite` backs up nothing that matters.**

**And read #6 twice.** Evidence is not a separate artifact either. It is the same rows. A database
lost is a case study lost, and no amount of engineering afterwards recovers it.

## What must therefore be backed up

**One file, taken correctly, plus one small text file.**

1. **`pcc.sqlite`, via `scripts/pcc-backup.mjs`** — never by copying the file. The store runs in WAL
   mode, so the committed-but-uncheckpointed transactions live in `-wal`; copying the `.db` alone
   silently drops exactly the most recent work, and copying all three while the app writes gives a
   torn set. `pcc-backup.mjs` uses SQLite's own `VACUUM INTO`, which produces one complete,
   already-checkpointed file while the application keeps serving.
2. **The environment file** — `pcc.env`. It is small, it is not in git, and it holds the two values
   below. Lippolis IT decides where a copy of it lives; it contains a secret, so it belongs wherever
   their other secrets do, not next to the database backups.

Everything else is in git.

### The two values nobody can guess

`PCC_ENVIRONMENT` and `PCC_ORG_ID` are fixed **when the database is created** and are what make the
records measurable. A restored database carries its own stamp; a *rebuilt* one does not, and there
is no way to re-stamp it afterwards — which is the whole reason `pcc-verify-deployment.mjs` reports
`measurement.environment` on every run. Write both into the installation record on day one.

## The order, when the server is gone

Do these in this order. The order is the point: each step is verifiable before the next one can
destroy evidence that it failed.

| # | Step | Why here and not later |
|---|---|---|
| 1 | **Stand up a host** — Windows Server 2019+, Node at the version `PCC_VM_INSTALLATION_RUNBOOK.md` names | nothing else is possible first |
| 2 | **Recover the newest usable backup**, and *verify it before trusting it*: `node scripts/pcc-backup.mjs --db <the backup copy> --check` | a backup that does not open is discovered now, while there is still time to reach for an older one — not after it has been installed as the live database |
| 3 | **Deploy the approved commit** — the one named in `deployment/APPROVED_RELEASE.md`, built per that record | the application before the data, so a startup refusal happens against an empty path rather than over the company's records |
| 4 | **Restore the environment file**, or rebuild it from `config/production.env.template` plus the installation record. Regenerate `SESSION_SECRET`; carry `PCC_ENVIRONMENT` and `PCC_ORG_ID` across **unchanged** | PCC refuses to start without these, and it refuses *before* touching a database. A wrong org id here is unrecoverable later |
| 5 | **Put the database in place** with `scripts/pcc-restore.mjs` — with the service stopped. It verifies integrity before touching anything and, with `--force`, moves any existing file aside as `.replaced-<timestamp>` rather than deleting it | restoring into a running server lets two processes disagree about the file |
| 6 | **Start the service and verify**: `node scripts/pcc-verify-deployment.mjs --strict` | this is the step that says whether the recovery worked. `release.approved` confirms the build matches the record; `measurement.environment` confirms the restored database is still stamped production |
| 7 | **Re-arm the backup schedule** — `scripts/install-backup-task.ps1` on Windows, the timer unit on Linux — and prove it by taking one backup by hand | a recovered server with no backup schedule is the same accident, queued up again. This is the step most likely to be skipped because the crisis is over |
| 8 | **Tell the office what window was lost**, from the backup's timestamp | purchases raised between the last backup and the failure are not in the system. Somebody has to re-enter them, and they need to know how far back to look |

**Do not skip step 2 by restoring straight from the newest file.** The failure that destroyed the
server is exactly the kind that corrupts the most recent backup.

## What this does not cover

**Whether a usable backup exists at all.** `storage.backed_up_by_customer` is an open blocker: the
backup platform has not been named. `pcc-backup.mjs` makes one good file — retention, offsite copies
and encryption belong to whatever Lippolis IT already runs, and until that is named, **the honest
answer to "how far back can we recover" is "we do not know."**

**Whether this procedure works.** It has never been carried out. `scripts/restore-rehearsal.sh`
proves a restore into a throwaway instance and is the closest thing to evidence; a real drill on the
real server, once, before the first production purchase, is what would make this document trustworthy
rather than merely correct.
