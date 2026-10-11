# Production evidence return

How production purchasing records get from RDS02 to where `npm run plan`, the case study and
`npm run evidence` run — and the one command that receives them.

## Why this route exists

RDS02 has no outbound network at runtime (`docs/deployment/PCC_RDS02_EXECUTION_PACKAGE.md` §7).
Plan and the case study read the purchasing database only through `--db`, a local file. So the
records do not travel by themselves: a person carries a copy. This page fixes who, how, where it may
live, and what checks it on arrival, so the route is the same every time.

## What is copied

The **nightly backup**, never the live database. `PCC Nightly Backup` (scripts/install-backup-task.ps1)
runs `scripts/pcc-backup.mjs` at 01:30 local time and writes one self-contained, already-checkpointed,
integrity-checked file:

    C:\ProgramData\pcc\data\backups\purchasing-<UTC stamp>.sqlite

Copying the live `purchasing.db` (with its `-wal` / `-shm`) gives a torn or incomplete copy; the intake
command refuses a file that has those sidecars beside it.

## Who, on what medium

1. **Who.** The Lippolis IT administrator with RDS02 access, or the AWE operator sitting with them.
   Nobody copies it without the administrator's knowledge — it is the company's purchasing record.
2. **Check it first, on RDS02:** `node scripts\pcc-backup.mjs --check latest` must say `verified`.
3. **Medium.** Copy the newest backup file onto an encrypted USB drive (BitLocker To Go) or the
   company's own encrypted file share, as Lippolis IT directs. Not email, not a personal cloud drive,
   not a chat attachment.
4. **Where it may live.** On the operator's machine, in a directory **outside** any clone of this
   repository (for example `~/pcc-evidence/2026-10-11/`), on an encrypted disk. Delete working copies
   once the period's evidence is recorded; the backup on RDS02 remains the record.

## It never enters git

The backup contains names, vendors, prices and job numbers. It is never committed, never placed
inside the repository working tree, and never attached to an issue or pull request. The intake command
refuses any path inside the repository, including one reached through a symlink, and it writes its own
output only under `.awe/production/` (gitignored).

## The command

Copy the verified backup off RDS02 to a local directory, then bring the copied database to plan, case study and evidence with one command:

    node scripts/awe-production-intake.mjs --from ~/pcc-evidence/2026-10-11/purchasing-20261011T013000Z.sqlite \
         --org <organization id> --label lippolis-2026-10 \
         --from-date 2026-09-01 --to-date 2026-10-01

(`npm run production:intake -- --from … --org …` is the same command.)

What it does, in order, and the reason it names on stderr when it refuses (exit 2):

| Check | Refusal names |
|---|---|
| The path, resolved through symlinks, is outside the repository | `repository` |
| No `-wal`/`-shm`/`-journal` beside it; `pragma integrity_check` is `ok`; `orgs`, `purchase_requests`, `purchase_orders` readable — the same check as `pcc-backup --check` | `integrity` |
| `schema_meta.environment` is `production` (a rehearsal or unstamped database is refused) | `rehearsal` / `unstamped` |
| The declared `--org` exists in its `orgs` table | `organization` |

The decision comes only from what the file says about itself — never its name or location.

It never opens the source with SQLite: it hashes the file, analyses a private byte-identical working
copy, deletes that copy, and re-hashes the source to prove it was untouched (no sidecar is created).

On acceptance it prints what the copy is (counts, the date range of requests, the schema release),
runs `npm run plan -- --db <copy> --org <org> --json` and `proof-case-study --db <copy> --org <org>`
(with the period when `--from-date`/`--to-date` are given), and writes:

    .awe/production/<label>/intake.json      awe.production-intake/1: source sha256 and bytes,
                                             environment, org, counts, analyses[{name, exit_code, output}]
    .awe/production/<label>/plan.json
    .awe/production/<label>/case-study.json

An analysis that exits non-zero (for example a case study with no period) is recorded with its exit
code; it does not undo the intake. A refusal writes no intake record.

## After the intake

`intake.json` records the sha256 of the copy that was analysed, so a figure quoted later can be tied
to exactly one backup. Readiness bands do not move because an intake ran; they move when the
artifacts they name exist (see `npm run evidence`).
