# PCC operator handoffs

Three short guides. Each is for one audience and contains only what that
audience needs.

---

# A. Mike and Rick — using PCC

## Signing in

PCC is a website on the company network. Nothing is installed on your computer.

1. Open the PCC address in your browser (bookmark it).
2. Sign in with your company email and the password you were given.
3. The first time, you are asked to change that password. Choose your own.

If you forget it, ask an administrator to reset it. There is no self-service
reset — that is deliberate.

## The purchasing flow

**Somebody needs material** → they raise a request against a job.

**You review it** → enter what is already on the shelf, choose the vendor, enter
costs, and approve. PCC will not let you approve until you have said what is
actually being ordered — that is why the review comes first.

**Generate the purchase order** → PCC gives it a number: job, vendor, and a
count within that pair. `24-118-GRAYBAR-8` is the eighth order on job 24-118
from Graybar.

**Order it** → open the draft email, read it, and send it yourself. PCC prepares
it; **PCC never sends anything.**

**Mark it ordered** → PCC will not let you do this until you have opened the
draft, so nothing is recorded as ordered before somebody looked at it.

**Receive it** → record what actually arrived. Part of a delivery is fine; say
so and record the rest when it turns up. Attach a photo of the packing slip.

**Complete it** → when everything has arrived.

## Common mistakes

- **Approving before entering shop stock.** PCC refuses. Enter what is on the
  shelf first, so you only order the difference.
- **Expecting PCC to email the vendor.** It does not. You send it.
- **Recording a delivery you did not see.** Only sign for what actually arrived.
- **Guessing a purchase order number.** PCC issues them. If one looks wrong,
  stop and say so.

## What NOT to do

- Do not share a login. The name on an approval matters.
- Do not record a delivery on somebody else's behalf to save time.
- Do not work around a refusal. If PCC says no, it is saying why — read it.

## When something is wrong

Technical (will not load, will not sign in, an error you cannot read): **Jose.**
Purchasing (a number looks wrong, a vendor is missing, you cannot do something
you should be able to): **an administrator.**

---

# B. Jose — running PCC

Everything is on **LIPELE-RDS02**. Employees only need a browser.

## The seven things you need

| Question | Command |
|---|---|
| Is the service running? | `Get-Service pcc` |
| Will it come back after a reboot? | `sc qc pcc` → expect `AUTO_START` |
| Is the application healthy? | `Invoke-RestMethod http://127.0.0.1:3000/api/health` |
| **Which version is running?** | same command — read `release` |
| Where are the logs? | `Get-Content C:\ProgramData\pcc\logs\pcc.err.log -Tail 50` |
| Did the backup run? | `.\scripts\install-backup-task.ps1 -Verify` |
| Is the latest backup usable? | `node scripts\pcc-backup.mjs --db C:\ProgramData\pcc\data\pcc.sqlite --check` |

**Restart:** `nssm restart pcc`
**Full check:** `node scripts\pcc-verify-deployment.mjs`

## If PCC will not start

It usually **refused** rather than crashed. A refusal exits 1 and stays stopped
on purpose — restarting it in a loop would bury the one line that explains why.
The last lines of `pcc.err.log` name the setting that is wrong.

## Where things live

| | |
|---|---|
| Application | `C:\Program Files\pcc` |
| **Data — back this up** | `C:\ProgramData\pcc\data\pcc.sqlite` |
| Configuration | `C:\ProgramData\pcc\pcc.env` |
| Logs | `C:\ProgramData\pcc\logs` |
| Backups | `...\data\backups` — nightly 01:30, keeps 30 |

## Restore

1. **Stop the service first.** `nssm stop pcc` — restore refuses while the app
   is answering, which is correct, not a fault.
2. `node scripts\pcc-restore.mjs --from <backup> --db C:\ProgramData\pcc\data\pcc.sqlite --force`
3. `nssm start pcc`, then check health.

## Do not casually change

`SESSION_SECRET` (signs everyone out) · `PCC_DATABASE_PATH` (points at a
different or empty company) · `PCC_PO_NUMBERING` (changes how orders are
numbered mid-life) · `PCC_ORG_ADDRESS` / `PCC_ORG_PHONE` (not re-read after the
first start — editing them changes nothing and misleads) · the service's
`AppExit` policy.

## Escalate when

The database file is missing or unreadable · the newest backup fails
verification · PCC refuses with a message that names no setting · the site is
reachable but nobody can sign in after a certificate change · port 3000 answers
from another machine.

---

# C. Backup administrator — first login and user management

You exist so PCC does not depend on one person. Use this account rarely.

## First login

1. Sign in with the temporary password you were handed.
2. Change it immediately when prompted.
3. Confirm you can reach **Administration**.

## Managing people

| Task | Where |
|---|---|
| New employee | Administration → Users → invite. Give a role, hand over the temporary password in person. |
| Somebody's job changed | Administration → Users → roles |
| Somebody left | Administration → Users → **disable**. Do not delete — the record is part of the audit trail. |
| Forgotten password | Administration → Users → **Reset access**. Generates a temporary; they must change it. |
| Who signs at the shop counter | Administration → assignments → `WORKSHOP` |
| Who signs on a job site | Administration → assignments → the job number |

## Caution

- **Approval authority is not a small flag.** On most roles it also grants
  generating purchase orders and marking them ordered.
- **Receiving depends on where the delivery goes.** Somebody assigned to a job
  site cannot sign for material delivered to the shop counter, and that is
  intentional.
- **PO numbering must not be changed casually.** A number issued to a supplier
  cannot be withdrawn. If a sequence genuinely needs moving, the screen asks you
  to acknowledge it — read the prompt.
- **Never delete a person.** Disable them.

## Keep two administrators

If both administrator accounts are lost, recovery requires a script on the
server console. Two accounts, two people.
