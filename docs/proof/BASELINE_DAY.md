# Baseline day — Jack's checklist

Print this. Two pages. Everything you need is on it.

**What you are collecting:** how long the *old* way of buying material took, per purchase request,
so that later there is something to compare PCC against. Without it there is no "before", and no
hours-returned figure can ever exist.

**Total interruption to Lippolis:** about one morning of sitting beside somebody, plus one email.

---

# BEFORE I GO

```bash
npm run baseline          # must say READY TO COLLECT BASELINE
```

If it says BLOCKED, fix what it names first. Do not go.

**Print or open:** this page, and the two sheets:

- `proof/baselines/observations/field/handling.csv` — one row per timing
- `proof/baselines/observations/field/cycle.csv` — one row per filed paper PO

**Bring:** a stopwatch (a phone is fine), a clipboard or laptop, and something to write on that
does not need Wi-Fi.

**Decide before you arrive, and write it down now:** which paper POs you will read.
*"Every PO in the drawer for June, July and August."* Not "a good spread" — a rule you fix before
opening the drawer, so that when somebody asks whether you picked the flattering ones, the answer
is a rule rather than a reassurance.

---

# AT LIPPOLIS

## 1. The filing cabinet — 60–90 minutes, interrupts nobody

Ask Karen or whoever keeps the files for the purchase order folder. Then work alone.

**Take every PO in the range you decided.** For each one, into `cycle.csv`:

```
po,raised,received,vendor
1234-COOPER-7,2026-06-03,2026-06-11,Cooper
```

- `raised` — the date written on the PO
- `received` — the date on the packing slip stapled to it
- If there is no packing slip, **skip the row** and carry on. Do not guess.

**You need 15. Get 25 if the drawer allows.** Below 15 the elapsed-time figure is recorded as
somebody's impression rather than as evidence.

---

## 2. Sit beside the purchaser — one morning

Ask to sit beside Mike (or whoever raises purchases) **on a normal day, not a quiet one**. Say you
are timing the old process before the new system, and that you need nothing from them except to
work as usual.

**Do not help. Do not ask questions during a task.** Ask afterwards.

Every time one of these happens, one row in `handling.csv`:

```
step,seconds,who,ref,covers,method,date,note
stock_check,95,Mike,job 1188 conduit,,,2026-09-03,
```

| Step | Stopwatch STARTS | Stopwatch STOPS | |
|---|---|---|---|
| `request_intake` | the call is answered / the text is opened | the note of what is needed is complete | |
| `clarification` | they start chasing the missing detail | they have it | |
| `stock_check` | they start looking | they know the answer | |
| `approval_handling` | the approver picks it up | the approver puts it down | |
| `po_preparation` | they start the form | the form is complete | |
| `vendor_communication` | they start writing / dialling | sent / hung up | |
| `tracking_and_filing` | they start chasing or filing | they stop | **see below — this one is per-batch** |

### The one rule that decides whether any of this is usable

**Time only the minutes a person is OCCUPIED.**

If the approver picks a request up at 09:10, signs it, and puts it down at 09:12 — that is
**120 seconds**, even if the request then sits on the desk until 2pm. The five hours of sitting is
real and it is *not labour*; it is already being captured by the paper POs in Step 1.

If you time the waiting, the baseline inflates enormously and invisibly, and every hours-returned
figure afterwards is wrong in the direction that flatters us. **When in doubt, stop the watch.**

### Two things that need a number, not a timing

**Clarification does not happen every time.** Keep a tally on the corner of the page: of the
requests you see, how many needed a second conversation. `12 requests, 3 needed chasing.`
Write it here → **______ of ______**. That becomes one number in the file afterwards; if you skip
it, an eight-minute step that happens a quarter of the time gets counted as if it happened always.

**Filing happens in batches.** Nobody files one packing slip. When they file a stack, time the
**whole stack** and put the count in `covers`:

```
tracking_and_filing,720,Karen,friday slips,12,,2026-09-03,filed the week in one go
```

That is a measurement — twelve minutes across twelve orders is one minute each. Timing one slip
out of a batch is not.

**`tracking_and_filing` is chasing AND filing, and they happen at different rates.** Filing is a
batch; a chase call is one order. Do not put a 90-second chase and a per-order filing figure in as
two rows and hope the middle one is right — they are measuring different things.

**Do this instead.** If they chase during the same session they file, keep the watch running across
the whole session and let `covers` be the number of orders in the stack. That one row is then the
per-order cost of the whole step, which is what it is supposed to be.

If a chase happens on its own, give it its own row with `covers` = the number of orders chased, and
put `chase only` in the note. Then say so out loud when you review the figures — this is the step
most likely to be understated, and the reviewer in Step 4 is the person who would know.

### How many

**Five of each step.** They happen at different rates: you will get five intakes and five stock
checks easily, and `po_preparation` and `vendor_communication` come in the same run as each other.

- **`approval_handling`** is a different person. Catch five, or ask them to jot the time on five
  over the week and collect it later (`method` = `told_me`).
- **`tracking_and_filing`** is the hard one. Five batches means five filing sessions. If you only
  get one or two, that is fine — record what you got and read "what you will come back to" below.

**If you cannot watch something**, still record it, with the right `method`:

| You | `method` |
|---|---|
| watched it and timed it | leave blank (or `observed`) |
| worked it out from paperwork | `from_paper` |
| were told how long it takes | `told_me` |

**Never upgrade a method to make a number look better.** One `told_me` among four timings makes the
whole step count as told-me. That is correct, and it is what a judge would do too.

---

## 3. Two questions before you leave — 5 minutes

**To Mike/Karen:** *"Roughly how many purchase requests come through in a week?"* → **______**
Not evidence; it tells you how long the 30-purchase observation window will take.

**To Paul, or by email afterwards:** the **fully loaded** hourly cost of the person doing
purchasing — wage plus payroll tax, insurance and overhead. Not the wage.

This one is **optional**. Hours returned does not wait on it. Only the money figure does, and
without it the case study will simply say NOT MEASURABLE where dollars would go, which is honest.

---

# AFTER I LEAVE

## 1. Put the sheets back

They are already in `proof/baselines/observations/field/`. Save them there.

## 2. Import and check

```bash
npm run baseline:import       # converts both sheets; refuses anything malformed
npm run baseline              # what it is worth, and what is still missing
```

If the import refuses, it names the file and line. Fix that row and run it again — it writes
nothing until every row is good, because a half-imported baseline looks finished.

## 3. The clarification share

Open `proof/baselines/observations/lippolis-purchasing.json` and set, for `clarification`:

```json
"appliesToShare": 0.25
```

from your tally — 3 of 12 is `0.25`. This is the only hand edit, and it is one number.

## 4. Have somebody check it

Read the seven figures back to Mike, Paul, or anybody who knows the work and did **not** do the
timing. *"Does nineteen minutes a purchase sound about right?"*

**Record disagreements rather than arguing them.** Then in the same file:

```json
"reviewedBy": "Mike Purchasing",
"reviewedAt": "2026-09-10"
```

Without this, the case study is capped at DEFENSIBLE. An unreviewed baseline is one person's
afternoon.

## 5. Freeze it

Only when `npm run baseline` says **BASELINE DEFENSIBLE**:

```bash
node scripts/baseline-freeze.mjs \
  --by "Jack Daly" --at 2026-09-10 --opens 2026-09-15
```

- `--at` — today
- `--opens` — the day PCC goes live at Lippolis. **Purchases before this date are not eligible for
  Case Study #001.** It cannot be earlier than `--at`.

This writes `proof/baselines/frozen/lippolis-purchasing.v1.json`, which is what the case study is
computed against from then on. **Commit it.** If the observations change afterwards, the tooling
says so rather than silently using the new ones.

## 6. Then, and only then

Install PCC, and let Mike work normally until **30 completed purchases**. You record nothing during
that window — PCC's audit log captures every human interaction with an actor and a timestamp, which
is the half you do not have to work for.

```bash
npm run plan      # confirms the next action
```

---

# What you will come back to

Almost certainly `tracking_and_filing` with one or two observations instead of five, and no
`approval_handling`.

**That is a normal first pass and it is not a failure.** `npm run baseline` will tell you exactly
which steps are short and what each is graded. Two short follow-ups fix it:

- one more visit on a filing day, for three more batches
- five minutes with the approver

Until then the baseline still works — it is simply graded lower, and the case study will say so
rather than pretending.

---

# The one thing to protect

**Do not decide any of the rules after seeing the numbers.** Which POs to read, what counts as
handling time, how many observations make a measurement — all of it is fixed before you go, in
`proof/case-study-standard.mjs`, dated and versioned.

If a rule turns out to be wrong, change it and say so. Changing it quietly, after the numbers are
in, is the one thing that would make all of this worthless.
