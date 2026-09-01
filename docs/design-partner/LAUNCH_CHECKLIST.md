# Design partner launch checklist

**You just got the text: "Yes, we'd like to try it."**

Twelve steps. Every command is real. The detail behind each one is in
[`ONBOARDING.md`](ONBOARDING.md) — this page is the thing you work down.

Substitute your organization's directory name for `<org>` throughout.

---

### 1. Qualify the partner

Their purchasing lifecycle must be: request → review → approval → purchase order
→ order placed → receipt → complete. They must buy against jobs. One row per
supplier must be enough.

```
node scripts/discovery.mjs
```

**Stop here if the lifecycle does not match.** That is a different capability,
and finding out in week three is the expensive version of this conversation.

### 2. Gather the required facts

`ONBOARDING.md` → *DURING TECHNICAL DISCOVERY*. Seven sections. The two that get
skipped and shouldn't: **the last purchase order number issued per scope**, and
**who restarts it when it stops**.

### 3. Record the baseline — before anything is installed

```
npm run baseline
npm run baseline:import
```

Half a morning of their time. Frozen in step 10, **before** the first real
request. Skip it and the pilot can still work; it can never be written up.

### 4. Fill in the organization configuration

```
cp -r organizations/northgate organizations/<org>
$EDITOR organizations/<org>/dossier.mjs
```

Then write the three files it references — purchasing profile, authorization
profile, deployment manifest — and their five instance CSVs.

**No secrets in any of them.**

### 5. Validate the configuration

```
node scripts/provision-organization.mjs --org <org>
```

Iterate until it validates and **"OURS TO CLOSE" is empty**. Anything under
"THEIRS TO ANSWER" is the agenda for your next call with them, not a blocker on
you.

### 6. Provision

```
node scripts/provision-organization.mjs --org <org> --write-env ./out
```

Add `PCC_ENVIRONMENT=production`, `NODE_ENV=production`, `APP_BASE_URL` and
`SESSION_SECRET`. Install the release per `PCC_VM_INSTALLATION_RUNBOOK.md`.

```
node scripts/pcc-preflight.mjs
```

Then **first start** — this creates the organization, and is the only moment its
identity, letterhead, environment stamp and role vocabulary can be set.

```
node scripts/pcc-onboard.mjs --dir organizations/<org>/instance --dry-run
node scripts/pcc-onboard.mjs --dir organizations/<org>/instance
```

### 7. Run the readiness gate

```
node scripts/eval-second-customer.mjs
node scripts/provision-organization.mjs --org <org>
npm run deployment-gate
```

The second-customer suite must pass **before** you deploy to a real company. It
is the proof that the path you are about to walk still works.

### 8. Deploy the pilot

Scope: `programs/design-partner/pilot.mjs`. One workflow, end to end, with the
`out` list said out loud to them before you start.

### 9. Verify health

```
node scripts/pcc-verify-deployment.mjs
node scripts/pcc-storage-status.mjs
node scripts/pcc-backup.mjs && bash scripts/restore-rehearsal.sh
```

Then the eight manual checks in `ONBOARDING.md` → *AFTER DEPLOYMENT*. Number 4 —
**read the purchase order number out loud** — is the one that catches a wrong
numbering rule before a supplier sees one.

### 10. Open the proof window

```
npm run baseline:freeze
npm run proof
```

Freeze **before** the first production request. After that the comparison is
unfalsifiable and no amount of care fixes it.

### 11. Support the first transactions

Be reachable for the first week. Watch the first request, the first approval and
the first receipt happen — do not ask about them afterwards.

The failure mode to watch for is the office keeping its paper record *as well*.
That means something in the workflow is not trusted yet, and they will not
volunteer which part.

### 12. Measure the outcome

```
npm run proof
npm run proof:case-study
npm run plan
```

Record the deployment in `programs/design-partner/pilot.mjs`, split by whose
time it was. **Custom engineering hours must be zero.** If they are not, that
work belongs in the product so Customer #3 inherits it.

Then set `externallyValidated: true` in `programs/iic-2027/derive.mjs` — and at
that point "AWE is not hard-coded for one business" stops being *architecturally
repeatable* and becomes **externally validated**, which is the claim that was
worth building all of this for.

---

## If it goes wrong

`programs/design-partner/offboarding.mjs`. Access off first, records kept,
credentials rotated. Eight steps, six of them reversible.
