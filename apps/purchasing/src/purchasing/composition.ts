/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// composition.ts — the composition root: the ONE place that knows which
// implementation backs each port and repository.
//
// Everything above this file is written against interfaces. Moving purchasing
// onto Supabase means writing a second `supabasePurchasingContext()` beside
// this and choosing between them here — no use case, no domain rule and no
// screen changes.
// ---------------------------------------------------------------------------

import type { DatabaseSync } from 'node:sqlite';

import type { PurchasingContext } from './application/context.ts';
import {
  attachmentAdapter, auditAdapter, documentAdapter, emailDraftAdapter,
  identityAdapter, notificationAdapter, pdfRenderer, systemClock,
} from './infrastructure/adapters.ts';
import {
  sqliteApprovalRepository, sqliteEmailDraftRepository, sqliteInventoryRepository,
  sqliteOrderRepository, sqlitePoNumberAllocator, sqliteReceiptRepository,
  sqliteReferenceRepository, sqliteRequestRepository, sqliteReviewRepository,
} from './infrastructure/sqlite/repositories.ts';
import { getDb, inTransaction } from './infrastructure/sqlite/database.ts';
import { authAdapter } from './infrastructure/auth/index.ts';
import { loadConfig } from './infrastructure/env.ts';

/**
 * Build the purchasing context over a SQLite handle.
 *
 * `now` is injectable so the harness can drive a deterministic clock; the app
 * passes nothing and gets the wall clock.
 */
export function purchasingContext(db: DatabaseSync = getDb(), now?: string): PurchasingContext {
  const clock = systemClock(now);
  return {
    clock,
    // One transaction boundary, and it nests safely: a use case that calls
    // another (approve -> nothing, PO -> document) does not open a second one.
    uow: { run: <T>(fn: () => T): T => (inTransactionDepth > 0 ? fn() : runTransaction(db, fn)) },
    requests: sqliteRequestRepository(db),
    reviews: sqliteReviewRepository(db),
    approvals: sqliteApprovalRepository(db),
    orders: sqliteOrderRepository(db),
    drafts: sqliteEmailDraftRepository(db),
    receipts: sqliteReceiptRepository(db),
    inventory: sqliteInventoryRepository(db),
    reference: sqliteReferenceRepository(db),
    poNumbers: sqlitePoNumberAllocator(db),
    identity: identityAdapter(db),
    // Credentials: Supabase Auth in production, the local scrypt store for the
    // pilot. Chosen once, here, by configuration.
    auth: authAdapter(db, loadConfig()),
    audit: auditAdapter(db, clock),
    notifications: notificationAdapter(db, clock),
    documents: documentAdapter(db),
    renderer: pdfRenderer(),
    attachments: attachmentAdapter(db),
    email: emailDraftAdapter(),
  };
}

// SQLite has no nested transactions, and a use case calling another use case is
// normal. Tracking depth keeps the outermost `begin immediate` as the boundary.
let inTransactionDepth = 0;

function runTransaction<T>(db: DatabaseSync, fn: () => T): T {
  inTransactionDepth++;
  try {
    return inTransaction(db, fn);
  } finally {
    inTransactionDepth--;
  }
}
