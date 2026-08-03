# ESA Report SOP — the manual process

> **This is background, not instructions.** It is Paul Lippolis's own written
> procedure, reorganised — the process this automation is measured against. To
> *run* the tool, read [`OPERATOR_RUNBOOK.md`](OPERATOR_RUNBOOK.md).
>
> Kept because it is the only record of how the work is done by hand, and
> because every stage below names what is and is not automated.

Paul Lippolis's written instructions, reorganised into numbered stages. This is
the source of truth that `config/workflow.yaml` encodes. **If the manual
process changes, change this file and the workflow config together.**

Timing note: the stages are marked with how well they automate, which is what
drives the phasing in the README.

---

## Stage 1 — Create the job folder  · *fully automatable*

On `TEGG T SharedDrive`:

```
z. TEGG Job Folders (Reports Only)/
  <Company Name>/          open existing, or create
    <Site Name>/           open existing, or create
      <Year>/              create
```

## Stage 2 — Log in  · *automatable, needs selectors*

<https://tegg2.teggpro.com/auth/login> — contractor **Lippolis**.
Then: <https://tegg2.teggpro.com/sales/gm-dashboard>

## Stage 3 — Generate the certificate  · *automatable, needs selectors*

1. **Documentation** (left nav) → search *Customer Name* → select *Site Name*
   from the top dropdown.
2. **Document Library** (top nav) → **Certificates** (left sub-nav).
3. Select the *Agreement #* from the Solution dropdown.
4. **Print/Generate Document** → save the downloaded file to the job folder.

## Stage 4 — Export six reports  · *automatable, needs selectors*

**Reports** → **Standard ESA Reports**. For each report below: set the
dropdowns, **Print Report**, choose *Acrobat PDF file* from the format
dropdown, **Export**, and save into the job folder.

| # | Report (left sub-nav) | Dropdown settings |
|---|----------------------|-------------------|
| 1 | Equipment Inventory and Short Form | Agreement; Site Visit; Order By = **Locations**; Images = **Include Images** |
| 2 | Equipment Inventory and Long Form | Agreement; Record Selection = **Site Visits** |
| 3 | Equipment Item Problems and Include All Images | Contact = *first available*; Agreement; Site Visit |
| 4 | Problem Count Summary | Contact = *first available*; Agreement; Site Visit |
| 5 | Standard IR Report | Contact = *first available*; Agreement; Site Visit |
| 6 | EDS Component Problem Summary and All Problems | Contact = *first available*; Agreement; Site Visit |

Note that reports 1 and 2 take different parameters from the rest — 2 has no
Site Visit dropdown and no images setting.

## Stage 5 — Edit the certificate  · *partly automatable — see GAPS #3, #4*

Open `CertificatesXXXX.docx` from the job folder:

1. Delete the first group of checkboxes.
2. Enter the current date under **A.**
3. Under **B.**, check **Yes** for items (1)(2)(3)(4)(5)(9).
4. Under **B.**, check **No** for items (6)(7)(8)(10).
5. Save As `Certificates good.pdf` in the job folder.

## Stage 6 — Split the IR report  · *fully automatable — implemented*

From `StandardIRReport.pdf`:

- page 1 → `Cover.pdf`
- pages 2 to end → `StandardIRReport no cover.pdf`

## Stage 7 — Merge  · *fully automatable — implemented*

Combine into a single PDF, in exactly this order:

1. Cover
2. ESA Table of Contents
3. Certificates good
4. ProblemCountSummary
5. EquipmentInventoryShortForm
6. EquipmentInventoryLongForm
7. StandardIRReport no cover
8. EquipmentItemProblem_AllImages
9. EDSAllProblemsOnly
10. TEGGPro View Customer Instructions

Save as `<Company><Site><Year> ESA Report.pdf` in the job folder.
(Separator unconfirmed — see GAPS #7.)

Items 2 and 10 are the same for every job and are not exported from the
portal.
