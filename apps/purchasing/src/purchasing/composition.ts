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
import { getDb } from './infrastructure/sqlite/database.ts';
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
    // One transaction boundary. It nests (a use case calling another does not
    // open a second transaction) and it SERIALIZES.
    uow: { run: <T>(fn: () => Promise<T> | T): Promise<T> => runTransaction(db, fn) },
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
// normal. Depth keeps the outermost `begin immediate` as the boundary.
let inTransactionDepth = 0;

// Every write transaction joins this chain, so only one is ever open on the
// connection. With async repositories a second request can otherwise run
// between one transaction's `await` and its `commit`, interleaving statements
// inside it — that is not slowness, it is corruption. Waiting is the honest
// cost of a single-writer store.
let writeQueue: Promise<unknown> = Promise.resolve();

function runTransaction<T>(db: DatabaseSync, fn: () => Promise<T> | T): Promise<T> {
  if (inTransactionDepth > 0) return Promise.resolve(fn());

  const run = async (): Promise<T> => {
    inTransactionDepth++;
    db.exec('begin immediate');
    try {
      const out = await fn();
      db.exec('commit');
      return out;
    } catch (err) {
      try {
        db.exec('rollback');
      } catch {
        /* rolling back an already-rolled-back transaction must not mask the real failure */
      }
      throw err;
    } finally {
      inTransactionDepth--;
    }
  };

  // Chain on a SETTLED promise: a failed transaction must not poison the queue.
  const result = writeQueue.then(run, run);
  writeQueue = result.then(() => undefined, () => undefined);
  return result;
}
