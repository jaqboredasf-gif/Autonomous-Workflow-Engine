/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// providers/builtin.ts — the integration seams, bound to the data purchasing
// already holds.
//
// These are REAL implementations, not stubs: the job directory is this
// organization's job table, the catalogue is its own purchasing history, the
// vendor directory is its vendor list. Everything works today with nothing
// connected.
//
// What they buy is the shape. When QuickBooks becomes the source of truth for
// jobs, a `quickbooks.ts` beside this file implements the same
// JobDirectoryProvider and composition points at it — and the request form,
// the server action that validates the submitted job, and every screen in
// between are untouched, because none of them ever knew where a job came from.
//
// The one thing these adapters must not do is normalize or rank differently
// from the domain. Ordering lives in catalog.mjs precisely so a future adapter
// cannot quietly give a second deployment a different autocomplete.
// ---------------------------------------------------------------------------

import type {
  EmailDraftProvider, IntegrationProviders, JobDirectoryProvider, JobRecord,
  MaterialCatalogProvider, MaterialRecord, VendorDirectoryProvider, VendorRecord,
} from '../../application/integrations.ts';
import type { ItemCatalogRepository, ReferenceRepository } from '../../domain/repositories.ts';
import { rankMaterialMatches } from '../../domain/catalog.mjs';

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

function toJob(row: any): JobRecord {
  return {
    // The local directory's row id IS the canonical identifier here. When
    // QuickBooks takes over, this becomes the QuickBooks customer/job id and
    // the job number stays the thing humans type — which is exactly why the
    // two are separate fields rather than one.
    sourceId: String(row.id ?? row.job_number),
    jobNumber: String(row.job_number ?? row.jobNumber ?? ''),
    name: String(row.name ?? ''),
    customerName: row.customer ?? row.customer_name ?? null,
    address: row.address ?? row.site_address ?? null,
    active: row.is_active === undefined ? true : Boolean(row.is_active),
    source: 'local',
  };
}

/**
 * Rank a type-ahead over jobs. A job number is an identifier people type in
 * full or in part, so an exact number beats a prefix, and a prefix beats a name
 * that merely contains the text. Same shape as the material ranking, and for
 * the same reason: whoever writes the QuickBooks adapter should not have to
 * reinvent an ordering.
 */
export function rankJobMatches(jobs: JobRecord[], query: string, limit = 8): JobRecord[] {
  const raw = String(query ?? '').trim().toLowerCase();
  if (!raw) return jobs.slice(0, limit);
  const tier = (j: JobRecord) => {
    const number = j.jobNumber.toLowerCase();
    const name = String(j.name ?? '').toLowerCase();
    const customer = String(j.customerName ?? '').toLowerCase();
    if (number === raw) return 0;
    if (number.startsWith(raw)) return 1;
    if (name.startsWith(raw)) return 2;
    if (number.includes(raw) || name.includes(raw) || customer.includes(raw)) return 3;
    return 99;
  };
  return jobs
    .map((job) => ({ job, tier: tier(job) }))
    .filter((m) => m.tier < 99)
    .sort((a, b) => a.tier - b.tier || a.job.jobNumber.localeCompare(b.job.jobNumber))
    .slice(0, limit)
    .map((m) => m.job);
}

export function localJobDirectory(reference: ReferenceRepository): JobDirectoryProvider {
  return {
    source: 'local',
    available: true,
    unavailableReason: null,

    async list(orgId) {
      return (await reference.jobs(orgId)).map(toJob);
    },

    async search(orgId, query, limit = 8) {
      return rankJobMatches(await this.list(orgId), query, limit);
    },

    async byNumber(orgId, jobNumber) {
      // Exact, and case-insensitive: people type "24-118" and "24-118 " and the
      // job is the same job. This is the call a server action makes to re-check
      // what the browser submitted, so it must not fall back to a fuzzy match.
      const wanted = String(jobNumber ?? '').trim().toLowerCase();
      if (!wanted) return null;
      const jobs = await this.list(orgId);
      return jobs.find((j) => j.jobNumber.toLowerCase() === wanted) ?? null;
    },
  };
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

function toMaterial(entry: any): MaterialRecord {
  return {
    sourceId: String(entry.catalogItemId ?? entry.normalizedDescription),
    materialId: entry.catalogItemId ?? null,
    canonicalDescription: String(entry.canonicalDescription ?? ''),
    aliases: entry.aliases ?? [],
    category: entry.category ?? null,
    subcategory: entry.subcategory ?? null,
    size: entry.size ?? null,
    unit: entry.defaultUnit ?? null,
    manufacturer: entry.manufacturer ?? null,
    manufacturerPartNumber: entry.catalogNumber ?? null,
    vendorPartNumbers: null,
    // The local catalogue records the vendor an item was last actually bought
    // from. That is evidence, not a preference — see the handoff's open
    // decision on preferred vendors — so it is surfaced under its own name and
    // not promoted to "preferred".
    preferredVendorId: null,
    active: entry.isActive !== false,
    timesRequested: Number(entry.timesRequested ?? 0),
    lastRequestedAt: entry.lastRequestedAt ?? null,
    lastUnitCostCents: entry.lastUnitCostCents ?? null,
    source: 'local',
  };
}

export function localMaterialCatalog(catalog: ItemCatalogRepository): MaterialCatalogProvider {
  return {
    source: 'local',
    available: true,
    unavailableReason: null,

    async search(orgId, query, limit = 8) {
      // The repository FILTERS; the domain RANKS. Asking the repository for a
      // wider set and ordering it here is what keeps every provider's
      // autocomplete identical.
      const entries = await catalog.list(orgId, { search: query, limit: Math.max(limit * 4, 40), activeOnly: true });
      return rankMaterialMatches(entries, query, limit).map(toMaterial);
    },

    async byId(orgId, materialId) {
      const entries = await catalog.list(orgId, { limit: 5000 });
      const found = entries.find((e: any) => String(e.catalogItemId ?? '') === String(materialId));
      return found ? toMaterial(found) : null;
    },
  };
}

// ---------------------------------------------------------------------------
// Vendors
// ---------------------------------------------------------------------------

function toVendor(row: any): VendorRecord {
  return {
    sourceId: String(row.id),
    vendorId: String(row.id),
    name: String(row.name ?? ''),
    accountNumber: row.account_number ?? null,
    email: row.contact_email ?? null,
    phone: row.phone ?? row.contact_phone ?? null,
    active: row.is_active === undefined ? true : Boolean(row.is_active),
    source: 'local',
  };
}

export function localVendorDirectory(reference: ReferenceRepository): VendorDirectoryProvider {
  return {
    source: 'local',
    available: true,
    unavailableReason: null,

    async list(orgId) {
      return (await reference.vendors(orgId)).map(toVendor);
    },

    async search(orgId, query, limit = 8) {
      const raw = String(query ?? '').trim().toLowerCase();
      const all = await this.list(orgId);
      if (!raw) return all.slice(0, limit);
      return all
        .filter((v) => v.name.toLowerCase().includes(raw) || String(v.accountNumber ?? '').toLowerCase().includes(raw))
        .sort((a, b) => {
          const aStarts = a.name.toLowerCase().startsWith(raw) ? 0 : 1;
          const bStarts = b.name.toLowerCase().startsWith(raw) ? 0 : 1;
          return aStarts - bStarts || a.name.localeCompare(b.name);
        })
        .slice(0, limit);
    },

    async byId(orgId, vendorId) {
      return (await this.list(orgId)).find((v) => v.vendorId === String(vendorId)) ?? null;
    },
  };
}

// ---------------------------------------------------------------------------
// Email drafts
// ---------------------------------------------------------------------------

/**
 * A mailto: URL for the composed draft.
 *
 * Exported and pure so the length limit below is testable. Mail clients and
 * browsers truncate long mailto: URLs silently — the window opens, the body is
 * cut off, and the sender does not notice — which is why prepare() checks the
 * length and falls back rather than handing over a mangled draft.
 */
export function mailtoUrl(payload: { to: string[]; cc?: string[]; subject: string; body: string }) {
  const query = new URLSearchParams();
  if (payload.cc?.length) query.set('cc', payload.cc.join(','));
  query.set('subject', payload.subject);
  query.set('body', payload.body);
  return `mailto:${payload.to.map(encodeURIComponent).join(',')}?${query.toString()}`;
}

/** Conservative: clients differ, and the failure is silent truncation. */
export const MAILTO_SAFE_LENGTH = 1800;

/**
 * The v1 email handoff: show the draft, and offer a mailto: when it is short
 * enough to survive one.
 *
 * NOT IMPLEMENTED HERE, ON PURPOSE: `graph` (a real draft in the user's
 * Microsoft 365 mailbox) and `eml` (a downloadable message carrying the PO).
 * Both are described in PCC_INTEGRATION_ARCHITECTURE.md and both attach at this
 * interface. Declaring them in `handoffs` before they work would put a button
 * on a screen that cannot do what it says.
 */
export function localEmailDraftProvider(): EmailDraftProvider {
  return {
    source: 'local',
    available: true,
    unavailableReason: null,
    handoffs: ['display', 'mailto'] as const,

    async prepare({ payload, prefer }) {
      const recipients = (payload.to ?? []).filter(Boolean);
      if (recipients.length === 0) {
        // A draft addressed to nobody is not a draft. Refusing here means the
        // vendor-email screen reports a missing contact instead of producing
        // something that looks ready to send.
        throw Object.assign(new Error('a vendor email needs at least one recipient'), { reason: 'no_recipient' });
      }

      const url = mailtoUrl({ ...payload, to: recipients });
      const canMailto = url.length <= MAILTO_SAFE_LENGTH;

      // An attachment cannot ride on a mailto:, so a draft carrying the PO is
      // shown for review rather than pushed into a client that would drop it.
      const hasAttachment = Boolean(payload.attachments?.length);
      const handoff = prefer === 'display' || !canMailto || hasAttachment ? 'display' : 'mailto';

      return {
        handoff,
        url: handoff === 'mailto' ? url : null,
        externalDraftId: null,
        sent: false,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * Bind every seam to the local implementation.
 *
 * `timeTracking` is null: Exact Time is not connected, and a provider that
 * answered "0 hours" would be indistinguishable from a job nobody worked. A
 * screen that wants labour must check for null and say the system is not
 * connected.
 */
export function builtinIntegrationProviders(deps: {
  reference: ReferenceRepository;
  catalog: ItemCatalogRepository;
}): IntegrationProviders {
  return {
    jobs: localJobDirectory(deps.reference),
    materials: localMaterialCatalog(deps.catalog),
    vendors: localVendorDirectory(deps.reference),
    email: localEmailDraftProvider(),
    timeTracking: null,
  };
}
