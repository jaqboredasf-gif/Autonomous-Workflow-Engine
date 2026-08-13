// ---------------------------------------------------------------------------
// profiles/lippolis-authorization.mjs — organization #1's role vocabulary.
//
// This is a DESCRIPTION of the authorization PCC already enforces, written in
// the profile's terms. It changes nothing: a test asserts that resolving this
// profile produces, for every role, exactly the capability set the built-in
// tables produce today. If the two ever disagree, that test fails and the
// disagreement is the bug.
//
// Why write it out at all, when the built-in default already works? Because it
// is the proof that the boundary is real. A profile that cannot reproduce the
// original behaviour is not a boundary, it is a rewrite.
// ---------------------------------------------------------------------------

import { defineAuthorizationProfile } from '../authorization.mjs';
import {
  ROLE_PERMISSIONS,
  APPROVAL_GRANT_PERMISSIONS,
} from '../../../apps/purchasing/src/purchasing/domain/roles.mjs';

/**
 * Built from the domain's own tables rather than retyped.
 *
 * Retyping six capability lists by hand would produce a profile that agrees
 * with the code today and drifts the first time a permission is added — and the
 * drift would be invisible, because both are "correct". Deriving it means the
 * equivalence test is checking the BOUNDARY rather than my typing.
 *
 * The names are the organization's: REQUESTOR, FOREMAN, OFFICE, ACCOUNTING,
 * WORKSHOP_APPROVER, ADMIN. Another organization will have different ones, and
 * that is the whole point.
 */
export const lippolisAuthorization = defineAuthorizationProfile({
  orgId: 'lippolis',
  roles: { ...ROLE_PERMISSIONS },
  approvalGrant: [...APPROVAL_GRANT_PERMISSIONS],
});

export default lippolisAuthorization;
