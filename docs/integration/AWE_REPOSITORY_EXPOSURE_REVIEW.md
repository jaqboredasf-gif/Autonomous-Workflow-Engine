# AWE Repository Exposure Review

**Date:** 2026-08-02 · **Repository:** `jaqboredasf-gif/Autonomous-Workflow-Engine` — **PUBLIC**
**Method:** filename classification, structural probes, and field-shape inspection.
**No sensitive value is reproduced in this document.** Where content had to be characterized, it was
done by counting shapes (is a name-shaped literal present? is the domain reserved?) rather than by
quoting.

**Nothing was deleted, rewritten, sanitized, or moved. Repository visibility was not changed.**

---

## 1. Headline

**The exposure is materially smaller than the filename scan suggests — but it is not zero, and the
part that remains is the part filenames cannot detect.**

39 tracked files carry names suggesting internal or personal material. Probing them:

- **The email fixtures are demonstrably synthetic.** All 12 cases carry `is_fixture: true`, every
  sender domain is a reserved/example domain, and all share one fixed test `org_id`. This is
  well-constructed test data, not captured mail.
- **The payroll and employee pages contain no personal data.** Zero name-shaped literals in either;
  they are UI and schema against a database, and the database is not in the repository.
- **The genuine exposure is the 20 planning documents**, which describe a named real business's
  operations, stakeholders, and permission structure in prose. That is not sensitive because of a
  filename; it is sensitive because of what it says.

## 2. Category assessment

| Category | Files | Evidence path (representative) | Likely sensitivity | Confidence | Synthetic or real? | Recommended action |
|---|---|---|---|---|---|---|
| **Email fixtures** | 14 | `fixtures/emails/` | **Low** | **High** | **Synthetic** — 12/12 `is_fixture: true`; all sender domains reserved; single fixed test `org_id` | **Safe to remain public.** Well-built fixtures; no change needed. |
| **Employee / payroll UI** | 4 | `apps/web/src/app/{payroll,employees,timesheets}/page.tsx`, `api/employees/route.ts` | **Low** | **High** | **Schema only** — 0 name-shaped literals | **Safe to remain public.** Reveals a data model, which is ordinary for an application repository. |
| **Timecard migration** | 1 | `supabase/migrations/0010_timecard_corrections.sql` | **Low** | High | Schema only | **Safe to remain public.** |
| **Business identity** | 17 | "Lippolis" in 12 fixtures + 5 documents | **Medium** | High | Real company name | **Requires human review.** Naming a real client in a public repository is a commercial and relationship decision, not a technical one. |
| **Stakeholder & permission structure** | 2 | `docs/planning/STAKEHOLDERS_AND_PERMISSIONS.md`, `BOSS_INTERVIEW.md` | **Medium–High** | High | **Real** — an interview with a named business owner and that business's internal permission model | **Requires human review.** Strongest candidate for removal or privacy. |
| **Internal planning corpus** | 20 | `docs/planning/*.md` | **Medium** | High | Real operational reasoning about a real client | **Requires human review** as a set. |
| **Operational workflow detail** | — | `docs/AUTOMATION_SYNERGY.md`, `docs/planning/{CURRENT_WORKFLOW,USER_WORKFLOWS,WORKFLOW_MAPS}.md` | **Medium** | Medium | Real — describes how the business actually runs | Consider sanitizing client-identifying detail. |
| **Security findings** | 1+ | `docs/SECURITY_FINDINGS.md`, `security/*` branches | **Medium** | Medium | Real — describes known weaknesses, some in `Proposed`/unlanded state | **Requires human review.** Publishing unremediated findings is a real, if modest, risk. |
| **Auth / environment assumptions** | — | `supabase/config.toml`, ADR-0002 | **Low** | High | Template values; the secret scan found **0 findings needing review** across all tracked files | Safe. Close the `.env.example` gap for `apps/web` and `packages/mcp-server`. |
| **Credentials / secrets** | 0 | — | **None found** | High | 8 secret-shaped matches, all classified `likely_fixture` or `placeholder`; **0 `review_required`** | No action. |

## 3. What the filename scan could not tell you

The evidence collector flags **names**. Two things it cannot judge, which this review had to probe
directly:

1. **A file named `payroll/page.tsx` may contain no payroll data.** It does not.
2. **A file named `BOSS_INTERVIEW.md` is exactly what it sounds like.** It is.

The scanner over-reports the first and under-weights the second. The real risk in this repository is
**prose about a named real business**, and no filename heuristic will ever rank that correctly.

## 4. Disposition summary

| Disposition | Applies to |
|---|---|
| **Safe to remain public** | Email fixtures (14) · employee/payroll/timesheet UI (4) · the timecard migration · `supabase/config.toml` |
| **Sanitize** | Client-identifying names in `docs/AUTOMATION_SYNERGY.md`, `docs/ROADMAP.md`, `docs/architecture/UBIQUITOUS_LANGUAGE.md` — the *architecture* is generic; only the naming is specific |
| **Requires human review** | The 20-document `docs/planning/` corpus, and `docs/SECURITY_FINDINGS.md` |
| **Make repository private** | **The recommended single action** — see §5 |
| **Remove from future history** | **Not recommended.** History rewriting on a repository with 12 branches and 9 PRs risks far more than it protects, and the content is already public. |

## 5. Recommendation

**Make the repository private, then decide file-by-file at leisure.**

Reasoning:

1. It is the only action that is **reversible and immediate**. Sanitizing 20 documents is a day of
   judgement calls; flipping visibility is a click, and it stops the clock while those calls are
   made.
2. The asymmetry is already odd: the activewear side project `TRANSCEND` is **private** while the
   repository containing a named client's operational planning is **public**.
3. Nothing about this repository requires publicity. There is no external contributor, no published
   package (the `@exattime/*` packages cannot even be published — they import by relative path), and
   no documentation site.
4. History rewriting is the wrong tool. The content has been public; removing it from history
   removes it from *future* clones only, at the cost of invalidating every existing PR and branch.

**What this does not fix:** anything already cloned or indexed. That is a reason to decide soon, not
a reason to skip deciding.

## 6. Should the new local cognition branches be pushed before this is decided?

**No. Wait.**

`feat/persistent-cognition-compiler` and `feat/cognition-dispatch-control-plane` are unpushed, and
they add material that raises exposure rather than lowering it:

- `context/AWE_IDENTITY.md` and `AWE_CURRENT_STATE.md` name the client as the first operating
  environment and describe the business relationship.
- `docs/integration/*` documents the client's operational gaps, the un-imported vault, and known
  blockers.
- **This very document** enumerates where the sensitive material is — a map of the exposure, which is
  more useful to a bad actor than any single file it points at.

Pushing them to a public repository would enlarge the problem while the decision is pending, for no
benefit: nothing downstream needs them remote today.

**Recommendation:** hold the push until visibility is decided. If the answer is "private", push
immediately afterwards. If it is "stays public", sanitize the cognition layer's client-identifying
references first — it is 10 files, and much easier to fix before it is published than after.

This is recorded as **approval gate A1** in `AWE_PLATFORM_LANDING_PLAN.md`, blocking Stage 1.

## 7. Evidence status

| Claim | Status |
|---|---|
| Repository is public | `VERIFIED` — `gh repo list` |
| 39 tracked files carry sensitive-looking names | `VERIFIED` — evidence collector |
| Email fixtures are synthetic | `VERIFIED` — 12/12 `is_fixture: true`, reserved domains, single test org |
| Payroll/employee pages contain no personal data | `VERIFIED` — 0 name-shaped literals |
| No credential is committed | `VERIFIED` — 8 matches, 0 `review_required` |
| The planning corpus describes a real business | `VERIFIED` — filenames and structure |
| Whether that content is commercially sensitive | **`UNKNOWN`** — a business judgement, not a repository fact |
| Whether the repository has been cloned or indexed | `UNKNOWN` — not observable from here |
