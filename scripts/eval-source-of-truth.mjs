// ---------------------------------------------------------------------------
// eval-source-of-truth.mjs — can somebody deploy the wrong code by following
// our own instructions?
//
// THE TRAP THIS GUARDS. This repository's default branch does not contain the
// purchasing application at all, and a branch whose name reads like the obvious
// one — `claude/purchasing-control-center` — contains a version of it with none
// of the packaging, the startup safety or the deployment documentation. So the
// two things an operator does by reflex, `git clone <url>` and "clone the one
// that sounds right", both produce something that cannot be installed, and
// neither says so.
//
// Documentation is the only thing standing between that and a bad afternoon,
// which makes the documentation load-bearing — and load-bearing documentation
// should be tested like anything else. This suite asserts that every
// install-facing document names the same branch, that none of them tells
// somebody to clone without naming it, and that the file explaining all of this
// exists and carries the migration procedure for the day the repository moves
// to a Lippolis-controlled remote.
//
// It cannot check what is true of the REMOTE — branch names, default branch,
// who has access. Those are facts about a GitHub account, not about this tree.
// ---------------------------------------------------------------------------

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The one branch that may be deployed. Changing it means changing every document below. */
const BRANCH = 'pcc-production';

let pass = 0;
const fails = [];
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fails.push(name + (detail ? ` — ${detail}` : '')); console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const read = (p) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), 'utf8') : '');

console.log('--- the file that names the branch ------------------------------');

const sot = read('SOURCE_OF_TRUTH.md');
ok(sot !== '', 'SOURCE_OF_TRUTH.md exists at the repository root');
ok(sot.includes(`--branch ${BRANCH}`), `it gives a clone command naming ${BRANCH}`);
ok(/default branch/i.test(sot), 'it says the default branch is not the one to use');
ok(sot.includes('claude/purchasing-control-center'),
   'it names the confusingly-named stale branch, rather than leaving it to be discovered');
ok(/Lippolis-controlled|Lippolis organization/i.test(sot),
   'and it carries the migration procedure for the eventual Lippolis remote');
ok(/Set the default branch/i.test(sot),
   'including the step that makes a bare clone correct — setting the new default branch');
ok(/PCC_RELEASE/.test(sot), 'and how to tell which revision a running server is on');

console.log('--- every document somebody installs from -----------------------');

const INSTALL_DOCS = [
  'PCC_VM_INSTALLATION_RUNBOOK.md',
  'docs/deployment/PCC_IT_DEPLOYMENT_HANDOFF.md',
  'docs/deployment/PCC_IT_INSTALLATION_PACKET.md',
];

for (const path of INSTALL_DOCS) {
  const doc = read(path);
  ok(doc !== '', `${path} exists`);
  ok(doc.includes(BRANCH), `${path} names ${BRANCH}`);
  ok(/SOURCE_OF_TRUTH\.md/.test(doc), `${path} points at SOURCE_OF_TRUTH.md`);
}

// A `git clone` with no branch in an install document is the defect itself.
for (const path of INSTALL_DOCS) {
  const doc = read(path);
  const clones = [...doc.matchAll(/^.*git clone .*$/gm)].map((m) => m[0].trim());
  const bare = clones.filter((line) => !line.includes('--branch') && !line.includes('<new-repository-url>'));
  ok(bare.length === 0, `${path} never tells anybody to clone without naming the branch`, bare.join(' | '));
}

// The runbook is the authoritative installation document, so it gets one more:
// a way to notice immediately that the wrong branch was cloned.
const runbook = read('PCC_VM_INSTALLATION_RUNBOOK.md');
ok(/ls Dockerfile deploy\//.test(runbook),
   'the runbook has the operator check for files that only exist on the right branch');

console.log('--- production ownership is a role, not a person ----------------');

// A production deployment must not institutionally depend on one developer.
// These are the files IT reads while creating and storing production secrets.
for (const path of ['.env.example', 'docs/deployment/PCC_SECRETS_CHECKLIST.md']) {
  const doc = read(path);
  ok(doc !== '', `${path} exists`);
  ok(!/\bJACK\b|\bJack\b/.test(doc),
     `${path} does not name an individual as the owner of production credentials`,
     (/.*\b(JACK|Jack)\b.*/.exec(doc)?.[0] ?? '').trim());
}
const secrets = read('docs/deployment/PCC_SECRETS_CHECKLIST.md');
ok(/Lippolis IT/.test(secrets), 'the secrets checklist assigns creation to Lippolis IT');
ok(/No secret value appears in this repository/i.test(secrets),
   'and states that no secret value belongs in the repository');

console.log('');
for (const f of fails) console.log(`FAILED: ${f}`);
console.log(`source-of-truth checks: ${pass} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
