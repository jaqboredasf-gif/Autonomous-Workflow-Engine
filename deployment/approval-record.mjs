// ---------------------------------------------------------------------------
// approval-record.mjs — who approved which commit, parsed once.
//
// WHY THIS IS ITS OWN FILE. Two things need this answer in two places that
// cannot share a module any other way:
//
//   · the deployment gate and the venture plan, in the repository, through
//     programs/iic-2027/derive.mjs;
//   · scripts/pcc-verify-deployment.mjs, on a server that holds a deployment
//     package and nothing else.
//
// derive.mjs cannot travel to the server — it reads proof/, capability/,
// programs/discovery/ and a database to build the readiness picture. So the
// server-side parse used to be a second copy of two regular expressions, and a
// test compared the copies. That test passed while the copies disagreed about
// what a placeholder signature means, which is the exact failure it existed to
// catch: comparing two implementations only works if the comparison exercises
// them, and quoting a regex in a test does not.
//
// One implementation, imported by both, is the version of that idea that works.
//
// WHAT COUNTS AS SIGNED. A name. Not a blank, not the underscore rule the
// unsigned template carries, not whitespace. This is deliberately strict in the
// direction that fails closed: a record that cannot be read as signed is
// treated as unsigned, because approving nothing is recoverable and approving
// something nobody agreed to is not.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from 'node:fs';

/** The candidate commit, or null when the record names none. */
export function parseApprovedCommit(text) {
  return /^-\s*\*\*Commit\*\*:\s*`([0-9a-f]{7,40})`/m.exec(text)?.[1] ?? null;
}

/** The signer's name, or null when nobody has signed. */
export function parseApprovedSigner(text) {
  const raw = /^-\s*\*\*Approved by\*\*:\s*(.*)$/m.exec(text)?.[1]?.trim() ?? '';
  if (!raw) return null;
  // The unsigned template's placeholder is a rule of underscores. Anything that
  // is only punctuation or whitespace is a placeholder too, whatever its shape.
  if (/^[_\-.\s]+$/.test(raw)) return null;
  return raw;
}

/**
 * Read an approval record from an absolute path.
 * Returns null when the file is absent or names no candidate — both mean
 * "nothing is approved", and the caller should not have to tell them apart.
 */
export function readApprovalRecord(absolutePath) {
  if (!existsSync(absolutePath)) return null;
  const text = readFileSync(absolutePath, 'utf8');
  const commit = parseApprovedCommit(text);
  if (!commit) return null;
  return { commit, signedBy: parseApprovedSigner(text) };
}
