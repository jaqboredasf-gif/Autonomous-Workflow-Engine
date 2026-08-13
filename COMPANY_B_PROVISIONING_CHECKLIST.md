# Provisioning a second purchasing customer

What AWE needs from a similar trades business to stand up purchasing, and what happens to each
answer. Grounded in what the repository can actually consume today.

**Not a consulting questionnaire.** Every item below either becomes a file, a database row, or a
known piece of bespoke work. If an answer changes nothing, it is not here.

---

## A. Organization identity

| Ask | Becomes |
|---|---|
| Legal name, as it should print on a purchase order | `PCC_ORG_NAME` |
| Phone and address for the PO header | `PCC_ORG_PHONE`, `PCC_ORG_ADDRESS` |
| Short slug | `organization.id` in both profiles |

---

## B. Who does what — the authorization profile

**The question to ask, in their words:** *"Walk me through who raises a material request, who
decides what to buy, who places the order, and who signs for it when it arrives."*

Do **not** ask them to name roles in the abstract. Ask about the work, then write the roles down.

| Ask | Becomes |
|---|---|
| What do you call the people who ask for material? | A role name |
| Who checks what is already in stock and decides what to buy? | A role carrying `review.*`, `po.generate` |
| Who actually places the order with the supplier? | A role carrying `order.mark_ordered` |
| Who signs for deliveries, and is it limited to their own jobs? | A role carrying `receiving.record` (assignment-scoped) |
| Anyone who needs cost visibility but should change nothing? | A role carrying `accounting.read` |
| Can one person be given approval authority as an exception? | `approvalGrant` — or empty if they decide by role only |

**Produces one file:** `capability/purchasing/profiles/<org>-authorization.mjs`.

Validated at construction — a capability that does not exist throws immediately rather than
surfacing as a refused action months later. The vocabulary is the 35 capabilities in
`domain/roles.mjs`; they choose the shape of the organization, not what purchasing can do.

---

## C. People

| Ask | Becomes |
|---|---|
| Names and email addresses | Users, created through Administration |
| Which roles each holds | `user_roles`, org-scoped |
| Which jobs each foreman signs for | Job assignments — receiving is scoped by them |
| One first administrator | `PCC_BOOTSTRAP_ADMIN_EMAIL` for the first start only |

---

## D. Purchasing data

| Ask | Becomes |
|---|---|
| Supplier list, with the ordering contact for each | Vendors, entered through Administration |
| How they write each supplier's short code | `vendors.code` — frozen after that vendor's first PO |
| Active jobs, with site addresses | Jobs — the name and address print on the PO |

---

## E. Policy — where the bespoke work is

| Ask | Today's answer |
|---|---|
| **How do you number purchase orders?** | If not `job-vendor-sequence`: an **adapter** — two functions in `organization/po-numbering.mjs`, an id in their profile's `purchasing.po_numbering`, and `PCC_PO_NUMBERING` set to match. No purchasing core file changes. Ask before the first order: an installation with no established rule refuses to start rather than inventing numbers. |
| **Do you already have paper POs for jobs we'll use?** | Per (job, vendor) initialization in Administration. **Cannot be guessed and cannot be undone** — ask before the first order. |
| What do you call the place you keep stock? | "Workshop" today. Anything else is **core edit** (8 modules) — or live with the label. |
| Do you price purchase orders when raising them? | No pricing is the current behaviour; prices are optional. |
| Send the vendor email, or draft it for a person to send? | Draft-only is pinned by a database CHECK. Sending needs a migration plus an **adapter**. |
| What does your purchase order look like on paper? | **Adapter** — one `LAYOUT` object in `pdf-adapter.ts`. |
| How soon after ordering do you expect material? | UI copy only; no value to set. |

---

## F. Deployment

Handled by the deployment substrate, not by purchasing. Ten blocking questions in
`AWE_DEPLOYMENT_DISCOVERY_CONTRACT.md` §B; produces one `deployment/examples/<org>.manifest.mjs`.

The purchasing profile references it by path and knows nothing else about infrastructure.

---

## Provisioning dry run — a real second contractor tomorrow

**1. What we ask for:** sections A–E above. Roughly a 45-minute conversation plus a supplier and
job list. Section B is the one requiring care; the rest is data entry.

**2. What we create:**
- `capability/purchasing/profiles/<org>-authorization.mjs` — roles and grants
- `capability/purchasing/profiles/<org>.mjs` — terminology, policies, template reference
- `deployment/examples/<org>.manifest.mjs` — hosting, storage, network, responsibilities
- `/etc/<org>.env` — configuration and secret references
- vendors, jobs and users entered through Administration

**3. What stays untouched:** every file under `apps/purchasing/src/purchasing/domain/` and
`application/`, all repositories, every screen. Proven by 45 checks in
`scripts/eval-organization-provisioning.mjs`.

**4. What still needs engineering:** the PO document layout; email sending if they want it; the
stock-location label if "workshop" is wrong for them. PO numbering is now an adapter rather than a
core edit — still code we write, but behind a seam, and proved by a synthetic organization whose
numbers share nothing with Lippolis's.

**5. Distinct customization seams:** four — numbering, document, communications, terminology. Two of
the four (role vocabulary, then numbering) have been closed into adapters or configuration; the
count stays four because numbering is still a seam, just no longer a core edit.

**6. What would prevent deployment:** nothing in purchasing. Deployment blockers are hostname, TLS
owner, a persistent volume, and a named person who restarts it — the same four that still hold PCC
at `DEPLOY_ONLY`.

---

## The honest caveat

This checklist is built from **one real customer and one synthetic one I designed**. A business
with two-stage approval, or approval thresholds by value, would hit a wall: PCC has one approval
step and no concept of an amount threshold, and that is design work rather than configuration.

Ask early: *"Does anyone have to approve above a certain amount?"* If yes, this checklist is
incomplete and the gap is real.
