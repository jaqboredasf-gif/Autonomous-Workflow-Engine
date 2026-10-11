// ---------------------------------------------------------------------------
// handoff.mjs — what can already be derived from deployment state.
//
// PCC's handoff document was written by hand. Most of it had to be: the
// reasoning, the trade-offs, the warnings about what a green health check does
// not prove. That is authorship, and generating it would produce something
// worse.
//
// But a measurable part of it is not authorship at all — it is a restatement of
// facts that already exist in the manifest, the responsibility map, the
// evidence log and the blocker list, transcribed by a person who will get one
// of them wrong eventually. That part is what this generates.
//
// THE POINT IS THE BOUNDARY, not the output. This produces the sections that
// are pure state; everything else remains hand-written and is listed as such,
// so nobody mistakes a generated skeleton for a finished handoff.
// ---------------------------------------------------------------------------

import { describeFact, isKnown } from './facts.mjs';
import { FIELDS, resolve } from './manifest.mjs';
import { blockers } from './blockers.mjs';
import { RESPONSIBILITY_DOMAINS, resolveResponsibilities, unownedDomains } from './responsibilities.mjs';
import { adapterFor } from './adapters/index.mjs';

/** Sections that are pure state and can be generated deterministically. */
export const GENERATED_SECTIONS = [
  'configuration',
  'responsibilities',
  'outstanding-blockers',
  'evidence',
  'install-plan',
];

/** Sections that are authorship and must stay hand-written. */
export const AUTHORED_SECTIONS = [
  'system-overview',
  'why-the-architecture-is-this-shape',
  'operational-warnings',
  'update-and-rollback-narrative',
  'security-notes',
];

export function generateHandoff(manifest, { evidenceLog = [], environment, version } = {}) {
  const facts = resolve(manifest);
  const org = manifest?.organization?.name ?? manifest?.organization?.id ?? 'the organization';
  const app = manifest?.application?.id ?? 'the application';
  const out = [];

  out.push(`# ${app} — deployment state for ${org}`, '');
  out.push('_Generated from the deployment manifest, responsibility map and evidence log._');
  out.push('_The reasoning, warnings and operational narrative are hand-written and are not reproduced here._', '');

  // --- configuration --------------------------------------------------------
  out.push('## Configuration', '');
  out.push('| Field | Value | How it is known |', '|---|---|---|');
  for (const path of Object.keys(FIELDS)) {
    const fact = facts[path];
    const spec = FIELDS[path];
    // A secret reference is printed; a secret value never reaches here because
    // validateManifest refuses one.
    const value = isKnown(fact) ? String(fact.value) : '_not established_';
    const how = isKnown(fact) ? `${fact.state}${fact.source ? ` (${fact.source})` : ''}` : (fact.reason ?? 'unknown');
    out.push(`| \`${path}\` | ${value} | ${how} |${spec.class === 'secret-ref' ? ' <!-- reference only -->' : ''}`);
  }
  out.push('');

  // --- responsibilities -----------------------------------------------------
  out.push('## Who owns what', '');
  const owners = resolveResponsibilities(manifest);
  out.push('| Domain | Owner |', '|---|---|');
  for (const d of RESPONSIBILITY_DOMAINS) out.push(`| ${d} | ${owners[d]} |`);
  const unowned = unownedDomains(manifest);
  if (unowned.length) {
    out.push('', `**Unowned: ${unowned.join(', ')}.** An unowned domain is not automatically a blocker, ` +
      'but it is how "nobody was actually going to do that" becomes visible before go-live rather than after.');
  }
  out.push('');

  // --- blockers -------------------------------------------------------------
  out.push('## What is outstanding', '');
  const outstanding = blockers(manifest);
  if (!outstanding.length) {
    out.push('Nothing unresolved blocks this deployment.', '');
  } else {
    out.push('| Field | Blocks | Owner | Why |', '|---|---|---|---|');
    for (const b of outstanding) {
      out.push(`| \`${b.path}\` | ${b.phase.replace('REQUIRED_BEFORE_', 'before ').toLowerCase()} | ${b.owner} | ${b.why} |`);
    }
    out.push('');
  }

  // --- evidence -------------------------------------------------------------
  out.push('## Evidence', '');
  const relevant = evidenceLog.filter((e) => (!environment || e.environment === environment) && (!version || e.version === version));
  if (!relevant.length) {
    out.push('_No evidence has been recorded for this environment and version._', '');
  } else {
    out.push('| Checked | Result | When | Produced by |', '|---|---|---|---|');
    for (const e of relevant) out.push(`| ${e.kind} | ${e.result} | ${e.at} | ${e.producedBy} |`);
    out.push('');
  }

  // --- install plan, from the adapter --------------------------------------
  out.push('## Install plan', '');
  const mgr = facts['service.manager'];
  const chosen = adapterFor(isKnown(mgr) ? mgr.value : null);
  if (!chosen.ok) {
    out.push(`_Cannot generate an install plan: ${chosen.reason}._`, '');
  } else {
    const id = manifest?.application?.id ?? 'app';
    const plan = chosen.adapter.installPlan({
      app: id,
      installPath: isKnown(facts['hosting.install_path']) ? facts['hosting.install_path'].value : `/opt/${id}`,
      dataPath: isKnown(facts['storage.data_path']) ? facts['storage.data_path'].value : `/var/lib/${id}`,
      secretsStore: isKnown(facts['secrets.store']) ? facts['secrets.store'].value : `/etc/${id}.env`,
      user: id,
    });
    out.push('```bash');
    for (const line of plan) out.push(line);
    out.push('```', '');
  }

  out.push('---', '');
  out.push(`_Generated sections: ${GENERATED_SECTIONS.join(', ')}._`);
  out.push(`_Hand-written and not generated: ${AUTHORED_SECTIONS.join(', ')}._`);

  return out.join('\n');
}

/** What a fully-populated manifest could and could not produce. For §11. */
export function handoffCoverage() {
  return {
    generated: GENERATED_SECTIONS,
    authored: AUTHORED_SECTIONS,
    note: 'Roughly the reference half of a handoff is derivable. The half that explains WHY is not, '
      + 'and generating it would produce something worse than the hand-written version.',
  };
}
