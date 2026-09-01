// ---------------------------------------------------------------------------
// import.mjs — one field sheet becomes one validated record.
//
// THREE KINDS, ONE SHAPE. Each importer reads a parsed sheet, builds the object
// the module's constructor expects, and hands it straight to that constructor —
// so the refusals live in ONE place per record type and this file cannot
// accidentally accept something the module would reject.
//
// A SHEET NAMES ITS OWN KIND, on the first line, because a founder with three
// blank sheets on a phone will eventually fill in the wrong one and an importer
// that guessed from the filename would file a mock pitch as an interview.
//
// UNKNOWN KEYS ARE ERRORS, not ignored. A typo'd `pattern-tag:` that is
// silently dropped produces an interview with no tags, which the constructor
// then refuses for a reason that has nothing to do with the actual mistake.
// ---------------------------------------------------------------------------

import { parseSheet, reader } from './field-sheet.mjs';

export const KINDS = Object.freeze(['interview', 'comprehension', 'mock-pitch']);

/**
 * @returns {{kind: string, record: object, errors: string[], id: string|null}}
 */
export async function importSheet(text, { source = 'the sheet' } = {}) {
  const { blocks, errors } = parseSheet(text);
  const head = blocks[0];
  const kindField = head.fields.get('kind');
  const kind = kindField?.value?.trim().toLowerCase();
  if (!kind) {
    errors.push(`${source}: the sheet does not say what it is. Add a first line: kind: ${KINDS.join(' | ')}`);
    return { kind: null, record: null, errors, id: null };
  }
  if (!KINDS.includes(kind)) {
    errors.push(`${source}: kind is "${kind}". One of: ${KINDS.join(', ')}`);
    return { kind: null, record: null, errors, id: null };
  }

  const built = kind === 'interview' ? importInterview(blocks, errors, source)
    : kind === 'comprehension' ? importComprehension(blocks, errors, source)
      : importMockPitch(blocks, errors, source);

  if (errors.length) return { kind, record: null, errors, id: built?.id ?? null };

  // THE CONSTRUCTOR IS THE VALIDATOR. Nothing is written until it accepts.
  try {
    if (kind === 'interview') (await import('../discovery/interview.mjs')).interview(built);
    else if (kind === 'comprehension') (await import('./comprehension.mjs')).comprehensionTest(built);
    else (await import('./mock-pitch.mjs')).mockPitch(built);
  } catch (e) {
    return { kind, record: null, errors: [`${source}: ${e.message}`], id: built?.id ?? null };
  }
  return { kind, record: built, errors: [], id: built.id };
}

/** Where a record of each kind belongs. */
export const DESTINATION = Object.freeze({
  interview: 'programs/discovery/interviews',
  comprehension: 'programs/evidence/records/comprehension',
  'mock-pitch': 'programs/evidence/records/mock-pitch',
});

function reject(r, errors, where) {
  const unused = r.unusedKeys().filter((k) => k !== 'kind');
  for (const k of unused) errors.push(`${where}: "${k}" is not a field on this sheet — check the spelling, or delete the line`);
}

function importInterview(blocks, errors, source) {
  const r = reader(blocks[0], errors, { where: source });
  const D = {
    WILLINGNESS: ['WOULD_PAY_STATED_AMOUNT', 'WOULD_PAY_UNSPECIFIED', 'WOULD_NOT_PAY', 'NOT_ASKED', 'UNCLEAR'],
    CHANGE: ['ACTIVELY_LOOKING', 'OPEN_IF_PROVEN', 'CONTENT_WITH_WORKAROUND', 'WILL_NOT_CHANGE', 'NOT_ASKED'],
    SWITCH: ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'BLOCKING', 'NOT_ASKED'],
    ROLES: ['OWNER', 'OPERATIONS', 'OFFICE_MANAGER', 'FIELD', 'FINANCE', 'IT', 'EXTERNAL_BOOKKEEPER', 'UNKNOWN'],
    UNITS: ['company', 'company_workflow', 'site', 'seat', 'usage', 'project', 'service', 'unknown'],
    KINDS: ['nothing', 'memory', 'paper', 'text_message', 'phone_call', 'email', 'spreadsheet', 'accounting_software',
      'erp', 'construction_management_software', 'custom_software', 'admin_staff', 'rpa', 'general_purpose_ai', 'other'],
  };

  const record = {
    id: r.str('id', { required: true }),
    at: r.str('at', { required: true }),
    organization: r.str('organization', { required: true }),
    organizationType: r.str('organizationType'),
    organizationSize: r.str('organizationSize'),
    role: r.str('role', { required: true }),
    internal: r.bool('internal', false),
    workflow: r.str('workflow', { required: true }),
    pain: r.testimony('pain', { required: true }),
    frequency: r.testimony('frequency'),
    humanTimeStated: r.testimony('humanTimeStated'),
    economicConsequence: r.testimony('economicConsequence'),
    existingWorkaround: r.testimony('existingWorkaround'),
    satisfactionWithWorkaround: r.testimony('satisfactionWithWorkaround'),
    urgency: r.testimony('urgency'),
    currentTools: r.list('currentTools'),
    failureModes: r.list('failureModes'),
    willingnessToChange: r.enumOf('willingnessToChange', D.CHANGE, 'NOT_ASKED'),
    willingnessToPay: r.enumOf('willingnessToPay', D.WILLINGNESS, 'NOT_ASKED'),
    statedAmount: r.str('statedAmount'),
    capabilityFit: r.str('capabilityFit'),
    patternTags: r.list('patternTags'),
    followUp: r.str('followUp'),
    designPartnerInterest: r.bool('designPartnerInterest', false),
    notes: r.str('notes'),
    alternatives: [],
    commercial: null,
  };
  reject(r, errors, source);

  for (const b of blocks.slice(1)) {
    const where = `${source} (--- ${b.name})`;
    if (b.name === 'alternative') {
      // AN UNTOUCHED BLOCK IS NOT AN ALTERNATIVE. The template ships one blank
      // block so there is something to copy; importing it would record that the
      // business uses `null`.
      if (![...b.fields.values()].some((f) => f.value !== '')) continue;
      const a = reader(b, errors, { where });
      record.alternatives.push({
        kind: a.enumOf('kind', D.KINDS),
        what: a.str('what'),
        whyUsed: a.str('whyUsed'),
        whatWorks: a.str('whatWorks'),
        whatFails: a.str('whatFails'),
        switchingCost: a.enumOf('switchingCost', D.SWITCH, 'NOT_ASKED'),
        whyNotFixed: a.str('whyNotFixed'),
        said: a.str('said'),
        quote: a.str('quote'),
      });
      reject(a, errors, where);
    } else if (b.name === 'commercial') {
      if (![...b.fields.values()].some((f) => f.value !== '')) continue;
      const c = reader(b, errors, { where });
      record.commercial = {
        buyer: c.enumOf('buyer', D.ROLES, 'UNKNOWN'),
        user: c.enumOf('user', D.ROLES, 'UNKNOWN'),
        budgetOwner: c.enumOf('budgetOwner', D.ROLES, 'UNKNOWN'),
        problemPurchased: c.str('problemPurchased'),
        deploymentUnit: c.enumOf('deploymentUnit', D.UNITS, 'unknown'),
        currentCostOfProblem: c.str('currentCostOfProblem'),
        wantsService: b.fields.has('wantsService') ? c.bool('wantsService') : null,
        said: c.str('said'),
        quote: c.str('quote'),
      };
      reject(c, errors, where);
    } else {
      errors.push(`${source}: "--- ${b.name}" is not a block this sheet has. One of: alternative, commercial`);
    }
  }
  return record;
}

function importComprehension(blocks, errors, source) {
  const r = reader(blocks[0], errors, { where: source });
  const OUTCOMES = ['PRESENT', 'GARBLED', 'ABSENT'];
  const record = {
    id: r.str('id', { required: true }),
    at: r.str('at', { required: true }),
    person: r.str('person', { required: true }),
    background: r.str('background', { required: true }),
    relationship: r.enumOf('relationship', ['STRANGER', 'ACQUAINTANCE', 'FAMILY', 'COLLEAGUE', 'INDUSTRY_INSIDER', 'AWE_INSIDER']),
    explanationVersion: r.str('version', { required: true }),
    delivery: r.enumOf('delivery', ['SPOKEN', 'WRITTEN', 'SHOWN'], 'SPOKEN'),
    restatement: r.str('restatement', { required: true }),
    verbatimEcho: r.bool('verbatimEcho', false),
    questions: r.list('questions'),
    confusions: r.list('confusion'),
    notes: r.str('notes'),
    concepts: {
      business_operations_work: r.enumOf('conceptBusinessOperationsWork', OUTCOMES, 'ABSENT'),
      execution_not_advice: r.enumOf('conceptExecutionNotAdvice', OUTCOMES, 'ABSENT'),
      company_rules: r.enumOf('conceptCompanyRules', OUTCOMES, 'ABSENT'),
      reduced_human_handling: r.enumOf('conceptReducedHumanHandling', OUTCOMES, 'ABSENT'),
    },
  };
  reject(r, errors, source);
  for (const b of blocks.slice(1)) errors.push(`${source}: a comprehension sheet has no "--- ${b.name}" block`);
  return record;
}

function importMockPitch(blocks, errors, source) {
  const r = reader(blocks[0], errors, { where: source });
  const record = {
    id: r.str('id', { required: true }),
    at: r.str('at', { required: true }),
    listener: r.enumOf('listener', ['STRANGER', 'ACQUAINTANCE', 'FAMILY', 'COLLEAGUE', 'INDUSTRY_INSIDER', 'INVESTOR_OR_JUDGE', 'TECHNICAL', 'AWE_INSIDER']),
    listenerBackground: r.str('listenerBackground', { required: true }),
    format: r.enumOf('format', ['ONE_MINUTE', 'FULL', 'DEMO_ONLY', 'QA_ONLY'], 'FULL'),
    whatTheyThoughtItWas: r.str('whatTheyThoughtItWas'),
    whatTheyRemembered: r.list('whatTheyRemembered'),
    confusingPoint: r.str('confusingPoint'),
    strongestPoint: r.str('strongestPoint'),
    skepticalQuestion: r.str('skepticalQuestion'),
    trust: r.enumOf('trust', ['WOULD_NOT_BELIEVE', 'SCEPTICAL', 'BELIEVED_WITH_RESERVATIONS', 'BELIEVED', 'NOT_ASKED'], 'NOT_ASKED'),
    demoShown: r.bool('demoShown', false),
    demoEffect: r.enumOf('demoEffect', ['NOT_SHOWN', 'NO_CHANGE', 'CLARIFIED', 'CHANGED_THEIR_MIND', 'CONFUSED_THEM'], 'NOT_SHOWN'),
    notes: r.str('notes'),
  };
  reject(r, errors, source);
  for (const b of blocks.slice(1)) errors.push(`${source}: a mock-pitch sheet has no "--- ${b.name}" block`);
  return record;
}
