// Evidence spec — the SINGLE source of truth for what real-world evidence looks
// like in this repo. The validator, the paper capture sheet, the CSV importer,
// the interview question script, the freeze gate and the status report all read
// THIS file, so none of them can drift from the others.
//
// Pure and offline by construction: no I/O, no network, no clock, no database.
//
// Design rules that must not be weakened for convenience:
//   1. Every measured value is a CLAIM, not a bare value, and every claim
//      carries a confidence class naming HOW it is known.
//   2. `unknown` is a first-class, preservable answer. Nothing is ever coerced
//      to a number to make a report look complete. Negative and absent evidence
//      survives.
//   3. `derived` may never be hand-entered. Only the repo produces it.
//   4. `estimated` requires a stated basis AND a low/high range, so a guess can
//      never be presented with the authority of a measurement.
//   5. Only `record_class: "production"` records count toward IIC status.
//      Rehearsal and synthetic records are structurally incapable of it.

// ---------------------------------------------------------------------------
// Confidence classes
// ---------------------------------------------------------------------------

export const CONFIDENCE = {
  documentary: {
    label: 'Documentary',
    means: 'Copied off a physical or digital artifact that exists independently of anyone’s memory.',
    requires_record: ['source_document'],
    requires_claim: [],
    value_required: true,
  },
  observed: {
    label: 'Directly observed',
    means: 'A named person watched this happen and recorded it as it happened.',
    requires_record: [],
    requires_claim: ['observed_at', 'observed_by'],
    value_required: true,
  },
  testimony: {
    label: 'Human testimony',
    means: 'A named or role-identified person stated this from their own knowledge. Not measured.',
    requires_record: [],
    requires_claim: ['attributed_to', 'stated_on'],
    value_required: true,
  },
  estimated: {
    label: 'Estimate',
    means: 'A human’s best guess. Must carry the reasoning and an honest low/high range.',
    requires_record: [],
    requires_claim: ['basis', 'range'],
    value_required: true,
  },
  derived: {
    label: 'Derived by AWE',
    means: 'Computed by this repository from other claims. NEVER hand-entered.',
    requires_record: [],
    requires_claim: [],
    value_required: true,
    machine_only: true,
  },
  unknown: {
    label: 'Unknown / not captured',
    means: 'Explicitly recorded absence of evidence. Preserved, never guessed.',
    requires_record: [],
    requires_claim: [],
    value_required: false,
  },
};

export const CONFIDENCE_KEYS = Object.keys(CONFIDENCE);

// Confidence sets used by field definitions.
const DOC = ['documentary', 'unknown'];
const OBS = ['observed', 'unknown'];
const SAY = ['testimony', 'estimated', 'unknown'];
const SAY_OBS = ['observed', 'testimony', 'estimated', 'unknown'];

export const RECORD_CLASSES = ['production', 'rehearsal', 'synthetic'];
export const COUNTABLE_RECORD_CLASS = 'production';

// ---------------------------------------------------------------------------
// Evidentiary thresholds
//
// These are DEFENSIBILITY floors chosen so a skeptical judge cannot dismiss the
// sample as one lucky week. They are not statistical significance claims and
// must never be described as such.
// ---------------------------------------------------------------------------

export const THRESHOLDS = {
  baseline_po_min: 12,          // hard floor to freeze
  baseline_po_target: 15,       // what Jack should aim to bring back
  baseline_span_days_min: 30,   // sample must straddle >= 30 days of real operation
  baseline_testimony_min: 1,    // >=1 person who actually does the work
  baseline_observation_min: 1,  // >=1 end-to-end watched run
  interviews_min: 5,
  comprehension_min: 5,
  story_facts_min: 5,
  release_approval_min: 1,
};

// ---------------------------------------------------------------------------
// Field definitions
//
// kind: string | text | date | datetime | integer | number | boolean | enum | list
// ask:  the exact thing Jack reads off the page or says out loud.
// ---------------------------------------------------------------------------

const f = (key, label, kind, confidences, opts = {}) => ({
  key, label, kind, confidences, required: false, ...opts,
});

export const RECORD_TYPES = {

  // -------------------------------------------------------------------------
  baseline_manifest: {
    label: 'Baseline manifest',
    milestone: 'LIPPOLIS_BASELINE',
    one_per: 'baseline_id',
    summary:
      'Declares the boundary of a pre-AWE baseline BEFORE any records are captured. ' +
      'Declaring scope after seeing the data is how baselines get gamed; this file ' +
      'is what proves the scope was fixed in advance.',
    meta: [
      f('baseline_id', 'Baseline id (slug)', 'string', null, { required: true, meta: true }),
      f('organization', 'Organization', 'string', null, { required: true, meta: true }),
      f('process_scope', 'Exactly which process this baseline covers', 'text', null, {
        required: true, meta: true,
        ask: 'e.g. "Materials purchasing: need identified on a job → PO written → order placed with vendor → PO filed."',
      }),
      f('window_start', 'Baseline window start (earliest PO date allowed)', 'date', null, { required: true, meta: true }),
      f('window_end', 'Baseline window end (latest PO date allowed)', 'date', null, { required: true, meta: true }),
      f('declared_by', 'Who declared this scope', 'string', null, { required: true, meta: true }),
      f('declared_at', 'When scope was declared (before capture)', 'datetime', null, { required: true, meta: true }),
      f('awe_production_start', 'Date AWE first touched this process in production (null if never)', 'date', null, {
        required: true, nullable: true, meta: true,
        ask: 'CONTAMINATION CUTOFF. Any PO dated on/after this is rejected from the baseline.',
      }),
      f('inclusion_rule', 'What is IN scope', 'text', null, { required: true, meta: true }),
      f('exclusion_rule', 'What is OUT of scope', 'text', null, { required: true, meta: true }),
      f('sampling_method', 'How POs were chosen from the binder', 'text', null, {
        required: true, meta: true,
        ask: 'Say the truth: "every PO in the 2026 binder between these dates" or "every 3rd" or "all that were legible". Cherry-picking disclosed is survivable; cherry-picking hidden is fatal.',
      }),
      f('sampling_exhaustive', 'Did you transcribe EVERY PO in the window, with none skipped?', 'boolean', null, {
        required: true, meta: true,
        ask: 'Answer honestly — this single flag decides whether PO VOLUME can be computed from '
          + 'your sample at all. 13 POs pulled from a six-month binder says nothing about how many '
          + 'POs per week the company writes; 13 POs that are ALL the POs in that window says '
          + 'everything. If false, volume falls back to testimony and is labelled as such.',
      }),
    ],
    fields: [],
  },

  // -------------------------------------------------------------------------
  baseline_po: {
    label: 'Baseline purchase order (documentary)',
    milestone: 'LIPPOLIS_BASELINE',
    summary:
      'One physical pre-AWE purchase order, transcribed. DOCUMENTARY ONLY — every ' +
      'field here must be readable off the page. Anything you have to ask a person ' +
      'about belongs in a baseline_testimony record instead, so the two confidence ' +
      'classes can never blur together in a spreadsheet.',
    csv_importable: true,
    meta: [
      f('baseline_id', 'Baseline id', 'string', null, { required: true, meta: true }),
    ],
    fields: [
      f('po_number', 'PO number', 'string', DOC, { required: true, csv: true,
        ask: 'The number preprinted or written on the PO.' }),
      f('po_date', 'Date on the PO', 'date', DOC, { required: true, csv: true,
        ask: 'The date written on the PO itself — not today’s date.' }),
      f('vendor', 'Vendor / supplier', 'string', DOC, { required: true, csv: true }),
      f('job_reference', 'Job / project reference (or STOCK)', 'string', DOC, { required: true, csv: true,
        ask: 'Job name or number. If it is shop stock with no job, write STOCK.' }),
      f('requested_by', 'Who requested it (name or role on the page)', 'string', DOC, { required: true, csv: true }),
      f('line_item_count', 'Number of line items', 'integer', DOC, { required: true, csv: true }),
      f('document_form', 'Physical form of the document', 'enum', DOC, { required: true, csv: true,
        values: ['handwritten_carbon', 'handwritten_pad', 'typed_printed', 'faxed', 'other'] }),
      f('approved_by', 'Who approved it (name on the page)', 'string', DOC, { csv: true }),
      f('approval_marking', 'How approval is marked', 'enum', DOC, { csv: true,
        values: ['signature', 'initials', 'stamp', 'none', 'illegible'] }),
      f('total_amount', 'Total amount on the PO', 'number', DOC, { csv: true, unit: 'USD' }),
      f('needed_by_date', 'Needed-by / delivery date on the PO', 'date', DOC, { csv: true }),
      f('amendments_on_face', 'Count of crossed-out / rewritten / corrected entries', 'integer', DOC, { csv: true,
        ask: 'Count visible corrections on the page. This is DOCUMENTARY evidence of rework — do not skip it.' }),
      f('received_marking', 'Evidence the goods were received', 'enum', DOC, { csv: true,
        values: ['signed_received', 'packing_slip_attached', 'none', 'illegible'] }),
      f('vendor_confirmation', 'Vendor confirmation / order number written on it', 'string', DOC, { csv: true }),
      f('legibility', 'How legible the document is', 'enum', DOC, { csv: true,
        values: ['clear', 'partial', 'poor'] }),
    ],
  },

  // -------------------------------------------------------------------------
  baseline_testimony: {
    label: 'Baseline process testimony',
    milestone: 'LIPPOLIS_BASELINE',
    summary:
      'What the people who actually run this process say about it. NEVER documentary. ' +
      'This is where the numbers that cannot be read off paper live — touch time, ' +
      'call volume, rework, lost POs.',
    meta: [
      f('baseline_id', 'Baseline id', 'string', null, { required: true, meta: true }),
      f('respondent_role', 'Respondent’s role', 'string', null, { required: true, meta: true }),
      f('respondent_name', 'Respondent’s name (optional — consent)', 'string', null, { meta: true }),
      f('does_this_work_personally', 'Does this person personally do this work?', 'boolean', null, {
        required: true, meta: true,
        ask: 'A manager describing someone else’s job is weaker evidence. Record it honestly.' }),
    ],
    fields: [
      f('touch_time_minutes_per_po', 'Minutes of human hands-on time per PO', 'number', SAY, { required: true, unit: 'minutes',
        ask: 'From "we need this" to "the PO is filed" — total minutes a person is actually working on it.' }),
      f('people_involved_count', 'How many different people touch one PO', 'integer', SAY, { required: true }),
      f('calls_per_po', 'Phone calls / callbacks per PO', 'number', SAY, { unit: 'calls' }),
      f('po_volume_per_week', 'POs written per week', 'number', SAY, { required: true, unit: 'POs/week' }),
      f('rework_rate_pct', 'Share of POs needing correction/re-doing', 'number', SAY, { unit: 'percent' }),
      f('delay_hours_need_to_order', 'Hours from need identified to order actually placed', 'number', SAY, { unit: 'hours' }),
      f('lost_po_frequency', 'How often a PO goes missing and is re-created', 'string', SAY),
      f('approver_absent_handling', 'What happens when the approver is out', 'text', SAY),
      f('filing_location', 'Where the paper physically ends up', 'text', SAY),
      f('worst_part', 'Worst part of this process, in their words', 'text', SAY,
        { ask: 'Write the words they actually used. Quote, do not paraphrase.' }),
    ],
  },

  // -------------------------------------------------------------------------
  baseline_observation: {
    label: 'Baseline direct observation',
    milestone: 'LIPPOLIS_BASELINE',
    summary:
      'Jack physically watching ONE purchase order go end-to-end with a stopwatch. ' +
      'This is the strongest baseline evidence available and the only thing that ' +
      'converts testimony estimates into measured time.',
    meta: [
      f('baseline_id', 'Baseline id', 'string', null, { required: true, meta: true }),
      f('observed_on', 'Date of observation', 'date', null, { required: true, meta: true }),
      f('observer', 'Who observed', 'string', null, { required: true, meta: true }),
      f('subject_role', 'Role of the person being observed', 'string', null, { required: true, meta: true }),
      f('po_reference', 'Which PO was watched', 'string', null, { required: true, meta: true }),
      f('subject_knew_observed', 'Did the subject know they were being timed?', 'boolean', null, {
        required: true, meta: true,
        ask: 'Observer effect is real. Record it rather than pretending it is absent.' }),
    ],
    fields: [
      f('elapsed_minutes_total', 'Wall-clock minutes, first touch to filed', 'number', OBS, { required: true, unit: 'minutes' }),
      f('hands_on_minutes', 'Minutes actually working on it', 'number', OBS, { required: true, unit: 'minutes' }),
      f('wait_minutes', 'Minutes waiting on someone else', 'number', OBS, { unit: 'minutes' }),
      f('handoff_count', 'Number of handoffs between people', 'integer', OBS, { required: true }),
      f('interruption_count', 'Times the work was interrupted', 'integer', OBS),
      f('call_count', 'Phone calls made', 'integer', OBS),
      f('steps', 'Ordered steps as actually performed', 'list', OBS, { required: true }),
      f('failures_seen', 'Anything that went wrong during the observation', 'text', OBS),
    ],
  },

  // -------------------------------------------------------------------------
  interview: {
    label: 'External contractor interview',
    milestone: 'EXTERNAL_INTERVIEWS',
    summary:
      'A real conversation with a real contractor who is NOT Lippolis. This is the ' +
      'only evidence that AWE addresses a market rather than one company’s habits.',
    meta: [
      f('interview_date', 'Date of interview', 'date', null, { required: true, meta: true }),
      f('interviewer', 'Who conducted it', 'string', null, { required: true, meta: true }),
      f('organization_type', 'Type of organization', 'enum', null, { required: true, meta: true,
        values: ['electrical', 'plumbing', 'hvac', 'general_contractor', 'mechanical', 'roofing', 'other_trade', 'other'] }),
      f('organization_size', 'Rough headcount', 'string', null, { meta: true }),
      f('interviewee_role', 'Their role', 'string', null, { required: true, meta: true }),
      f('relationship', 'How you know them', 'enum', null, { required: true, meta: true,
        values: ['cold', 'warm_intro', 'existing_relationship', 'family_or_friend'],
        ask: 'A friend telling you it is a great idea is weak evidence. Record the relationship so the bias is visible.' }),
      f('medium', 'How the interview happened', 'enum', null, { required: true, meta: true,
        values: ['in_person', 'phone', 'video', 'written'] }),
      f('duration_minutes', 'Length in minutes', 'integer', null, { meta: true }),
      f('consent_to_quote', 'Did they consent to being quoted?', 'boolean', null, { required: true, meta: true }),
      f('recorded', 'Was it recorded?', 'boolean', null, { required: true, meta: true }),
      f('pitched_before_asking', 'Did you describe AWE before asking about their problems?', 'boolean', null, {
        required: true, meta: true,
        ask: 'TRUE poisons the pain answers — people agree with whatever you just described. Ask about their world FIRST. Record the truth either way.' }),
    ],
    fields: [
      f('current_process', 'How they do this today, step by step', 'text', SAY_OBS, { required: true,
        ask: 'Walk me through the last time you ordered materials for a job. Start from the moment you knew you needed something.' }),
      f('workflow_pain', 'What actually hurts', 'text', SAY_OBS, { required: true,
        ask: 'What part of that is the biggest headache? Tell me about the last time it went wrong.' }),
      f('current_alternatives', 'Software/tools/workarounds they already use', 'text', SAY_OBS, { required: true,
        ask: 'What have you tried? What are you using now, even if it is paper or a spreadsheet?' }),
      f('delays_errors_rework', 'Concrete delays, errors, rework they described', 'text', SAY_OBS, { required: true,
        ask: 'When it goes wrong, what does it cost you — time, money, a callback?' }),
      f('frequency', 'How often it happens', 'string', SAY_OBS,
        { ask: 'How many times a week does that happen?' }),
      f('severity', 'How bad it is when it happens', 'enum', SAY_OBS, {
        values: ['annoyance', 'costs_hours', 'costs_money', 'loses_jobs', 'existential'],
        ask: 'Is this an annoyance or does it actually cost you?' }),
      f('buyer', 'Who would decide to buy this', 'string', SAY_OBS, { required: true,
        ask: 'If you wanted something like this, who signs off — you, an owner, an office manager?' }),
      f('current_spend', 'What they already pay for adjacent tools', 'text', SAY_OBS,
        { ask: 'What do you pay today for software that touches this? Roughly.' }),
      f('willingness_to_change', 'How willing they are to change process', 'enum', SAY_OBS, {
        values: ['refuses', 'reluctant', 'open_if_proven', 'actively_looking', 'already_switching'],
        ask: 'If something fixed this, how hard would it be to actually get your people to use it?' }),
      f('commercial_reaction', 'Their reaction when money came up', 'text', SAY_OBS,
        { ask: 'Do NOT name a price. Ask what it would be worth to them and record what they say.' }),
      f('unit_of_sale_clues', 'What they would expect to pay FOR', 'text', SAY_OBS,
        { ask: 'Per user? Per job? Per month? Let them tell you — do not offer options.' }),
      f('direct_quotes', 'Verbatim customer language', 'list', SAY_OBS, { required: true,
        ask: 'Write their exact words. Their vocabulary is the product’s vocabulary.' }),
      f('disconfirming', 'Anything they said that argues AGAINST AWE', 'text', SAY_OBS, { required: true,
        ask: 'MANDATORY. An interview with no disconfirming evidence is an interview you ran badly. If truly none, say so explicitly.' }),
      f('uncertainty', 'What you are still unsure of after this', 'text', SAY_OBS, { required: true }),
    ],
  },

  // -------------------------------------------------------------------------
  comprehension_test: {
    label: 'Comprehension test',
    milestone: 'COMPREHENSION_TESTS',
    summary:
      'Can a person who has never heard of AWE say back what it does, unaided, ' +
      'after one exposure? Tests the STORY, not the product.',
    meta: [
      f('test_date', 'Date', 'date', null, { required: true, meta: true }),
      f('administered_by', 'Who ran the test', 'string', null, { required: true, meta: true }),
      f('tester_role', 'Who the tester is', 'string', null, { required: true, meta: true }),
      f('tester_prior_exposure', 'How much they already knew about AWE', 'enum', null, {
        required: true, meta: true,
        values: ['none', 'heard_the_name', 'discussed_before', 'deeply_familiar'],
        ask: 'Someone who has heard the pitch five times cannot comprehension-test it.' }),
      f('artifact', 'What they were shown', 'string', null, { required: true, meta: true,
        ask: 'Name the exact artifact and version/commit, e.g. "one-paragraph description, commit abc123".' }),
      f('exposure_seconds', 'How long they were exposed', 'integer', null, { meta: true }),
    ],
    fields: [
      f('prompt_used', 'The exact words you used to set it up', 'text', OBS, { required: true,
        ask: 'Record verbatim. If you explained extra out loud, the test is contaminated — say so.' }),
      f('unaided_restatement', 'Their answer to "what does this do?", verbatim', 'text', OBS, { required: true,
        ask: 'Do not help. Do not correct. Write exactly what they said, including "I don’t know".' }),
      f('identified_problem', 'Did they identify the problem it solves?', 'boolean', OBS, { required: true }),
      f('identified_buyer', 'Could they say who would buy it?', 'boolean', OBS, { required: true }),
      f('identified_mechanism', 'Could they say roughly HOW it works?', 'boolean', OBS, { required: true }),
      f('confusions', 'Everything they got wrong or found confusing', 'list', OBS, { required: true,
        ask: 'MANDATORY. This is the whole point of the test. Preserve every miss.' }),
      f('words_they_used', 'Their vocabulary for it', 'list', OBS),
      f('verdict', 'Overall comprehension', 'enum', OBS, { required: true,
        values: ['understood', 'partial', 'misunderstood', 'no_idea'] }),
    ],
  },

  // -------------------------------------------------------------------------
  founder_story_fact: {
    label: 'Founder story fact',
    milestone: 'FOUNDER_STORY',
    summary:
      'One checkable fact about how AWE actually came to exist. A fact needs a ' +
      'thing that would prove it. Narrative without a verifier goes in as ' +
      'unverified and is reported as unverified — never deleted, never promoted.',
    meta: [
      f('fact_date', 'When it happened', 'date', null, { required: true, meta: true }),
      f('category', 'Kind of fact', 'enum', null, { required: true, meta: true,
        values: ['origin', 'access', 'build', 'deployment', 'setback', 'result', 'decision'] }),
    ],
    fields: [
      f('statement', 'The fact, in one sentence', 'text', SAY_OBS, { required: true,
        ask: 'Concrete and checkable. "I shipped X on date Y", not "I have always cared about efficiency".' }),
      f('verifier', 'What would prove this to a skeptic', 'text', SAY_OBS, { required: true,
        ask: 'A commit hash, an email, a person who would confirm it, a photo. If nothing would prove it, mark verification_status unverifiable and keep it anyway.' }),
      f('verification_status', 'Verification state', 'enum', SAY_OBS, { required: true,
        values: ['verified', 'verifiable_not_yet_checked', 'unverifiable'] }),
    ],
  },

  // -------------------------------------------------------------------------
  release_approval: {
    label: 'Deployment release approval',
    milestone: 'DEPLOYMENT_APPROVAL',
    summary:
      'A real human at Lippolis authorizing AWE to run against real work. This ' +
      'record is the gate on starting a production observation window — without ' +
      'it, any "production" measurement is actually a rehearsal.',
    meta: [
      f('approval_date', 'Date of approval', 'date', null, { required: true, meta: true }),
      f('approver_name', 'Who approved', 'string', null, { required: true, meta: true }),
      f('approver_role', 'Their authority to approve', 'string', null, { required: true, meta: true }),
      f('form', 'How the approval was given', 'enum', null, { required: true, meta: true,
        values: ['written_signed', 'email', 'text_message', 'verbal_witnessed', 'verbal_unwitnessed'] }),
      f('artifact_ref', 'Where the written approval lives, if any', 'string', null, { meta: true }),
      f('commit_sha', 'Exact commit approved for production', 'string', null, { required: true, meta: true }),
    ],
    fields: [
      f('capabilities_approved', 'Exactly what AWE is allowed to do', 'list', SAY_OBS, { required: true,
        ask: 'List the specific capabilities. "AWE" is not a capability.' }),
      f('scope_limits', 'What it is explicitly NOT allowed to do', 'text', SAY_OBS, { required: true }),
      f('human_approval_retained', 'Which actions still require a human', 'text', SAY_OBS, { required: true }),
      f('data_handling_agreed', 'What was agreed about their data', 'text', SAY_OBS, { required: true }),
      f('rollback_plan', 'How to turn it off', 'text', SAY_OBS, { required: true }),
    ],
  },

  // -------------------------------------------------------------------------
  observation_window: {
    label: 'Production observation window',
    milestone: 'OBSERVATION_WINDOW',
    summary:
      'A declared span of real production use, measured against a FROZEN baseline. ' +
      'Declared in advance so the comparison cannot be retrofitted to the result.',
    meta: [
      f('window_id', 'Window id (slug)', 'string', null, { required: true, meta: true }),
      f('baseline_id', 'Frozen baseline this compares against', 'string', null, { required: true, meta: true }),
      f('baseline_freeze_hash', 'Hash of the frozen baseline at declaration', 'string', null, { required: true, meta: true }),
      f('release_approval_id', 'Release approval authorizing production use', 'string', null, { required: true, meta: true }),
      f('started_at', 'Window start', 'datetime', null, { required: true, meta: true }),
      f('ended_at', 'Window end (null while open)', 'datetime', null, { nullable: true, meta: true }),
      f('declared_by', 'Who declared it', 'string', null, { required: true, meta: true }),
      f('commit_sha', 'Commit running in production', 'string', null, { required: true, meta: true }),
    ],
    fields: [
      f('metrics_declared', 'What will be measured, declared in advance', 'list', SAY_OBS, { required: true,
        ask: 'Name the metrics BEFORE the window opens. Picking the flattering metric afterward is how case studies become worthless.' }),
      f('success_definition', 'What counts as the objective succeeding', 'text', SAY_OBS, { required: true,
        ask: 'Objective success, not task completion. "The PO reached the vendor correctly", not "the automation ran".' }),
      f('failure_definition', 'What counts as failure', 'text', SAY_OBS, { required: true }),
    ],
  },
};

export const RECORD_TYPE_KEYS = Object.keys(RECORD_TYPES);

// ---------------------------------------------------------------------------
// Milestones — what the IIC evidence status report scores.
// A milestone is met by RECORDS THAT PASS VALIDATION AND ARE production-class.
// It is never met by a file existing.
// ---------------------------------------------------------------------------

export const MILESTONES = {
  LIPPOLIS_BASELINE: {
    label: '1. Lippolis pre-AWE baseline',
    requirements: [
      { id: 'manifest', text: 'Baseline scope declared before capture', type: 'baseline_manifest', min: 1 },
      { id: 'pos', text: `>= ${THRESHOLDS.baseline_po_min} documentary POs transcribed`, type: 'baseline_po', min: THRESHOLDS.baseline_po_min },
      { id: 'span', text: `Sample spans >= ${THRESHOLDS.baseline_span_days_min} days`, custom: 'baseline_span' },
      { id: 'testimony', text: 'Testimony from someone who does the work', type: 'baseline_testimony', min: THRESHOLDS.baseline_testimony_min },
      { id: 'observation', text: 'One end-to-end timed observation', type: 'baseline_observation', min: THRESHOLDS.baseline_observation_min },
      { id: 'frozen', text: 'Baseline frozen and hash-verified', custom: 'baseline_frozen' },
    ],
  },
  COMPREHENSION_TESTS: {
    label: '2. Comprehension tests',
    requirements: [
      { id: 'count', text: `>= ${THRESHOLDS.comprehension_min} tests with unexposed testers`, type: 'comprehension_test', min: THRESHOLDS.comprehension_min, filter: 'unexposed' },
    ],
  },
  EXTERNAL_INTERVIEWS: {
    label: '3. External contractor interviews',
    requirements: [
      { id: 'count', text: `>= ${THRESHOLDS.interviews_min} interviews outside Lippolis`, type: 'interview', min: THRESHOLDS.interviews_min },
      { id: 'cold', text: '>= 2 of them not friends/family', type: 'interview', min: 2, filter: 'arms_length' },
    ],
  },
  FOUNDER_STORY: {
    label: '4. Founder story facts',
    requirements: [
      { id: 'count', text: `>= ${THRESHOLDS.story_facts_min} facts recorded`, type: 'founder_story_fact', min: THRESHOLDS.story_facts_min },
      { id: 'verified', text: '>= 3 of them verified', type: 'founder_story_fact', min: 3, filter: 'verified' },
    ],
  },
  DEPLOYMENT_APPROVAL: {
    label: '5. Deployment release approval',
    requirements: [
      { id: 'count', text: 'Named human authorized production use', type: 'release_approval', min: THRESHOLDS.release_approval_min },
    ],
  },
  OBSERVATION_WINDOW: {
    label: '6. Production observation window (gated by 1 + 5)',
    requirements: [
      { id: 'open', text: 'Window declared against a frozen baseline', type: 'observation_window', min: 1 },
    ],
  },
};

export const MILESTONE_KEYS = Object.keys(MILESTONES);

export function typeSpec(t) {
  const s = RECORD_TYPES[t];
  if (!s) throw new Error(`unknown record_type: ${t}`);
  return s;
}

export function allFields(t) {
  const s = typeSpec(t);
  return [...(s.meta || []), ...(s.fields || [])];
}
