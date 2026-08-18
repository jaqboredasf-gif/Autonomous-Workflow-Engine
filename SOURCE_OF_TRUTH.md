# Which code is PCC? — read this before cloning anything

**Clone this, and nothing else:**

```bash
git clone --branch pcc-production <repository-url> pcc
cd pcc
git log -1 --format='%h %ad %s' --date=short      # what you are about to deploy
```

**`pcc-production` is the only branch that should ever be installed on a server.**

Everything else in this repository is history, parallel experiments, or the platform work PCC grew
out of. None of it is wrong; none of it is what runs at Lippolis.

---

## Why this file exists

The repository's **default branch is `main`, and `main` does not contain PCC at all** — no
`apps/purchasing`, no Dockerfile, no deployment units, no runbook. A plain `git clone` with no
`--branch` gives you that. There is also a branch called `claude/purchasing-control-center`, whose
name reads like the obvious one and which is **eight days older than the production work**: it has
the purchasing application but none of the packaging, none of the startup safety, and none of the
deployment documentation.

So the two most natural things an operator would do — clone the default, or clone the
plausibly-named branch — both produce code that cannot be deployed, and neither fails in a way that
says so. Hence one file, at the root, naming one branch.

## What the other branches are

| Branch | What it is | Deploy it? |
|---|---|---|
| **`pcc-production`** | **The production line.** The purchasing application, the Dockerfile, the systemd units, the install script, backup/restore/recovery tooling, and every deployment document | **Yes — this one** |
| `claude/pcc-production-2026-08-18` | The same commits, pushed under a dated name on 18 Aug 2026 before `pcc-production` existed. Kept so nothing published disappears | No — identical content, retiring name |
| `claude/purchasing-control-center` | The earlier codex line, last updated 10 Aug 2026. Carries a `purchase_line_history` **view** that migration `0030` on the production line deliberately replaced, because a view over live entities rewrote past purchases whenever a vendor was renamed | No — superseded |
| `main` | Platform scaffolding from July 2026. No purchasing application | No |
| `codex/*`, `security/*`, `feat/*`, other `claude/*` | Development history and parallel experiments | No |

**Nothing is being deleted.** `claude/purchasing-control-center` and its merged pull requests stay
exactly where they are; the production line simply does not descend from its last two commits, and
re-merging them would reintroduce a design that was already replaced on purpose.

## How to check that a running server matches this branch

Set `PCC_RELEASE` in the environment file to the commit being deployed, and `/api/health` will
report it back:

```bash
git -C /path/to/clone rev-parse --short HEAD     # what the checkout is
curl -fsS https://<pcc-address>/api/health       # "release": what is actually running
```

Unset, `release` reads `null`, which means nobody can tell which build is on the server without
guessing from file dates. Set it.

---

## When the code moves to a Lippolis-controlled repository

The current remote is a personal GitHub account. It is an interim location, and the migration is
deliberately small — nothing about PCC depends on where the repository lives.

**Whoever performs the migration, in this order:**

1. **Create the empty repository** under the Lippolis organization or account. Private.
2. **Push the production line first, and name it as the default:**
   ```bash
   git remote add lippolis <new-repository-url>
   git push lippolis pcc-production
   ```
3. **Set the default branch to `pcc-production` in the new repository's settings.** This is the
   step that makes a bare `git clone` correct, and it is the whole reason this file is long. Do it
   before anybody clones.
4. **Push the history worth keeping**, so nothing is lost:
   ```bash
   git push lippolis --all
   git push lippolis --tags
   ```
5. **Confirm a clean clone is deployable** — on a different machine, or a different directory:
   ```bash
   git clone <new-repository-url> verify && cd verify
   git log -1 --format='%h %s'          # must match the tip of pcc-production
   ls Dockerfile deploy/ PCC_VM_INSTALLATION_RUNBOOK.md
   ```
6. **Update the remote named in the runbook and in this file**, commit, push.
7. **Confirm at least two people at Lippolis have access**, and that access does not depend on any
   individual's personal account. This is the point of the migration; steps 1–6 are mechanics.

Until step 3 is done, **every instruction that clones this repository must pass `--branch
pcc-production` explicitly.** The installation runbook does.
