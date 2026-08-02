// ---------------------------------------------------------------------------
// eval-context-validator.mjs — Runner V: focused tests for the context validator.
//
// Pure and deterministic: drives scripts/lib/context-validator.mjs with
// synthetic documents. No fixtures on disk, no DB, no network. Each check is
// paired — one input that must pass and one that must fail — so a validator that
// accepts everything (or rejects everything) cannot go green.
//
// Usage: node scripts/eval-context-validator.mjs
// ---------------------------------------------------------------------------

import {
  REQUIRED_FILES, ALLOWED_STATUSES,
  checkNotEmpty, checkRequiredSections, checkStatusVocabulary, checkDates,
  checkSecrets, checkHandoffAnchors, checkPacketFields, extractRepoPaths, validateDocument,
} from './lib/context-validator.mjs';

let passed = 0, failed = 0;
const check = (cond, label) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}`);
  cond ? passed++ : failed++;
};
const section = (s) => console.log(`--- ${s} ---`);

const BODY = 'x'.repeat(300);
const DATED = `${BODY}\nLast verified: 2026-08-01\n`;

section('required file list');
check(REQUIRED_FILES.length === 10, 'ten context files are required');
check(REQUIRED_FILES.includes('AWE_IDENTITY.md'), 'identity is required');
check(REQUIRED_FILES.includes('LATEST_AGENT_HANDOFF.md'), 'handoff is required');

section('empty-file detection');
check(checkNotEmpty('X.md', '# Title only\n').length === 1, 'a title-only file is rejected');
check(checkNotEmpty('X.md', BODY).length === 0, 'a file with a real body is accepted');

section('required sections');
check(checkRequiredSections('AWE_IDENTITY.md', 'What AWE is ... What AWE is not ... Constitutional principles').length === 0,
  'identity with all phrases passes');
check(checkRequiredSections('AWE_IDENTITY.md', 'What AWE is').length === 2,
  'identity missing two phrases reports exactly two findings');
check(checkRequiredSections('UNKNOWN_FILE.md', '').length === 0, 'a file with no section rules is unconstrained');

section('status vocabulary');
for (const s of ALLOWED_STATUSES) {
  check(checkStatusVocabulary('X.md', `status is \`${s}\` today`).length === 0, `allowed status ${s} passes`);
}
check(checkStatusVocabulary('X.md', 'status is `PROBABLY_FINE` today').length === 1, 'an invented status is rejected');
check(checkStatusVocabulary('X.md', '| capability | `MOSTLY_DONE` |').length === 1, 'an invented status in a table cell is rejected');
check(checkStatusVocabulary('X.md', 'the AWE and TEGG and RLS acronyms').length === 0, 'known acronyms are not treated as statuses');
check(checkStatusVocabulary('X.md', 'set `SUPABASE_ACCESS_TOKEN` first').length === 0, 'env var names are not treated as statuses');
check(checkStatusVocabulary('X.md', 'UNRELATED_SHOUTING in prose').length === 0, 'unquoted uppercase prose is not a status claim');

section('dates');
check(checkDates('X.md', 'Last verified: 2026-08-01').length === 0, 'ISO date accepted');
check(checkDates('X.md', 'Last verified: Aug 1 2026').length === 1, 'non-ISO date rejected');
check(checkDates('X.md', 'no date at all').length === 1, 'missing date rejected');

section('secret scanning');
check(checkSecrets('X.md', 'token: ghp_' + 'a'.repeat(36)).length >= 1, 'GitHub token literal detected');
check(checkSecrets('X.md', 'AKIA' + 'A'.repeat(16)).length >= 1, 'AWS access key detected');
check(checkSecrets('X.md', '-----BEGIN PRIVATE KEY-----').length >= 1, 'private key block detected');
check(checkSecrets('X.md', 'api_key = "s3cr3tvalue123"').length >= 1, 'assigned secret value detected');
check(checkSecrets('X.md', 'https://abcdefghijklmnopq.supabase.co').length >= 1, 'project-specific supabase url detected');
check(checkSecrets('X.md', 'Never commit a password or an api key. Rotate the service role key.').length === 0,
  'prose about secrets does not trip the scanner');
check(checkSecrets('X.md', 'set SUPABASE_SERVICE_ROLE_KEY in your environment').length === 0,
  'naming an env var is not a secret');

section('handoff anchors');
check(checkHandoffAnchors('LATEST_AGENT_HANDOFF.md', 'branch codex/x @ 55c0ba5').length === 0, 'branch + SHA passes');
check(checkHandoffAnchors('LATEST_AGENT_HANDOFF.md', 'branch codex/x').length === 1, 'missing SHA rejected');
check(checkHandoffAnchors('LATEST_AGENT_HANDOFF.md', 'commit 55c0ba5').length === 1, 'missing branch rejected');

section('execution packet fields');
const FIELDS = ['Task ID', 'Objective', 'Current verified state', 'Relevant files', 'Applicable decisions',
  'Applicable policies', 'Allowed scope', 'Forbidden actions', 'Required tests', 'Required evidence',
  'Definition of done', 'Required handoff format'];
check(checkPacketFields('AGENT_EXECUTION_PACKET.md', FIELDS.join(' ')).length === 0, 'a complete packet passes');
check(checkPacketFields('AGENT_EXECUTION_PACKET.md', FIELDS.slice(0, 11).join(' ')).length === 1, 'a packet missing one field is rejected');
check(checkPacketFields('AGENT_EXECUTION_PACKET.md', '').length === FIELDS.length, 'an empty packet reports every missing field');

section('repo path extraction');
check(extractRepoPaths('see `packages/awe-kernel/src/index.mjs` now').includes('packages/awe-kernel/src/index.mjs'), 'source path extracted');
check(extractRepoPaths('see `README.md`').length === 0, 'bare filename ignored');
check(extractRepoPaths('run `npm ci` then `regression`').length === 0, 'prose in backticks ignored');
check(extractRepoPaths('`https://example.invalid/x.md`').length === 0, 'urls ignored');

section('composed document validation');
const good = `# Identity\n${DATED}\nWhat AWE is. What AWE is not. Constitutional principles.\n`;
check(validateDocument('AWE_IDENTITY.md', good).length === 0, 'a well-formed identity document passes end to end');
check(validateDocument('AWE_IDENTITY.md', '# Identity\n').length > 0, 'an empty identity document fails end to end');

section('Runner V gates');
check(failed === 0 || true, 'gate placeholder — real result reported below');

console.log(`\neval-context-validator (Runner V, pure, deterministic): passed=${passed} failed=${failed}`);
console.log(failed === 0 ? 'Runner V: PASS' : 'Runner V: FAIL');
process.exit(failed === 0 ? 0 : 1);
