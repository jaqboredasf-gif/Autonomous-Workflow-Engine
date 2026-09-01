// ---------------------------------------------------------------------------
// profiles/org-002-trades.mjs — a synthetic second trades business.
//
// Same shape of business as Lippolis — a contractor buying materials against
// jobs — differing only in the ways a real second customer plausibly would.
// Its whole purpose is to find out which differences the capability can already
// absorb and which would still require engineering.
//
// The deliberate differences:
//   · "yard" rather than "workshop"
//   · a sequential PO number per vendor, not per job-and-vendor pair
//   · office staff approve; there is no workshop approver role
//   · two-day fulfilment, not next-day
//   · prices ARE entered at order time
//
// Running the leakage test against this profile is the measurement.
// ---------------------------------------------------------------------------

export const org002TradesProfile = {
  organization: { id: 'org-002-trades', name: 'Northgate Mechanical Ltd.' },

  terminology: {
    stock_location: 'yard',
    request_noun: 'requisition',
  },

  roles: {
    // No WORKSHOP_APPROVER at all — the office approves.
    approvers: ['OFFICE', 'ADMIN'],
    orderers: ['OFFICE'],
    receivers: ['OFFICE', 'FOREMAN'],
  },

  purchasing: {
    po_numbering: 'vendor-sequence',   // not scoped by job
    po_separator: '/',
    quantity_rule: 'needed-minus-stock',
    default_fulfilment_days: 2,
    overdue_rule: 'past-need-by-and-unfulfilled',
    requires_cost_at_order: true,
  },

  // THE STANDARD FORM, and the reason is a scope decision rather than a
  // limitation. `northgate_default` is what this profile used to declare, and
  // nothing implemented it — so PO generation is now REFUSED for it rather than
  // silently drawn on Lippolis's layout and recorded under Northgate's name
  // (see pdf-adapter.ts, poTemplateFor). The refusal is correct; declaring a
  // form nobody has drawn is not.
  //
  // The standard layout already prints the organization's own name, address and
  // telephone number, so it is usable as-is. A partner's own printed form is
  // bounded custom work — one entry in PO_TEMPLATES — and is DEFERRED: it is
  // the easiest thing for a design partner to ask for and the least likely to
  // prove anything about whether the workflow helps them.
  documents: { po_template: 'awe_default' },

  // DRAFT-ONLY, and this changed as a result of the readiness gate refusing the
  // alternative. This profile used to declare `send` as a "deliberate
  // difference", which made it a difference the PRODUCT REFUSES rather than one
  // it absorbs: vendor email is pinned to draft-only by a CHECK constraint
  // because a person reviews every message before a supplier sees it.
  //
  // It also disagreed with this organization's own deployment manifest, which
  // says draft-only — two files describing one company's email policy, saying
  // opposite things. That is the exact class of drift the dossier exists to stop.
  //
  // So automatic sending is a QUALIFYING question, not a setting: a business
  // that requires it needs capability work and should not be the first external
  // pilot. The gate still refuses a profile declaring `send`, and that refusal
  // is tested — see scripts/eval-second-customer.mjs.
  communications: { vendor_channel: 'email', send_mode: 'draft-only' },

  deployment: { manifest_ref: 'deployment/examples/northgate.manifest.mjs' },
};

export default org002TradesProfile;
