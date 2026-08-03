# Operational knowledge

An agent works out how to sign into the portal, which label finds the password
field, and that opening a site visit hands off through an SSO interstitial
before it settles. Then the session ends, and the next agent works it all out
again.

This is the layer that stops that. It is not a notes file: every fact in it
carries evidence, a trust level, a version, and a history of what changed it.

    src/awe_knowledge/           the layer (integration-neutral)
    src/awe_knowledge/adapters/  one module per integration
    data/operational_knowledge/  the store, committed and reviewable
    tests/knowledge/             what the rules actually guarantee

---

## The loop

```
live run  ->  evidence  ->  observation  ->  validation  ->  approval (when needed)
   ^                                                              |
   |                                                              v
outcome  <-  applied by a later run  <-  retrieved  <-  versioned storage
```

Each arrow is a function, not a convention:

| Step | Where |
|---|---|
| evidence capture | the TEGG driver's `observations.json`, `evidence.build_evidence` |
| observation | `KnowledgeRun.observe`, `adapters.tegg_portal.ingest_observations` |
| validation | `validator.validate_document`, run on every `KnowledgeRun.open` |
| approval | `lifecycle.propose_change` / `decide_pending`, `tegg knowledge approve` |
| storage | `store.KnowledgeStore.save` — atomic write plus append-only history |
| retrieval | `KnowledgeRun.usable`, `KnowledgeRun.applicable` |
| application | `KnowledgeRun.resolve` |
| outcome | `promotion.record_success` / `record_failure` |
| reinforcement, correction, supersession, expiry | `promotion`, `lifecycle` |

---

## Two axes, never collapsed

**Trust** answers *how sure are we*:

| Level | Means | May a run use it? |
|---|---|---|
| `DISCOVERED` | an observation — seen once | no |
| `CANDIDATE` | a hypothesis — worked once, with evidence | only if the run opts in |
| `VERIFIED` | a fact — distinct runs keep confirming it | yes |
| `DEGRADED` | a fact that stopped holding | no — rediscover |
| `INVALID` | written off | no — re-observe deliberately |

**Kind** answers *what is it about*: `integration`, `auth`, `navigation`,
`selector`, `procedure`, `policy`, `failure`. A policy can be a hypothesis; a
selector can be a fact. The axes are independent.

### How trust moves

```
DISCOVERED --one success with evidence--> CANDIDATE
CANDIDATE  --a second, DISTINCT execution--> VERIFIED
VERIFIED   --one failure--> DEGRADED
DEGRADED   --a failure from another execution--> INVALID
INVALID    --observe()--> DISCOVERED   (never straight back to VERIFIED)
VERIFIED   --past its expiry--> CANDIDATE
```

Four refusals hold this together, and each has a test:

- A success with no usable evidence raises `EvidenceRequired`.
- The same execution voting twice counts once. Two successes inside one run
  cannot reach `VERIFIED`.
- Two failures inside one run cannot reach `INVALID` either. Demotion is
  cheap; writing knowledge off is not.
- An observation that contradicts a `VERIFIED` record is **queued**, not
  applied. Someone has to decide.

---

## What is never stored

Usernames, passwords, tokens, cookies, session ids. Every save is screened by
`evidence.reject_secrets`, which walks the whole document and refuses the
write if it finds a secret-shaped key, a credential-shaped value, or a live
value from `TEGG_USERNAME` / `TEGG_PASSWORD`.

What *is* stored is where the credential goes:

```json
"password_selector": "input[type=password][name=password]",
"credential_source": "the TEGG_PASSWORD environment variable"
```

Customer detail is kept out the same way. URLs are generalized
(`/work/3075/968/5033/0` → `/work/<id>/<id>/<id>/<id>`), and screenshots and
page captures stay in the gitignored `work/` tree with the record pointing at
them rather than carrying them.

---

## Capturing lessons from a TEGG live run without credentials

The live driver already writes an `observations.json` beside its evidence.
That file — not an agent's recollection — is the input:

```bash
tegg portal inspect --site-visit 'T26-XXX' --headed     # writes work/<run>/observations.json
tegg knowledge ingest --observations work/<run>/observations.json
tegg knowledge inspect
```

`ingest` needs no credentials, no browser and no network. Each observation
becomes a record; each successful step is a success against that record; each
failed step degrades **only** the record it was about.

Execution ids come from the run's own first timestamp, so re-ingesting the
same file cannot inflate a record towards `VERIFIED`.

---

## Commands

```bash
tegg knowledge inspect [--kind selector] [--trust VERIFIED] [--json]
tegg knowledge validate                       # exit 1 if the store is unusable
tegg knowledge degraded                       # the queue of real work
tegg knowledge pending                        # changes waiting on a person
tegg knowledge changes [--limit 10]           # the append-only history
tegg knowledge approve --record <id> --by <name> [--reject]
tegg knowledge invalidate --record <id> --reason "..." --by <name>
tegg knowledge restore --record <id> --by <name>       # last known good
tegg knowledge export --out handoff.json
tegg knowledge ingest --observations <path>
```

`--tenant`, `--integration`, `--environment` and `--root` are on every one of
them; they default to `lippolis / tegg-pro / production`.

---

## Using it from code

```python
from awe_knowledge import KnowledgeStore
from awe_knowledge.adapters import tegg_portal

store = KnowledgeStore()
run = tegg_portal.open_run(store, execution_id="2026-07-31T12:00:00+00:00")
run.open()                       # loads, validates, expires

outcome = run.resolve(
    "selector:login.username",
    attempt=lambda payload: driver.fill(payload),      # try what we know
    discover=lambda: driver.find_username_field(),     # only if that failed
)

report = run.close(note="live login")
print(report.used, report.rediscovered, report.pending_approval)
```

`resolve` is the whole point: it tries stored knowledge first, and reaches for
rediscovery only after the stored value has actually failed. One selector
failing repairs one record. Nothing else in the document is touched.

---

## The store on disk

```
data/operational_knowledge/<tenant>/<integration>/<environment>/
    knowledge.json     the current document, sorted keys, stable bytes
    history.jsonl      one line per save: what changed, why, which execution
```

JSON so a change in what the system believes shows up as a reviewable diff.
Byte-stable so a diff means a real change and not a reordering. The tenant
boundary is enforced when the file is *read*, against the file's own contents
— moving a document into another tenant's directory does not make it readable
there.

Every timestamp is injected. With a fixed clock, two identical runs produce
byte-identical files, which is what makes a replay a real check.

---

## Current TEGG knowledge

Seeded from three live executions on 2026-07-30 (evidence under `work/`,
gitignored). Ten records are `VERIFIED` — confirmed by all three runs — and
four are `CANDIDATE`, seen by one run only:

| Trust | Records |
|---|---|
| `VERIFIED` | the three sign-in selectors, the login form and its result, the contractor picker, the Documentation area, the visit timeframe, the visit list and its pagination |
| `CANDIDATE` | opening a site visit (SSO hand-off, interstitial, trailing-id-path check), the visit's action inventory, its Documentation area, its document list |

Run `tegg knowledge inspect` for the current state. Nothing in it was asserted
by an agent; each record names the executions that vouch for it.
