# Purchasing Control Center — test contract

Three gates. The first two are offline; the third builds and drives the real website:

| Gate | Runner | Scope |
| --- | --- | --- |
| **Unit** | `bash scripts/eval-purchasing-domain.sh` | `src/purchasing/domain/**` only — no database, no clock, no app. 165 assertions, milliseconds. |
| **Integration + end-to-end** | `bash scripts/eval-purchasing.sh` | the real use cases, repositories and adapters against a throwaway SQLite database, plus the full purchasing scenario. 152 assertions. |
| **Website acceptance** | `bash scripts/eval-purchasing-web.sh` | a production build, started on a spare port, driven over real HTTP. 88 assertions. |

`npm run test -w purchasing` runs typecheck, then all three.

## The website gate

It is not offline-pure like the other two, and that is the point: route protection tested only
through unit calls is route protection nobody has opened a URL against. The runner builds for
production (so "the production build passes" is part of the gate), starts the server against a
throwaway database, and asserts:

- an unauthenticated request to every workspace redirects to `/sign-in`
- the sign-in screen is branded, asks for a password, offers a reset, and does **not** expose
  the developer identity picker
- invalid credentials are refused; an unknown address is indistinguishable from a wrong
  password; a disabled account is refused with its own reason; none of them mint a cookie
- valid credentials create an httpOnly, SameSite session cookie carrying no personal data
- each role lands on its own workspace, and can open it
- every cross-workspace attempt redirects to `/unauthorized` — including a foreman opening the
  workshop queue, an office user opening administration, and a query string appended to fake it
- a foreman sees only their assigned job sites' deliveries, and not another foreman's
- refreshing a protected page preserves the session
- an expired cookie lands on `/session-expired`; a forged one lands on `/sign-in`
- sign-out clears access
- the phone-sized pages render, declare a viewport, use native date and time inputs, and carry
  no vendor, cost or stock input
- the shell names the user, offers sign-out, and hides workspaces they cannot open
- `/api/health` reports environment, database and migration status without echoing a secret

## The unit gate (domain invariants)

It asserts the rules that must hold however anything is stored or displayed:

- **the six quantities stay distinct** — requested, observed stock, approved,
  suggested, final order, received — and only the definitionally-derived ones
  (suggested, stock applied, replenishment, outstanding) are computed
- **one request belongs to one job** — a line carrying a second job number is
  refused at construction, not at the database
- **the original is frozen after submission** — `assertOriginalMutable` allows
  DRAFT and CLARIFICATION_REQUESTED and refuses every later status
- **vendor, cost and stock are workshop decisions** — every forbidden field is
  refused on a request, and a requestor holds none of those permissions
- **an ordered line needs a vendor and a cost**, and an override records a reason
- **the transition graph is closed** — the guard is checked against every one of
  the 14 × 14 status pairs, in both directions, plus each content precondition
- **authorization denies for the right reason and in the right order** — tenant
  before role, self-approval refused, ownership on clarification answers
- **every domain event names a known action** and a known notification event
- **the email draft cannot reach `SENT`** without a recorded review and a human
- **money and quantity arithmetic is exact** — no float, no silent rounding

## The integration gate

Runner: `bash scripts/eval-purchasing.sh` (harness: `scripts/eval-purchasing.mjs`).

**Offline by construction.** No API keys, no model calls, no Supabase, no network, no Microsoft
Graph, no mailbox, no browser. The harness imports the modules the app ships — Node 24 strips
the TypeScript types on import, so it tests the same files, not a copy — and drives them against
a throwaway SQLite database in a temp directory that it deletes on the way out.

Exit 0 iff every gate passes. 152 assertions, roughly 15 seconds.

---

## What it gates

### Vocabulary and parity
- All 14 statuses exist and every transition targets a known status.
- All six roles exist; the permission vocabulary has no duplicates.
- Six email templates, six draft statuses, eleven notification events.
- `EXTERNAL_SEND_ENABLED === false` at the source.
- **Migration parity** (`scripts/lib/validate-migration-0016.mjs`): the status enum, the role
  enum, the role/permission matrix, the transition graph, the email vocabulary and the table set
  in `supabase/migrations/0016_purchasing_control.sql` match the app's modules — in both
  directions, so the SQL cannot allow an edge the app forbids. It also asserts the migration
  contains no send path (`pg_net`, `http_post`, `smtp`, …) and still carries the send gate, the
  permanent-PO-number guard, the forward-only sequence, the row lock, the no-delete triggers,
  the over-receipt guard, the read-only original request and the self-approval refusal.

### Intake (spec §3)
Job number required · need-by date required · need-by time required · a bogus time rejected ·
multiple line items accepted · a second job number on any line rejected · at least one item ·
zero quantity rejected.

### The field firewall (spec §2, §14)
A requestor's payload carrying `vendor_id`, `estimated_unit_cost_cents`, `usable_stock_qty`,
`final_order_qty` or the removed `priority` field is stripped, the stored request shows no
vendor and no cost, and the attempt is written to the activity log — a probe is visible, not
merely refused.

### Authorization (spec §14)
Requestor cannot: open the queue, record stock, approve, generate a PO, touch a request once the
workshop owns it, read the audit log, or open someone else's request. Office without the grant
cannot approve; office **with** the grant can. Rick approves as the authorized backup. Nobody
decides on a request they raised. The tenant check fires **before** the role check, another
org's request is *not found* rather than *forbidden*, and an admin of another org sees nothing.
Every refusal is recorded as `authz.denied`.

### The quantity algebra (spec §4)
`suggested = approved − stock`, never negative. The override sticks (14 suggested, 18 ordered),
the extra 4 is recorded as replenishment rather than job need, 6 is recorded as stock applied,
and **the requested quantity is unchanged** by everything the workshop does. Money is exact:
18 × $86.40 = $1,555.20.

### The state machine (spec §5)
No PO before approval · no PO after rejection · a rejected request cannot be approved afterwards
· no vendor email without a PO · a request cannot skip the PO or the email step · cannot be
received without receiving information · cannot be completed with lines outstanding · terminal
states are terminal · unknown statuses are refused.

### Purchase orders (spec §6)
The number is formatted from the configured sequence (`LE-52901`), regenerating returns the same
permanent number and burns no sequence value, the stored document is a real PDF containing the
PO number, job number, vendor and total, and it is SHA-256 hashed. The database itself rejects a
duplicate PO number.

**Concurrency:** eight worker threads, five allocations each, one database file, one sequence.
40 numbers, all distinct, and the sequence advanced exactly once per issued number. This is the
gate a frontend counter cannot pass.

### Email (spec §7)
The draft starts `GENERATED`, records that sending is disabled, carries the PO number, job
number, need-by date and time, and the PDF attachment, and addresses a fixture recipient. It
cannot jump to `SENT`; once reviewed the words freeze; `SENT` requires a recorded review and the
human who marked it.

### Receiving (spec §9)
Over-receipt refused by default, accepted with an explicit override, refused even with an
override beyond twice the ordered quantity. A partial receipt leaves the line outstanding and
blocks completion; the balance closes it, notifies the requestor that the material is ready, and
allows completion.

### Audit (spec §13)
Sixteen specific actions are asserted present on the timeline, every recorded action is in the
closed vocabulary, the timeline is ordered, every row is attributed to a person and renders a
human sentence, and rows expose their recorded field changes.

### Dashboard (spec §8)
Summary cards compute; a late open order is overdue; a completed request is not.

---

## Adding to it

Keep the shape: a `console.log('--- section ---')`, then `check`/`eq`/`refuses`/`throws` lines
that read as sentences. `refuses(fn, reason, message)` asserts a `ServiceError` with a specific
reason from the closed vocabulary — assert the reason, not the wording, so a better error
message does not break the suite.

If you add a status, a permission, a role or a transition, the parity validator will fail until
migration 0016 agrees. That is the point of it.
