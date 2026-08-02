# Dispatch Task Format

**Version:** 1 · **Added:** 2026-08-01

A dispatch task is a file. There is no daemon, no queue server, and no worker
process in this version — a task is a Markdown file with a fenced metadata block,
and "dispatching" means a human or an agent reads it. That is deliberate: a
file-based queue can be reviewed in a diff, and cannot lose work when a process
dies.

A task's job is to be **compilable**. Every field below either bounds the work or
feeds `npm run context:compile`, so a queued task can be turned into a full
execution packet without anyone re-typing its objective.

---

## Fields

| Field | Required | Purpose |
|---|---|---|
| `task_id` | yes | `AWE-INT-NNN`. Unique; `context:check` flags duplicates. |
| `objective` | yes | One sentence, imperative. **Passed verbatim to the compiler**, so it is also the relevance query — name the migration slot, the branch, the package. |
| `capability` | yes | Which capability this belongs to. Passed as `--capability`. |
| `priority` | yes | `P0`–`P3`. |
| `status` | yes | `QUEUED` · `ACTIVE` · `BLOCKED` · `DONE`. |
| `depends_on` | yes | Task ids, or `none`. |
| `blocked_by` | yes | External blocker (Docker, MacBook access, a human decision), or `none`. |
| `allowed_scope` | yes | Paths the task may create or modify. Everything else is out of bounds. |
| `forbidden_actions` | yes | Task-specific prohibitions, **in addition to** the universal set the compiler injects into every packet. |
| `packet_path` | yes | Where the compiled packet lives: `.awe/packets/<task_id>/`. Ignored by Git — regenerate, never commit. |
| `assigned_role` | yes | `Scout` · `Builder` · `Verifier` · `Integrator` · `Documentarian`. |
| `required_tests` | yes | Exact commands. |
| `completion_evidence` | yes | What must exist for this to be `DONE` — output paths, not adjectives. |
| `handoff_path` | yes | Normally `context/LATEST_AGENT_HANDOFF.md`. |

## Generating a packet from a task

```bash
npm run context:compile -- --objective "<objective>" --task-id AWE-INT-101 --capability migration-identity --output .awe/packets/AWE-INT-101
```

The compiler adds what the task deliberately does not carry: repository identity,
current Git state, the mandatory operating policies, the universal forbidden
actions, known blockers, and a source manifest explaining why each context item
was selected. **A task states intent; a packet states grounded context.** Keeping
them separate is what stops a task file from rotting into a stale mini-handoff.

## Rules

1. A task never contains a claim about repository state — that is the compiler's
   job, and a copied claim goes stale silently.
2. `packet_path` output is never committed (`.awe/` is gitignored).
3. Status changes are edits to the task file, visible in the diff.
4. A task with `blocked_by` other than `none` must not be started; record the
   blocker rather than working around it.
5. No task in this version executes automatically. Dispatch is a human act.
