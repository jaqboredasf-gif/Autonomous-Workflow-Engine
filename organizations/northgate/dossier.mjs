// ---------------------------------------------------------------------------
// organizations/northgate/dossier.mjs — COMPANY #2, and it is fictional.
//
// A SYNTHETIC MECHANICAL CONTRACTOR, invented to answer one question: can a
// second organization be provisioned and used without editing the product? It
// is not a customer, not a prospect, and no code should be optimized for it.
//
// THE ORGANIZATION ID IS DELIBERATELY UNMARKETABLE. `org-002-trades` is not a
// slug anybody would pick for a real business, and that is the point: it is the
// tenant boundary that appears in baselines, audit records and any evidence this
// rehearsal produces, and it must be impossible to mistake rehearsal data for a
// real second customer's. The company NAME is plausible; the tenant id says
// synthetic. (It is also the id the existing authorization and purchasing
// profiles were written against, so nothing was renamed to make this read well.)
//
// THE DIFFERENCES FROM LIPPOLIS, chosen to be the ones that hurt:
//
//   · "yard", not "workshop"; "requisition", not "request"
//   · purchase orders numbered per VENDOR, not per job-and-vendor pair,
//     separated by "/" rather than "-"
//   · no workshop approver role exists at all — an OPERATIONS_MANAGER approves,
//     and no role name is shared with Lippolis
//   · two-day fulfilment, not next-day
//   · prices ARE captured at order time
//   · Windows under an MSP with no internal IT, and a different install path
//   · a different timezone, so nothing may assume Eastern
//
// WHAT IT DOES NOT DIFFER ON, on purpose: the purchasing LIFECYCLE. A business
// with a different lifecycle needs a different capability, and pretending
// otherwise inside a rehearsal would prove the opposite of what is claimed.
// ---------------------------------------------------------------------------

export const northgateDossier = {
  organization: {
    id: 'org-002-trades',
    legal_name: 'Northgate Mechanical Ltd.',
    short_name: 'Northgate',
    address: 'Mechanical Contractors · 4120 Bellview Road, Unit 6, Boise, ID 83709',
    phone: '(208) 555-0142',
    // NOT Eastern. Overdue bands and need-by dates are computed from this, so a
    // second organization in another zone is the cheapest way to find an
    // assumption about the first one's clock.
    timezone: 'America/Boise',
  },

  profile_ref: 'capability/purchasing/profiles/org-002-trades.mjs',
  authorization_ref: 'capability/purchasing/profiles/org-002-authorization.mjs',
  manifest_ref: 'deployment/examples/northgate.manifest.mjs',

  instance_data: {
    dir: 'organizations/northgate/instance',
  },

  proof: {
    // A SEPARATE NAMESPACE, and the isolation is tested adversarially. Nothing
    // Lippolis measured may be reused here, in either direction.
    baseline_id: 'northgate_purchasing_v0',
    // NOT_STARTED is the truthful answer for a company that does not exist. It
    // is not COLLECTING: nobody is collecting anything, and a rehearsal that
    // claimed otherwise would put a fabricated baseline one state away from
    // being frozen.
    baseline_state: 'NOT_STARTED',
    observation_state: 'NOT_OPENED',
  },

  pilot: {
    scope: 'purchasing-materials',
    success_measure: 'the yard stops ringing the office to ask whether something was ordered',
    exit_criteria: 'thirty days of production use, or the application owner asking to stop',
  },
};

export default northgateDossier;
