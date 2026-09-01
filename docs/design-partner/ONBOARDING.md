# AWE design partner onboarding

**Internal. For Jack.** Not a sales document and not for a customer to read.

The purpose of this file is that onboarding Company #2 requires no memory of
hidden implementation details. Every command below is real and every fact it
asks for is one the software actually consumes.

Two commands do most of the work:

```
node scripts/provision-organization.mjs --org <name>     # plan, validate, derive, gate
node scripts/eval-second-customer.mjs                    # prove the path still works
```

---

## The one-paragraph version

A design partner is described by **one file** — `organizations/<name>/dossier.mjs`
— from which the purchasing policy, the roles, the deployment manifest and the
entire environment are derived. There is no per-customer branch, no per-customer
build, and no per-customer source file beyond that dossier and the two profiles
it references. If you find yourself editing `apps/purchasing` to make a customer
work, stop: that is a product defect, and `scripts/eval-second-customer.mjs`
exists to catch it.

---

## BEFORE THE CUSTOMER MEETING — what you need to know

### Who can be a design partner

The purchasing **lifecycle** is the capability and is not configurable:

```
request → review → approval → purchase order → order placed → receipt → complete
```

**Qualify on this, first.** A business that quotes before ordering, works from
blanket orders, or needs multi-step or value-threshold approval needs a
different capability, not configuration. That is not a defect — a configurable
lifecycle is how a product becomes a rules engine nobody can test — but it does
decide the shortlist.

Also worth knowing early:

| Question | Why it decides things |
|---|---|
| Do you buy against jobs, or to stock? | Every request is raised against a job. A business with no unit of work to buy against is not this pilot's partner. |
| One row per supplier, or branches? | A vendor is one row with one short code. Distributors with many branches may need more, and nobody has tested it. |
| Who signs for deliveries? | Receiving is scoped by job assignment. It is not a per-customer setting. |

### What is already configurable, so you can say yes on the call

Organization name, letterhead, timezone, short name, logo, role names and what
each role may do, purchase-order numbering rule and separator, fulfilment
expectation, need-by time of day, the word for the place that holds stock, and
which of the built-in purchase-order forms is used.

Run `node scripts/discovery.mjs` for the current honest gap analysis. Today:
**16 ready, 8 configurable, 2 deliberately invariant, 0 Lippolis-specific, 2
unknown** — and both unknowns are questions only a real business can answer.

### What to say no to, gently

See `programs/design-partner/pilot.mjs`, `out`. Automatic vendor email, SSO,
importing open orders, a custom printed form, ERP integration, inventory
balances, threshold approval, a mobile app. Each is "not in this pilot" rather
than "no".

---

## DURING TECHNICAL DISCOVERY — the exact questions

Ask about the **work**, then write down the roles. Do not ask them to name roles
in the abstract.

### 1. Identity

- Legal name, exactly as it should print on a purchase order
- Address and telephone number for the purchase order header
- Short name their staff actually says
- Timezone
- Do they have a logo file? *(Optional. Without one they get a wordmark of their
  name — do not let this hold anything up.)*

### 2. Who does what

> "Walk me through who asks for material, who decides what to buy, who places
> the order with the supplier, and who signs for it when it arrives."

Each answer becomes a role name and a set of capabilities in
`capability/purchasing/profiles/<org>-authorization.mjs`. The vocabulary is the
capabilities in `apps/purchasing/src/purchasing/domain/roles.mjs`; they choose
the **shape** of the organization, not what purchasing can do. A capability that
does not exist throws when you write the profile, not months later.

Also: **can one person be given approval authority as an exception?** If not,
leave `approvalGrant` empty.

### 3. Purchase order numbering — get this exactly right

> "Show me the last purchase order you wrote. Read me the number. Now show me
> the one before it."

- Is the counter per **vendor**, or per **job and vendor**?
  (`vendor-sequence` / `job-vendor-sequence` — both implemented)
- What separates the parts? (`-` or `/`)
- **What is the last number issued, per scope?**

The last number is the one piece of instance data that cannot be corrected
later. An issued purchase order number is immutable: a counter started too low
collides, and one started too high silently skips numbers the office will look
for. A rule this build cannot perform is **refused at startup** — it will never
invent a number.

### 4. Policy

- How soon do they expect material after ordering? *(days; unset means the
  request form offers no default date)*
- What time of day do they want deliveries? *(Lippolis: 07:00)*
- What do they call the place that holds their own stock? *(workshop, yard,
  shop, store)*
- Do they capture prices at order time, or reconcile from the invoice?

### 5. Suppliers, jobs, people

Ask for their supplier list, their open jobs, and who is assigned to which. This
becomes five CSV files — see `config/onboarding/README.md` for the column rules.
**Ask for the supplier list early**; it is a five-minute question that de-risks
the whole vendor model.

### 6. Where it runs — for their IT or MSP

Windows or Linux; who can install a service; where the data directory lives and
that it is **local disk, not a file share**; the hostname; who owns TLS; who
restarts it when it stops; **who monitors it**. The last two are asked least and
matter most.

### 7. The baseline — the conversation most likely to be skipped

> "Before we put this in, I want to write down how it works today: the steps,
> who touches each one, and roughly how long it takes. Half a morning."

This must be **frozen before the first production request**. Without it the
pilot can still run and still be useful — it just cannot ever produce a case
study, because there is nothing to compare against. Say that out loud.

---

## BEFORE DEPLOYMENT — the exact required facts

Write `organizations/<name>/dossier.mjs`. Copy
`organizations/northgate/dossier.mjs` and answer it.

Then:

```
node scripts/provision-organization.mjs --org <name>
```

It refuses an invalid dossier and **names every missing fact with its owner**.
Iterate until the readiness verdict is `READY_FOR_REHEARSAL` or better and
nothing is left in the "OURS TO CLOSE" list.

You also need to write, from their answers:

| File | From |
|---|---|
| `capability/purchasing/profiles/<org>.mjs` | §3 and §4 above |
| `capability/purchasing/profiles/<org>-authorization.mjs` | §2 above |
| `deployment/examples/<org>.manifest.mjs` | §6 above |
| `organizations/<org>/instance/*.csv` | §5 above |

**Never put a secret in any of them.** `validateDossier` refuses a field whose
name looks like a credential, and that refusal is tested.

---

## DEPLOYMENT — the exact procedure

```
# 1. Derive the environment. No secrets are in this file.
node scripts/provision-organization.mjs --org <name> --write-env ./out

# 2. Add the four values that cannot be derived:
#      PCC_ENVIRONMENT=production     stamped once, permanently
#      NODE_ENV=production
#      APP_BASE_URL=                  from the manifest's network.hostname
#      SESSION_SECRET=                from the manifest's secret store

# 3. Install the release. See PCC_VM_INSTALLATION_RUNBOOK.md.

# 4. Preflight, before the first start.
node scripts/pcc-preflight.mjs

# 5. FIRST START. This creates the organization and is the ONLY moment its id,
#    name, letterhead, environment stamp and role vocabulary can be set. An
#    under-identified organization is REFUSED and nothing is created.

# 6. Reference data. Dry run first, always.
node scripts/pcc-onboard.mjs --dir organizations/<name>/instance --dry-run
node scripts/pcc-onboard.mjs --dir organizations/<name>/instance
```

The dry run resolves references across all five CSV files, so it validates the
set as a whole. Re-running is safe: anything already present is skipped.

---

## AFTER DEPLOYMENT — health verification

```
node scripts/pcc-verify-deployment.mjs
node scripts/pcc-storage-status.mjs
node scripts/pcc-backup.mjs && bash scripts/restore-rehearsal.sh
```

Then, by hand, with a real person watching:

1. Somebody signs in and is forced to change their temporary password.
2. Raise a request. Confirm the screen says **their** company name, not ours.
3. Review it, approve it, generate the purchase order.
4. **Read the purchase order number out loud.** Confirm it is the shape they
   showed you in discovery. This is the check that catches a wrong numbering
   rule before a supplier sees one.
5. Print it. Confirm the letterhead is theirs.
6. Draft the vendor email. Confirm nothing was sent.
7. Receive it. Complete it.
8. Open the audit trail and confirm every act names the right person.

A reboot, then confirm the service came back without anybody logging in.

---

## PROOF — activating the evidence

Nothing counts as evidence until two things are true.

```
npm run baseline              # what has been collected
npm run baseline:import       # load their observations
npm run baseline:freeze       # FREEZE — before the first production request
npm run proof                 # what may be claimed
npm run proof:case-study      # the case study gate
```

- The database must be stamped `PCC_ENVIRONMENT=production`. A rehearsal
  database can never be promoted — the stamp is written once, and a later start
  that disagrees refuses to boot.
- The baseline must be **FROZEN**, and frozen **before** production records
  start.

Their evidence is bound to their organization id and cannot be confused with
Lippolis's, in either direction. That isolation is tested adversarially in
`scripts/eval-second-customer.mjs`.

---

## Measuring what it cost us

Record the deployment in `programs/design-partner/pilot.mjs`, splitting time
into founder configuration, **custom engineering**, waiting on the customer, and
waiting on IT.

**The engineering number is the one that has to be zero.** If it is not, the
work that made it non-zero belongs in the product, not in the customer's
deployment — and the next customer should inherit it.

---

## If they want to stop

`programs/design-partner/offboarding.mjs` — eight steps, in order. Access is
revoked first because that is what they asked for and it is completely
reversible. Records are **retained, not deleted**: the purchase orders went to
real suppliers and the audit trail records things people really did.

Only two steps are irreversible: rotating the secrets, and an export or
destruction they ask for **in writing**. There is deliberately no command for
the second one.
