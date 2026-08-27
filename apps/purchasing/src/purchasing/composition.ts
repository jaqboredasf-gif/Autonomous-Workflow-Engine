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

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import type { PurchasingContext } from './application/context.ts';
import {
  attachmentAdapter, auditAdapter, documentAdapter, emailDraftAdapter,
  identityAdapter, notificationAdapter, pdfRenderer, systemClock,
} from './infrastructure/adapters.ts';
import {
  sqliteApprovalRepository, sqliteEmailDraftRepository, sqliteInventoryRepository,
  sqliteOrderRepository, sqlitePoNumberAllocator, sqlitePurchaseHistoryRepository,
  sqliteReceiptRepository, sqliteItemCatalogRepository, sqliteReferenceRepository,
  sqliteRequestRepository, sqliteReviewRepository,
} from './infrastructure/sqlite/repositories.ts';
import { getDb } from './infrastructure/sqlite/database.ts';
import { builtinIntegrationProviders } from './infrastructure/providers/builtin.ts';
import { authAdapter } from './infrastructure/auth/index.ts';
import { loadConfig } from './infrastructure/env.ts';
import { poNumberStrategyFor } from './organization/po-numbering.mjs';

/**
 * Which repositories are bound. The Supabase context is request-scoped — it
 * needs the caller's access token and organization — so it is constructed by
 * the request layer (Checkpoint 1E) rather than here, and this function names
 * the decision so there is one place to look.
 */
export function selectedProvider(config = loadConfig()): 'local' | 'supabase' {
  return config.persistenceProvider;
}

/**
 * Build the purchasing context over a SQLite handle.
 *
 * `now` is injectable so the harness can drive a deterministic clock; the app
 * passes nothing and gets the wall clock.
 */
export function purchasingContext(db: DatabaseSync = getDb(), now?: string): PurchasingContext {
  const clock = systemClock(now);
  // ONE IDENTIFIER PER CONTEXT, and a context is built once per HTTP request —
  // so every audit row a single act produces carries the same one. This is what
  // lets the measurement layer count what a PERSON did instead of what the
  // database wrote, without inferring it from how fast the timestamps arrive.
  const interactionId = randomUUID();
  const reference = sqliteReferenceRepository(db);
  const catalog = sqliteItemCatalogRepository(db);
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
    reference,
    catalog,
    // The immutable record. Written at the terminal transition; everything the
    // catalogue says about "last ordered from" and "last price" is read from
    // here rather than from a live join.
    history: sqlitePurchaseHistoryRepository(db),
    // THE NUMBERING SEAM, BOUND HERE AND NOWHERE ELSE. Purchasing above this
    // line asks for a number; which rule produces it is this file's decision,
    // taken from the organization's profile id. An id nobody has implemented
    // throws on the way up — the alternative is issuing purchase orders with
    // invented numbers on them, which is not a smaller failure.
    poNumbers: sqlitePoNumberAllocator(db, poNumberStrategyFor(loadConfig().poNumbering)),
    identity: identityAdapter(db),
    // Credentials: Supabase Auth in production, the local scrypt store for the
    // pilot. Chosen once, here, by configuration.
    auth: authAdapter(db, loadConfig()),
    audit: auditAdapter(db, clock, interactionId),
    notifications: notificationAdapter(db, clock),
    documents: documentAdapter(db),
    renderer: pdfRenderer(),
    attachments: attachmentAdapter(db),
    email: emailDraftAdapter(),
    // The external seams. Bound to this organization's own data today; the
    // whole point of the indirection is that swapping one for QuickBooks or
    // Microsoft 365 happens on this line and nowhere above it.
    integrations: builtinIntegrationProviders({ reference, catalog }),
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
