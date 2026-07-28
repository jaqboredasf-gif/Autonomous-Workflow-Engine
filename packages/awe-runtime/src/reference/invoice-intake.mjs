// ---------------------------------------------------------------------------
// invoice-intake.mjs — the reference vertical slice.
//
// A trade business receives a supplier invoice by email. The platform reads it,
// extracts the fields, classifies the risk, records an internal draft, and then
// — only with a named human's approval — issues a payment instruction. If
// anything after the draft fails, or the human says no, the draft is voided.
//
// It exists to be the ONE workflow that exercises every control-plane guarantee
// end to end:
//
//   low-risk automated steps      read_invoice_email, extract_invoice_fields,
//                                 classify_invoice_risk         ('read')
//   an internal write             record_invoice_draft          ('write_internal')
//   a consequential step          issue_payment_instruction     ('external')
//                                   -> requires_approval -> pause
//   a compensator                 void_invoice_draft            ('write_internal')
//
// ======================= SAFETY OF THIS FILE ==============================
//
// Every adapter here is SYNTHETIC and in-memory. There is no network client, no
// SMTP, no Microsoft Graph, no bank, no n8n, no database. `issue_payment_
// instruction` writes a row to a JavaScript Map called a "ledger" and returns an
// instruction reference; it moves no money and can reach nothing that does. The
// eval suite asserts this structurally (a source-purity lint over this file),
// not by trusting the comment.
//
// The email addresses use `@example.invalid` — RFC 6761 reserves `.invalid` as
// permanently unresolvable — for the same reason the B3 outbound fixtures do: a
// synthetic record that leaks cannot reach a real mailbox.
// ---------------------------------------------------------------------------

import { createContextItem, defineTool, digest } from '../../../awe-kernel/src/index.mjs';
import { defineWorkflowManifest, defineToolGrant } from '../../../awe-control-plane/src/index.mjs';

export const REFERENCE_ORG = 'org_synthetic_alpha';
export const OTHER_ORG = 'org_synthetic_beta';
export const FIXTURE_EMAIL_DOMAIN = '@example.invalid';

// --- the synthetic world -----------------------------------------------------

/**
 * createSyntheticLedger() — the entire "outside world" this workflow can reach.
 *
 * A Map, a counter and nothing else. Kept as a factory rather than a module
 * singleton so two runs in one process cannot see each other's effects, which
 * is what lets the eval suite assert that a compensation actually removed
 * something.
 */
export function createSyntheticLedger() {
  const drafts = new Map();
  const instructions = new Map();
  const voided = [];

  return Object.freeze({
    recordDraft(draft) {
      const id = `draft_${digest(draft, { length: 12 })}`;
      drafts.set(id, { ...draft, id, status: 'draft' });
      return id;
    },
    voidDraft(id) {
      const found = drafts.get(id);
      if (found === undefined) return false;
      drafts.set(id, { ...found, status: 'void' });
      voided.push(id);
      return true;
    },
    issueInstruction(instruction) {
      const id = `instr_${digest(instruction, { length: 12 })}`;
      instructions.set(id, { ...instruction, id, status: 'issued' });
      return id;
    },
    drafts() { return [...drafts.values()].sort((a, b) => (a.id < b.id ? -1 : 1)); },
    instructions() { return [...instructions.values()].sort((a, b) => (a.id < b.id ? -1 : 1)); },
    voided() { return [...voided]; },
  });
}

// The synthetic inbox. Two tenants, so a cross-tenant read is a real test and
// not a hypothetical one.
export const SYNTHETIC_INBOX = Object.freeze({
  [REFERENCE_ORG]: Object.freeze({
    message_id: 'msg_alpha_0001',
    from: `accounts${FIXTURE_EMAIL_DOMAIN}`,
    subject: 'Invoice INV-2291 — materials, Kerrisdale job',
    received_at: '2026-07-20T08:14:00Z',
    body: [
      'Invoice INV-2291',
      'Supplier: Northgate Building Supplies',
      'Amount: 4820.00 GBP',
      'Due: 2026-08-19',
      'Purchase order: PO-7741',
    ].join('\n'),
  }),
  [OTHER_ORG]: Object.freeze({
    message_id: 'msg_beta_0001',
    from: `billing${FIXTURE_EMAIL_DOMAIN}`,
    subject: 'Invoice INV-5510 — plant hire',
    received_at: '2026-07-21T09:02:00Z',
    body: [
      'Invoice INV-5510',
      'Supplier: Ridgeway Plant Hire',
      'Amount: 610.00 GBP',
      'Due: 2026-08-04',
      'Purchase order: PO-8802',
    ].join('\n'),
  }),
});

// --- context -----------------------------------------------------------------

/**
 * The context items a run is given. Note what each one DECLARES, because the
 * control plane's guarantees are built on those labels rather than on where the
 * text came from:
 *
 *   the invoice email  -> kind 'untrusted_content', trusted: false. It is text a
 *                         third party wrote. Nothing may promote it.
 *   the payment policy -> kind 'policy', trusted: true, and non-expirable: an
 *                         operating rule does not stop applying because it is
 *                         old.
 *   the supplier record-> kind 'domain_facts': a row the platform owns.
 */
export function referenceContextItems({ org_id = REFERENCE_ORG, occurred_at = '2026-07-20T08:14:00Z' } = {}) {
  const email = SYNTHETIC_INBOX[org_id] ?? SYNTHETIC_INBOX[REFERENCE_ORG];
  return [
    createContextItem({
      id: `email_${email.message_id}`,
      kind: 'untrusted_content',
      source: 'supplier_inbox',
      org_id,
      sensitivity: 'confidential',
      trusted: false,
      priority: 400,
      occurred_at: email.received_at,
      content: email.body,
      metadata: { message_id: email.message_id, subject: email.subject },
    }),
    createContextItem({
      id: `policy_${org_id}_payment`,
      kind: 'policy',
      source: 'tenant_policy',
      org_id,
      sensitivity: 'internal',
      trusted: true,
      priority: 900,
      occurred_at,
      content: [
        'Invoices at or above 1000.00 GBP require owner approval before payment.',
        'Payment instructions are never issued without a matching purchase order.',
        'Approvers: owner, accountant.',
      ].join('\n'),
    }),
    createContextItem({
      id: `supplier_${org_id}_northgate`,
      kind: 'domain_facts',
      source: 'supplier_registry',
      org_id,
      sensitivity: 'internal',
      trusted: true,
      priority: 700,
      occurred_at,
      content: 'Northgate Building Supplies — approved supplier, terms net 30, account NG-0041.',
      metadata: { supplier_account: 'NG-0041' },
    }),
  ];
}

// --- tools -------------------------------------------------------------------

// Schema references are opaque strings by kernel design; the validators below
// bind them to actual checks at composition time.
//
// INPUT and OUTPUT schemas are separate vocabularies, and conflating them was a
// real bug caught by the first end-to-end run. A step's INPUT is the engine's
// envelope (`_run_id`, `_org_id`, `_results`, plus the manifest's literal
// input), so an input schema states which PRIOR RESULTS this step needs — which
// is exactly the precondition worth checking. A tool's OUTPUT is the value the
// adapter returned.
const SCHEMAS = Object.freeze({
  // inputs — preconditions
  inputBase: 'awe.invoice.step_input/v1',
  needsEmail: 'awe.invoice.needs_email/v1',
  needsFields: 'awe.invoice.needs_fields/v1',
  needsDraft: 'awe.invoice.needs_draft/v1',
  // outputs
  email: 'awe.invoice.email/v1',
  fields: 'awe.invoice.fields/v1',
  risk: 'awe.invoice.risk/v1',
  draft: 'awe.invoice.draft/v1',
  instruction: 'awe.invoice.instruction/v1',
  voidResult: 'awe.invoice.void/v1',
});

const AMOUNT = /Amount:\s*([0-9]+(?:\.[0-9]{1,2})?)\s*([A-Z]{3})/;
const INVOICE = /Invoice\s+(INV-[0-9]+)/;
const PO = /Purchase order:\s*(PO-[0-9]+)/;
const DUE = /Due:\s*(\d{4}-\d{2}-\d{2})/;

/**
 * referenceTools({ ledger, failures })
 *
 * `failures` is the deterministic failure-injection surface the eval suite and
 * the simulator use: `{ [tool_name]: 'throw' | 'slow' }`. It lives on the
 * ADAPTER rather than in the engine, so failure injection needs no special path
 * through the control plane and cannot accidentally be reachable in a real
 * composition — a caller who passes nothing gets no injection.
 */
export function referenceTools({ ledger, failures = {}, advance = null } = {}) {
  const inject = async (name) => {
    const mode = failures[name];
    if (mode === undefined) return;
    if (mode === 'throw') throw new Error(`synthetic failure injected into '${name}'`);
    if (typeof mode === 'number' && advance !== null) advance(mode); // simulated duration, in ms
  };

  return [
    {
      descriptor: defineTool({
        name: 'read_invoice_email',
        version: '1.0.0',
        description: 'Read the supplier invoice email for this tenant from the synthetic inbox.',
        workflow_id: 'invoice_intake_approval',
        input_schema: SCHEMAS.inputBase,
        output_schema: SCHEMAS.email,
        side_effect: 'read',
        requires_tenant: true,
      }),
      async adapter(input, { context }) {
        await inject('read_invoice_email');
        const email = SYNTHETIC_INBOX[context.org_id];
        if (email === undefined) throw new Error(`no synthetic inbox for tenant '${context.org_id}'`);
        return { message_id: email.message_id, subject: email.subject, body: email.body, received_at: email.received_at };
      },
    },
    {
      descriptor: defineTool({
        name: 'extract_invoice_fields',
        version: '1.1.0',
        description: 'Extract invoice number, amount, currency, due date and purchase order from the email body.',
        workflow_id: 'invoice_intake_approval',
        input_schema: SCHEMAS.needsEmail,
        output_schema: SCHEMAS.fields,
        side_effect: 'read',
        requires_tenant: true,
      }),
      async adapter(input) {
        await inject('extract_invoice_fields');
        const body = input._results?.read_email?.body ?? '';
        const amount = AMOUNT.exec(body);
        const invoice = INVOICE.exec(body);
        const po = PO.exec(body);
        const due = DUE.exec(body);
        // Deterministic and grounded: every field is a literal substring of the
        // source. Nothing is inferred, so nothing can be hallucinated — the same
        // G11 rule the B2 classification workflow already holds itself to.
        return {
          invoice_number: invoice === null ? null : invoice[1],
          amount: amount === null ? null : Number(amount[1]),
          currency: amount === null ? null : amount[2],
          due_date: due === null ? null : due[1],
          purchase_order: po === null ? null : po[1],
          grounded: invoice !== null && amount !== null && po !== null,
        };
      },
    },
    {
      descriptor: defineTool({
        name: 'classify_invoice_risk',
        version: '1.0.0',
        description: 'Classify the invoice against the tenant payment policy threshold.',
        workflow_id: 'invoice_intake_approval',
        input_schema: SCHEMAS.needsFields,
        output_schema: SCHEMAS.risk,
        side_effect: 'read',
        requires_tenant: true,
      }),
      async adapter(input) {
        await inject('classify_invoice_risk');
        const fields = input._results?.extract_fields ?? {};
        const threshold = input.approval_threshold ?? 1000;
        return {
          band: (fields.amount ?? 0) >= threshold ? 'requires_owner_approval' : 'routine',
          amount: fields.amount ?? null,
          threshold,
          has_purchase_order: fields.purchase_order !== null && fields.purchase_order !== undefined,
        };
      },
    },
    {
      descriptor: defineTool({
        name: 'record_invoice_draft',
        version: '1.0.0',
        description: 'Record an internal, unapproved invoice draft in the synthetic ledger.',
        workflow_id: 'invoice_intake_approval',
        input_schema: SCHEMAS.needsFields,
        output_schema: SCHEMAS.draft,
        side_effect: 'write_internal',
        requires_tenant: true,
      }),
      async adapter(input, { context }) {
        await inject('record_invoice_draft');
        const fields = input._results?.extract_fields ?? {};
        const risk = input._results?.classify_risk ?? {};
        const draft_id = ledger.recordDraft({
          org_id: context.org_id,
          run_id: context.run_id,
          invoice_number: fields.invoice_number,
          amount: fields.amount,
          currency: fields.currency,
          purchase_order: fields.purchase_order,
          band: risk.band ?? null,
        });
        return { draft_id, status: 'draft', amount: fields.amount ?? null };
      },
    },
    {
      descriptor: defineTool({
        name: 'issue_payment_instruction',
        version: '1.0.0',
        description: 'Issue a payment instruction for an approved invoice draft. Consequential: requires human approval.',
        workflow_id: 'invoice_intake_approval',
        input_schema: SCHEMAS.needsDraft,
        output_schema: SCHEMAS.instruction,
        // 'external' is the highest side-effect class and is what puts this step
        // at or above the manifest's approval threshold.
        side_effect: 'external',
        requires_tenant: true,
      }),
      async adapter(input, { context }) {
        await inject('issue_payment_instruction');
        const draft = input._results?.record_draft ?? {};
        const fields = input._results?.extract_fields ?? {};
        if (!draft.draft_id) throw new Error('cannot issue a payment instruction without a recorded draft');
        const instruction_id = ledger.issueInstruction({
          org_id: context.org_id,
          draft_id: draft.draft_id,
          invoice_number: fields.invoice_number,
          amount: fields.amount,
          currency: fields.currency,
        });
        return { instruction_id, draft_id: draft.draft_id, amount: fields.amount ?? null, status: 'issued' };
      },
    },
    {
      descriptor: defineTool({
        name: 'void_invoice_draft',
        version: '1.0.0',
        description: 'Void a recorded invoice draft. The compensation for record_invoice_draft.',
        workflow_id: 'invoice_intake_approval',
        input_schema: SCHEMAS.needsDraft,
        output_schema: SCHEMAS.voidResult,
        side_effect: 'write_internal',
        requires_tenant: true,
      }),
      async adapter(input) {
        await inject('void_invoice_draft');
        const draft = input._results?.record_draft ?? {};
        // A compensator that cannot find its target reports so rather than
        // claiming success: `voided: false` becomes `compensation.failed`.
        const voided = draft.draft_id ? ledger.voidDraft(draft.draft_id) : false;
        if (!voided) throw new Error(`no draft to void for step '${input.compensates}'`);
        return { voided: true, draft_id: draft.draft_id };
      },
    },
  ];
}

// --- validators --------------------------------------------------------------

// Bound to the descriptors' opaque schema references at composition time. Small
// and hand-written on purpose: the kernel keeps schema references opaque so it
// depends on no validator library, and this composition honours that.
export function referenceValidators() {
  const ok = { ok: true, errors: [] };
  const no = (...errors) => ({ ok: false, errors });
  const required = (value, keys) => {
    const missing = keys.filter((k) => value?.[k] === undefined || value?.[k] === null);
    return missing.length === 0 ? ok : no(`missing ${missing.join(', ')}`);
  };
  // Every step input carries the engine's envelope. A step that arrives without
  // its tenant or its run id is not a step the platform can attribute.
  const envelope = (v) => required(v, ['_run_id', '_org_id', '_results']);
  const after = (v, step, keys) => {
    const base = envelope(v);
    if (!base.ok) return base;
    const produced = v._results?.[step];
    if (produced === undefined) return no(`step '${step}' has not produced a result yet`);
    return required(produced, keys);
  };

  return {
    // --- inputs (preconditions) ---
    [SCHEMAS.inputBase]: envelope,
    [SCHEMAS.needsEmail]: (v) => after(v, 'read_email', ['message_id', 'body']),
    [SCHEMAS.needsFields]: (v) => {
      const base = after(v, 'extract_fields', ['invoice_number', 'amount', 'currency', 'purchase_order']);
      if (!base.ok) return base;
      // The G11 rule, enforced at the boundary rather than trusted: a downstream
      // step never consumes an extraction that is not grounded in the source.
      return v._results.extract_fields.grounded === true
        ? ok
        : no('extraction is not grounded in the source text');
    },
    [SCHEMAS.needsDraft]: (v) => after(v, 'record_draft', ['draft_id', 'status']),

    // --- outputs ---
    [SCHEMAS.email]: (v) => required(v, ['message_id', 'body', 'received_at']),
    [SCHEMAS.fields]: (v) => required(v, ['invoice_number', 'amount', 'currency', 'purchase_order', 'grounded']),
    [SCHEMAS.risk]: (v) => required(v, ['band', 'threshold']),
    [SCHEMAS.draft]: (v) => required(v, ['draft_id', 'status']),
    [SCHEMAS.instruction]: (v) => required(v, ['instruction_id', 'draft_id', 'status']),
    [SCHEMAS.voidResult]: (v) => required(v, ['voided', 'draft_id']),
  };
}

// --- manifests ---------------------------------------------------------------

/**
 * The dependency: a tiny, promoted workflow that owns the tenant's payment
 * policy. It exists so the reference workflow has a REAL dependency to resolve
 * rather than a declared-and-ignored one, and so "missing dependency" is a
 * removable fixture rather than a hypothetical.
 */
export function tenantPolicyManifest({ promotion_status = 'promoted' } = {}) {
  return defineWorkflowManifest({
    workflow_id: 'tenant_payment_policy',
    version: '1.0.0',
    title: 'Tenant payment policy',
    description: 'Publishes the tenant payment-approval threshold consumed by invoice intake.',
    tenant_scope: { mode: 'allow_list', org_ids: [REFERENCE_ORG] },
    required_tools: [{ name: 'read_invoice_email', version: '^1.0.0', max_side_effect: 'read' }],
    required_context: [],
    approval_policy: {},
    limits: { step_timeout_ms: 5000, run_timeout_ms: 30_000, max_attempts: 1 },
    dependencies: [],
    risk: 'low',
    promotion: promotion_status === 'promoted'
      ? { status: 'promoted', promoted_at: '2026-07-01T09:00:00Z', promoted_by: 'jack' }
      : { status: promotion_status },
    steps: [{ id: 'publish_policy', tool: 'read_invoice_email', description: 'Publish the policy threshold.' }],
  });
}

/**
 * invoiceIntakeManifest(overrides)
 *
 * The reference manifest. `overrides` exists for the eval suite: every negative
 * case (unpromoted, out of scope, incompatible tool version, missing
 * dependency) is this same manifest with ONE field changed, so a passing
 * negative test proves the guard fired rather than proving two unrelated
 * manifests behave differently.
 */
export function invoiceIntakeManifest({
  version = '1.2.0',
  promotion_status = 'promoted',
  org_ids = [REFERENCE_ORG],
  tool_versions = {},
  dependencies = [{ workflow_id: 'tenant_payment_policy', version: '^1.0.0' }],
  approval_threshold = 'external',
  risk = 'high',
  limits = {},
  extra_steps = [],
} = {}) {
  const toolVersion = (name, fallback) => tool_versions[name] ?? fallback;

  return defineWorkflowManifest({
    workflow_id: 'invoice_intake_approval',
    version,
    title: 'Invoice intake and payment approval',
    description:
      'Read a supplier invoice, extract and classify it, record an internal draft, and — only with a named human approval — issue a payment instruction. Voids the draft on failure or denial.',
    tenant_scope: { mode: 'allow_list', org_ids },
    required_tools: [
      { name: 'read_invoice_email', version: toolVersion('read_invoice_email', '^1.0.0'), max_side_effect: 'read' },
      { name: 'extract_invoice_fields', version: toolVersion('extract_invoice_fields', '^1.1.0'), max_side_effect: 'read' },
      { name: 'classify_invoice_risk', version: toolVersion('classify_invoice_risk', '^1.0.0'), max_side_effect: 'read' },
      { name: 'record_invoice_draft', version: toolVersion('record_invoice_draft', '^1.0.0'), max_side_effect: 'write_internal' },
      { name: 'issue_payment_instruction', version: toolVersion('issue_payment_instruction', '^1.0.0'), max_side_effect: 'external' },
      { name: 'void_invoice_draft', version: toolVersion('void_invoice_draft', '^1.0.0'), max_side_effect: 'write_internal' },
    ],
    required_context: [
      { kind: 'untrusted_content', source: 'supplier_inbox', min_items: 1, max_sensitivity: 'confidential' },
      { kind: 'policy', source: 'tenant_policy', min_items: 1, max_sensitivity: 'internal' },
      { kind: 'domain_facts', source: 'supplier_registry', min_items: 1, max_sensitivity: 'internal' },
    ],
    approval_policy: {
      requires_approval_at_or_above: approval_threshold,
      approver_roles: ['accountant', 'owner'],
      quorum: 1,
    },
    limits: { step_timeout_ms: 5000, run_timeout_ms: 120_000, max_attempts: 2, retry_backoff_ms: 100, ...limits },
    dependencies,
    // 'high' is what obliges the manifest to carry an approval threshold and
    // named approver roles — see manifest.mjs. Overridable so the eval suite can
    // build an UNGATED variant and exercise the failure/compensation paths
    // without the approval pause standing in the way.
    risk,
    promotion: promotion_status === 'promoted'
      ? { status: 'promoted', promoted_at: '2026-07-15T10:30:00Z', promoted_by: 'jack' }
      : { status: promotion_status },
    steps: [
      { id: 'read_email', tool: 'read_invoice_email', description: 'Read the supplier invoice email.' },
      { id: 'extract_fields', tool: 'extract_invoice_fields', description: 'Extract the invoice fields, grounded in the source text.' },
      { id: 'classify_risk', tool: 'classify_invoice_risk', description: 'Classify against the tenant threshold.', input: { approval_threshold: 1000 } },
      { id: 'record_draft', tool: 'record_invoice_draft', description: 'Record the internal draft.', on_failure: 'fail' },
      {
        id: 'issue_payment',
        tool: 'issue_payment_instruction',
        description: 'Issue the payment instruction. Consequential — requires human approval.',
        on_failure: 'compensate',
      },
      {
        id: 'void_draft',
        tool: 'void_invoice_draft',
        description: 'Compensation: void the recorded draft.',
        compensates: 'record_draft',
      },
      ...extra_steps,
    ],
  });
}

/**
 * The tenant grants. This is the deny-by-default line made concrete: tenant
 * `org_synthetic_alpha` is granted these six tools in this workflow, at these
 * ceilings, and `org_synthetic_beta` is granted nothing — so the "unauthorized
 * tenant" case is a real tenant with a real, empty grant set.
 */
export function referenceGrants({ org_id = REFERENCE_ORG, tools = null, max_side_effect = null } = {}) {
  const all = [
    ['read_invoice_email', 'read'],
    ['extract_invoice_fields', 'read'],
    ['classify_invoice_risk', 'read'],
    ['record_invoice_draft', 'write_internal'],
    ['issue_payment_instruction', 'external'],
    ['void_invoice_draft', 'write_internal'],
  ];
  return all
    .filter(([name]) => tools === null || tools.includes(name))
    .map(([name, ceiling]) => defineToolGrant({
      org_id,
      workflow_id: 'invoice_intake_approval',
      tool: name,
      version: '^1.0.0',
      max_side_effect: max_side_effect ?? ceiling,
      approver_roles: ['accountant', 'owner'],
    }));
}

export const REFERENCE_SCHEMAS = SCHEMAS;
