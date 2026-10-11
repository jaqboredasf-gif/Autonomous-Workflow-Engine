// ---------------------------------------------------------------------------
// release.mjs — is the code that was verified the code that ships?
//
// What is installed is the SIGNED commit (deployment/APPROVED_RELEASE.md), not
// whatever was tested. This compares the application the release package
// installs, and the data tools the runbook runs, between the two. Tooling
// outside those paths may differ by design; APPROVED_RELEASE.md records that.
// Shared by awe-readiness and the inspector so they cannot disagree.
// ---------------------------------------------------------------------------

import { join } from 'node:path';
import { readApprovalRecord } from '../../deployment/approval-record.mjs';
import { git } from './git.mjs';

export const APPLICATION_PATHS = ['apps/purchasing', 'packages', 'capability', 'config',
  'scripts/pcc-backup.mjs', 'scripts/pcc-restore.mjs'];
export const TOOLING_PATHS = ['scripts/pcc-verify-deployment.mjs', 'scripts/pcc-verify-production.mjs',
  'deployment/approval-record.mjs', 'scripts/package-release.mjs', 'scripts/Deploy-PCCProduction.ps1',
  'scripts/install-backup-task.ps1', 'scripts/Configure-PCCIIS.ps1', 'scripts/preflight-windows.ps1'];

export function signedRelease(root, evidenceCommit) {
  const approved = readApprovalRecord(join(root, 'deployment/APPROVED_RELEASE.md'));
  if (!approved) return null;
  const changed = (paths) => (evidenceCommit
    ? (git(root, ['diff', '--name-only', approved.commit, evidenceCommit, '--', ...paths]) ?? '').split('\n').filter(Boolean)
    : null);
  const app = changed(APPLICATION_PATHS);
  return {
    approved_commit: approved.commit,
    signed_by: approved.signedBy,
    evidence_commit: evidenceCommit,
    application_identical: app === null ? null : app.length === 0,
    application_differs: app ?? [],
    tooling_differs: changed(TOOLING_PATHS) ?? [],
    compared_paths: APPLICATION_PATHS,
  };
}
