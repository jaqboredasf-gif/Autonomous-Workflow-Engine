// ---------------------------------------------------------------------------
// profiles/lippolis.mjs — organization #1, exactly as PCC behaves today.
//
// Nothing here changes PCC. This is a DESCRIPTION of the behaviour already
// shipped, written in the profile's vocabulary to find out whether that
// vocabulary can express a real customer. Where it cannot, the field is marked
// as extraction debt rather than quietly softened.
// ---------------------------------------------------------------------------

export const lippolisProfile = {
  organization: { id: 'lippolis', name: 'Lippolis Electric, Inc.' },

  terminology: {
    // Their word. The concept — an internal place holding stock that reduces
    // what must be bought — is the capability; "workshop" is the label.
    stock_location: 'workshop',
    request_noun: 'request',
  },

  roles: {
    approvers: ['WORKSHOP_APPROVER', 'ADMIN'],
    orderers: ['WORKSHOP_APPROVER', 'OFFICE', 'ADMIN'],
    receivers: ['WORKSHOP_APPROVER', 'OFFICE', 'ACCOUNTING', 'ADMIN', 'FOREMAN'],
  },

  purchasing: {
    // From Mike and Paul: job + vendor + a count that starts at 1 for the pair.
    po_numbering: 'job-vendor-sequence',
    po_separator: '-',
    quantity_rule: 'needed-minus-stock',
    default_fulfilment_days: 1,        // "order Wednesday, expect Thursday"
    overdue_rule: 'past-need-by-and-unfulfilled',
    requires_cost_at_order: false,     // accounting reconciles from the invoice
  },

  documents: { po_template: 'lippolis_default' },

  communications: {
    vendor_channel: 'email',
    // A business rule, not a limitation: a person reviews every vendor email.
    // Enforced by a CHECK constraint in the schema.
    send_mode: 'draft-only',
  },

  deployment: { manifest_ref: 'deployment/examples/pcc.manifest.mjs' },
};

export default lippolisProfile;
