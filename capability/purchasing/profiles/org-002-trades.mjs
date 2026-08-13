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
//   · the vendor email is sent, not drafted
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

  documents: { po_template: 'northgate_default' },

  communications: { vendor_channel: 'email', send_mode: 'send' },

  deployment: { manifest_ref: 'deployment/examples/org-002-synthetic.manifest.mjs' },
};

export default org002TradesProfile;
