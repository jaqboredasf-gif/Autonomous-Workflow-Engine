'use client';

// ---------------------------------------------------------------------------
// /approvals — the approval queue (Task B5).
//
// The human end of the B3 pipeline: every customer-facing message the system
// drafts waits here for a named human to approve or reject it.
//
// WHAT THIS PAGE CANNOT DO, BY CONSTRUCTION:
//   * It cannot send. There is no mark_message_sent() call, no mail client, no
//     Graph, no n8n. Approving records a decision; a human sends by hand from
//     Outlook and that is recorded elsewhere.
//   * It cannot bypass the approval gate. The only write it performs is 0015's
//     record_approval() RPC, which re-checks the org, the status and the
//     approver role server-side. RLS gives this session admin-scoped SELECT
//     only — outbound_messages has no client insert/update policy at all.
//   * It cannot escalate its own privileges. The browser holds the anon key and
//     the signed-in user's JWT. No service-role key, no management token.
//
// The decidable logic lives in @/lib/approval-queue (pure, tested by Runner 5);
// this file is the shell: fetch, states, layout, and the two buttons.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import {
  QUEUE_SELECT,
  QUEUE_ORDER_COLUMN,
  QUEUE_LIMIT,
  QUEUE_TABS,
  NO_CAPABILITIES,
  buildAuditTrail,
  decisionGuard,
  escalationLine,
  filterTab,
  formatAmount,
  isTestRow,
  messageTypeLabel,
  planDecision,
  planSendMark,
  queueState,
  recipientLine,
  requesterLine,
  requiredRoles,
  resolveQueueMode,
  sendGuard,
  summarizeQueue,
  verifyDecisionApplied,
  verifySendApplied,
  type Capabilities,
  type Decision,
  type QueueRow,
  type QueueTab,
} from '@/lib/approval-queue';

const MODE = resolveQueueMode({ AWE_MODE: process.env.NEXT_PUBLIC_AWE_MODE });

const STATUS_STYLE: Record<string, string> = {
  draft: 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200',
  approved: 'bg-green-100 text-green-900 dark:bg-green-900/40 dark:text-green-200',
  rejected: 'bg-neutral-200 text-neutral-800 dark:bg-neutral-700 dark:text-neutral-100',
  sent: 'bg-blue-100 text-blue-900 dark:bg-blue-900/40 dark:text-blue-200',
  blocked: 'bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200',
  failed: 'bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200',
};

const TAB_LABEL: Record<QueueTab, string> = {
  pending: 'Pending approval',
  to_send: 'Approved — you still owe this',
  blocked: 'Blocked / failed',
  decided: 'Decided',
};

function fmt(ts: string | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default function Approvals() {
  const [rows, setRows] = useState<QueueRow[] | null>(null);
  const [caps, setCaps] = useState<Capabilities>(NO_CAPABILITIES);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(true);
  const [tab, setTab] = useState<QueueTab>('pending');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  // Recording a send is IRREVERSIBLE (0015: `sent` is terminal — there is no
  // transition out of it). A single stray click would permanently assert that a
  // customer was emailed when they were not, and drop a real obligation out of
  // the "you still owe this" tab forever. So the write takes two deliberate acts.
  const [confirmingSendId, setConfirmingSendId] = useState<string | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement | null>(null);

  /**
   * Single read path. Returns the fresh rows so a decision can verify itself
   * against the re-read instead of trusting the RPC's own word.
   */
  const load = useCallback(async (): Promise<QueueRow[] | null> => {
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) {
      setSignedIn(false);
      setRows(null);
      setCaps(NO_CAPABILITIES);
      setLoading(false);
      return null;
    }
    setSignedIn(true);

    const { data, error: qErr } = await supabase
      .from('outbound_messages')
      .select(QUEUE_SELECT)
      .order(QUEUE_ORDER_COLUMN, { ascending: true })
      .limit(QUEUE_LIMIT)
      .overrideTypes<QueueRow[]>();

    if (qErr) {
      setError(qErr.message);
      setRows(null);
      setLoading(false);
      return null;
    }

    const fresh = data ?? [];

    // Ask the database which approver roles this human actually holds — the same
    // function record_approval() will ask. One call per distinct role in view.
    const roleMap: Record<string, boolean> = {};
    for (const role of requiredRoles(fresh)) {
      const { data: ok, error: rErr } = await supabase.rpc('business_role_matches', {
        p_user: auth.user.id,
        p_role: role,
      });
      // Unresolvable capability => not held. Fail closed.
      roleMap[role] = !rErr && ok === true;
    }

    setCaps({ userId: auth.user.id, roles: roleMap });
    setRows(fresh);
    setError(null);
    setLoading(false);
    return fresh;
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(row: QueueRow, decision: Decision) {
    setNotice(null);
    setReasonError(null);

    const plan = planDecision({
      row,
      decision,
      reason,
      mode: MODE,
      capabilities: caps,
    });

    if (!plan.ok) {
      // Nothing leaves the browser: an invalid decision has no RPC payload.
      if (plan.reason === 'missing_rejection_reason') {
        setReasonError(plan.detail);
        reasonRef.current?.focus();
      } else {
        setNotice({ kind: 'error', text: `${plan.reason}: ${plan.detail}` });
      }
      return;
    }

    setBusyId(row.id);
    const { error: rpcErr } = await supabase.rpc('record_approval', plan.rpc!);

    if (rpcErr) {
      // The database is the authority; show exactly what it refused with.
      setNotice({ kind: 'error', text: rpcErr.message });
      setBusyId(null);
      await load();
      return;
    }

    // Deterministic refresh: re-read, then confirm the row actually moved.
    const fresh = await load();
    const verdict = verifyDecisionApplied({
      rows: fresh ?? [],
      messageId: row.id,
      decision,
    });
    setNotice({ kind: verdict.settled ? 'success' : 'error', text: verdict.message });
    if (verdict.settled) {
      setReason('');
      setSelectedId(null);
    }
    setBusyId(null);
  }

  /**
   * Record that a human sent an approved message. This does NOT send anything —
   * AWE has no transport. It writes the ledger entry that closes the loop:
   * approved -> a person actually did it -> audited. Until this is clicked the
   * message sits in "you still owe this", which is the honest state.
   */
  async function markSent(row: QueueRow) {
    setNotice(null);
    setConfirmingSendId(null);

    const plan = planSendMark({ row, mode: MODE, capabilities: caps });
    if (!plan.ok) {
      setNotice({ kind: 'error', text: `${plan.reason}: ${plan.detail}` });
      return;
    }

    setBusyId(row.id);
    const { error: rpcErr } = await supabase.rpc('mark_message_sent', plan.rpc!);

    if (rpcErr) {
      setNotice({ kind: 'error', text: rpcErr.message });
      setBusyId(null);
      await load();
      return;
    }

    const fresh = await load();
    const verdict = verifySendApplied({ rows: fresh ?? [], messageId: row.id });
    setNotice({ kind: verdict.settled ? 'success' : 'error', text: verdict.message });
    if (verdict.settled) setSelectedId(null);
    setBusyId(null);
  }

  const state = queueState({ loading, error, signedIn, rows });
  const all = rows ?? [];
  const summary = summarizeQueue(all);
  const visible = filterTab(all, tab);
  const selected = all.find((r) => r.id === selectedId) ?? null;
  const guard = selected ? decisionGuard({ row: selected, mode: MODE, capabilities: caps }) : null;
  const sendable = selected ? sendGuard({ row: selected, mode: MODE, capabilities: caps }) : null;

  return (
    <main className="mx-auto w-full max-w-6xl p-4 sm:p-8">
      <header>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold">Approval queue</h1>
          <span
            className={`rounded px-2 py-0.5 text-xs font-semibold ${
              MODE === 'TEST'
                ? 'bg-purple-100 text-purple-900 dark:bg-purple-900/40 dark:text-purple-200'
                : 'bg-neutral-800 text-white'
            }`}
          >
            {MODE} mode
          </span>
        </div>
        <p className="mt-2 max-w-3xl text-sm text-neutral-600 dark:text-neutral-400">
          Every drafted customer message waits here for a decision. Approving records who
          approved what and when — <strong>it does not send anything</strong>. Sending stays a
          manual step in Outlook.
          {MODE === 'TEST' && ' In TEST mode only fixture messages addressed to @example.invalid can be decided.'}
        </p>
      </header>

      {/* One live region for every success and failure message on the page. */}
      <div aria-live="polite" role="status">
        {notice && (
          <p
            className={`mt-4 rounded border px-3 py-2 text-sm ${
              notice.kind === 'success'
                ? 'border-green-300 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950 dark:text-green-200'
                : 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200'
            }`}
          >
            {notice.text}
          </p>
        )}
      </div>

      {state === 'loading' && (
        <p className="mt-8 text-neutral-600 dark:text-neutral-400">Loading approval queue…</p>
      )}

      {state === 'signed_out' && (
        <p className="mt-8 text-neutral-700 dark:text-neutral-300">
          You are not signed in.{' '}
          <a className="text-blue-600 underline" href="/">
            Sign in
          </a>{' '}
          to view the approval queue.
        </p>
      )}

      {state === 'error' && (
        <div className="mt-8 rounded border border-red-300 bg-red-50 p-4 dark:border-red-800 dark:bg-red-950">
          <h2 className="font-semibold text-red-900 dark:text-red-200">
            Could not load the approval queue
          </h2>
          <p className="mt-1 text-sm text-red-800 dark:text-red-300">{error}</p>
          <button
            onClick={() => {
              setLoading(true);
              setError(null);
              void load();
            }}
            className="mt-3 rounded bg-red-700 px-3 py-1.5 text-sm text-white hover:bg-red-800"
          >
            Retry
          </button>
        </div>
      )}

      {state === 'empty' && (
        <p className="mt-8 text-neutral-600 dark:text-neutral-400">
          Nothing in the queue. No messages are waiting for a decision.
        </p>
      )}

      {state === 'ready' && (
        <>
          <div className="mt-6 flex flex-wrap gap-2" role="group" aria-label="Filter queue">
            {QUEUE_TABS.map((t) => {
              const count =
                t === 'pending' ? summary.pending : t === 'blocked' ? summary.blocked : summary.decided;
              return (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  aria-pressed={tab === t}
                  className={`rounded px-3 py-1.5 text-sm ${
                    tab === t
                      ? 'bg-blue-600 text-white'
                      : 'bg-neutral-100 text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300'
                  }`}
                >
                  {TAB_LABEL[t]} ({count})
                </button>
              );
            })}
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
            <section aria-label="Queue">
              {visible.length === 0 ? (
                <p className="text-sm text-neutral-600 dark:text-neutral-400">
                  Nothing in “{TAB_LABEL[tab]}”.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[40rem] text-sm">
                    <caption className="sr-only">
                      {TAB_LABEL[tab]} — {visible.length} messages
                    </caption>
                    <thead>
                      <tr className="border-b text-left text-neutral-500">
                        <th scope="col" className="py-2 pr-4">Type</th>
                        <th scope="col" className="py-2 pr-4">Requester</th>
                        <th scope="col" className="py-2 pr-4">Recipient</th>
                        <th scope="col" className="py-2 pr-4">Amount</th>
                        <th scope="col" className="py-2 pr-4">Approver</th>
                        <th scope="col" className="py-2 pr-4">Created</th>
                        <th scope="col" className="py-2">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((r) => (
                        <tr
                          key={r.id}
                          className={`border-b ${
                            selectedId === r.id ? 'bg-blue-50 dark:bg-blue-950/40' : ''
                          }`}
                        >
                          <td className="py-2 pr-4">
                            <button
                              onClick={() => {
                                setSelectedId(r.id);
                                setReason('');
                                setReasonError(null);
                                setNotice(null);
                              }}
                              className="text-left text-blue-700 underline dark:text-blue-400"
                              aria-expanded={selectedId === r.id}
                            >
                              {messageTypeLabel(r.message_type)}
                            </button>
                            {isTestRow(r) && (
                              <span className="ml-2 rounded bg-purple-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-purple-900 dark:bg-purple-900/40 dark:text-purple-200">
                                test
                              </span>
                            )}
                          </td>
                          <td className="py-2 pr-4">{requesterLine(r)}</td>
                          <td className="py-2 pr-4">{recipientLine(r)}</td>
                          <td className="py-2 pr-4">{formatAmount(r.amount_cents)}</td>
                          <td className="py-2 pr-4">
                            {r.assigned_approver_role ?? '—'}
                            {r.escalated && (
                              <span className="ml-1 font-semibold text-amber-700 dark:text-amber-400">
                                ↑
                              </span>
                            )}
                          </td>
                          <td className="py-2 pr-4 whitespace-nowrap">{fmt(r.created_at)}</td>
                          <td className="py-2">
                            <span
                              className={`rounded px-2 py-0.5 text-xs font-semibold ${
                                STATUS_STYLE[r.status] ?? ''
                              }`}
                            >
                              {r.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section aria-labelledby="detail-heading" className="lg:sticky lg:top-4 lg:self-start">
              <h2 id="detail-heading" className="text-lg font-semibold">
                {selected ? 'Message detail' : 'Select a message'}
              </h2>

              {!selected ? (
                <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
                  Choose a message from the queue to read the full draft, its routing evidence and
                  its history.
                </p>
              ) : (
                <div className="mt-3 space-y-4 rounded border p-4 dark:border-neutral-700">
                  <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                    <dt className="text-neutral-500">Type</dt>
                    <dd>{messageTypeLabel(selected.message_type)}</dd>
                    <dt className="text-neutral-500">Status</dt>
                    <dd>{selected.status}</dd>
                    <dt className="text-neutral-500">Requester</dt>
                    <dd>{requesterLine(selected)}</dd>
                    <dt className="text-neutral-500">Recipient</dt>
                    <dd className="break-words">{recipientLine(selected)}</dd>
                    <dt className="text-neutral-500">Amount</dt>
                    <dd>{formatAmount(selected.amount_cents)}</dd>
                    <dt className="text-neutral-500">Approval owner</dt>
                    <dd>{selected.assigned_approver_role ?? '— none assigned —'}</dd>
                    <dt className="text-neutral-500">Escalation</dt>
                    <dd>{escalationLine(selected)}</dd>
                    <dt className="text-neutral-500">Created</dt>
                    <dd>{fmt(selected.created_at)}</dd>
                    <dt className="text-neutral-500">Updated</dt>
                    <dd>{fmt(selected.updated_at)}</dd>
                    <dt className="text-neutral-500">Data</dt>
                    <dd>{isTestRow(selected) ? 'TEST fixture' : 'production record'}</dd>
                  </dl>

                  {selected.blocked_reason && (
                    <p className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
                      <strong>Blocked:</strong> {selected.blocked_reason}. The approval matrix could
                      not name an accountable approver, so this message cannot be decided here —
                      fix the policy configuration first.
                    </p>
                  )}

                  <div>
                    <h3 className="text-sm font-semibold">Draft</h3>
                    <p className="mt-1 text-sm font-medium">{selected.subject ?? '(no subject)'}</p>
                    <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-neutral-50 p-3 text-xs dark:bg-neutral-900">
                      {selected.body_text ?? '(no body)'}
                    </pre>
                  </div>

                  {selected.work_requests && (
                    <div>
                      <h3 className="text-sm font-semibold">Work request</h3>
                      <dl className="mt-1 grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                        <dt className="text-neutral-500">Classification</dt>
                        <dd>{selected.work_requests.classification ?? '—'}</dd>
                        <dt className="text-neutral-500">Request status</dt>
                        <dd>{selected.work_requests.status ?? '—'}</dd>
                        <dt className="text-neutral-500">Location</dt>
                        <dd>
                          {[selected.work_requests.county, selected.work_requests.zip]
                            .filter(Boolean)
                            .join(' ') || '—'}
                        </dd>
                        <dt className="text-neutral-500">Original email</dt>
                        <dd className="break-words">
                          {selected.work_requests.email_messages?.from_addr ?? '—'}
                        </dd>
                      </dl>
                    </div>
                  )}

                  {selected.message_policies && (
                    <div>
                      <h3 className="text-sm font-semibold">Matrix row that routed this</h3>
                      <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
                        mode {selected.message_policies.mode} · primary{' '}
                        {selected.message_policies.approver_role ?? '—'} · backup{' '}
                        {selected.message_policies.backup_approver_role ?? '—'} · escalation{' '}
                        {selected.message_policies.escalation_role ?? '—'} · limit{' '}
                        {formatAmount(selected.message_policies.approval_limit_cents)}
                      </p>
                    </div>
                  )}

                  <div>
                    <h3 className="text-sm font-semibold">History</h3>
                    <ol className="mt-1 space-y-1 text-xs">
                      {buildAuditTrail(selected).map((e, i) => (
                        <li key={`${e.step}-${i}`} className="flex flex-wrap gap-x-2">
                          <span className="font-semibold">{e.step}</span>
                          <span className="text-neutral-500">{fmt(e.at)}</span>
                          <span>· {e.actor}</span>
                          {e.detail && <span className="text-neutral-600 dark:text-neutral-400">— {e.detail}</span>}
                        </li>
                      ))}
                    </ol>
                  </div>

                  <div className="border-t pt-3 dark:border-neutral-700">
                    <h3 className="text-sm font-semibold">Decision</h3>

                    {guard && !guard.allowed ? (
                      <p className="mt-1 rounded bg-neutral-100 px-3 py-2 text-sm text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
                        No decision available — <strong>{guard.reason}</strong>: {guard.detail}
                      </p>
                    ) : (
                      <>
                        <label
                          htmlFor="rejection-reason"
                          className="mt-2 block text-sm text-neutral-700 dark:text-neutral-300"
                        >
                          Reason (required to reject)
                        </label>
                        <textarea
                          id="rejection-reason"
                          ref={reasonRef}
                          rows={3}
                          value={reason}
                          onChange={(e) => {
                            setReason(e.target.value);
                            setReasonError(null);
                          }}
                          aria-invalid={reasonError ? true : undefined}
                          aria-describedby={reasonError ? 'rejection-reason-error' : undefined}
                          className="mt-1 w-full rounded border px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                          placeholder="Why is this message not acceptable?"
                        />
                        {reasonError && (
                          <p
                            id="rejection-reason-error"
                            className="mt-1 text-sm text-red-700 dark:text-red-400"
                          >
                            {reasonError}
                          </p>
                        )}

                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            onClick={() => void decide(selected, 'approve')}
                            disabled={busyId === selected.id}
                            className="rounded bg-green-700 px-4 py-2 text-sm text-white hover:bg-green-800 disabled:opacity-50"
                          >
                            {busyId === selected.id ? 'Working…' : 'Approve'}
                          </button>
                          <button
                            onClick={() => void decide(selected, 'reject')}
                            disabled={busyId === selected.id}
                            className="rounded bg-red-700 px-4 py-2 text-sm text-white hover:bg-red-800 disabled:opacity-50"
                          >
                            {busyId === selected.id ? 'Working…' : 'Reject'}
                          </button>
                        </div>
                        <p className="mt-2 text-xs text-neutral-500">
                          Approving does not send this message. A human sends it from Outlook, then
                          records it below.
                        </p>
                      </>
                    )}
                  </div>

                  {(selected.status === 'approved' || selected.status === 'sent') && (
                    <div className="border-t pt-3 dark:border-neutral-700">
                      <h3 className="text-sm font-semibold">Real-world send</h3>

                      {selected.status === 'sent' ? (
                        <p className="mt-1 rounded bg-blue-50 px-3 py-2 text-sm text-blue-900 dark:bg-blue-900/30 dark:text-blue-200">
                          Recorded as sent{selected.sender?.full_name ? ` by ${selected.sender.full_name}` : ''}
                          {selected.sent_at ? ` on ${fmt(selected.sent_at)}` : ''}.
                        </p>
                      ) : sendable && !sendable.allowed ? (
                        <p className="mt-1 rounded bg-neutral-100 px-3 py-2 text-sm text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
                          Cannot record a send — <strong>{sendable.reason}</strong>: {sendable.detail}
                        </p>
                      ) : (
                        <>
                          <p className="mt-1 text-sm text-neutral-700 dark:text-neutral-300">
                            This message is approved but nobody has sent it yet. Copy the body above
                            into Outlook and send it, then record that here.
                          </p>

                          {confirmingSendId === selected.id ? (
                            <div className="mt-3 rounded border border-amber-400 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-900/30">
                              <p className="text-sm font-semibold text-amber-900 dark:text-amber-100">
                                Have you already sent this email from Outlook?
                              </p>
                              <p className="mt-1 text-sm text-amber-900 dark:text-amber-100">
                                This cannot be undone. Recording a send that did not happen means the
                                customer never hears from us and nothing will ever flag it again.
                              </p>
                              <div className="mt-3 flex flex-wrap gap-2">
                                <button
                                  onClick={() => void markSent(selected)}
                                  disabled={busyId === selected.id}
                                  className="rounded bg-blue-700 px-4 py-2 text-sm text-white hover:bg-blue-800 disabled:opacity-50"
                                >
                                  {busyId === selected.id ? 'Working…' : 'Yes — I already sent it'}
                                </button>
                                <button
                                  onClick={() => setConfirmingSendId(null)}
                                  disabled={busyId === selected.id}
                                  className="rounded border px-4 py-2 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-600 dark:hover:bg-neutral-800"
                                >
                                  Not yet — cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="mt-3">
                              <button
                                onClick={() => setConfirmingSendId(selected.id)}
                                disabled={busyId === selected.id}
                                className="rounded bg-blue-700 px-4 py-2 text-sm text-white hover:bg-blue-800 disabled:opacity-50"
                              >
                                I sent this — record it
                              </button>
                            </div>
                          )}

                          <p className="mt-2 text-xs text-neutral-500">
                            This button does <strong>not</strong> send anything. AWE has no mail
                            transport. It records, permanently and under your name, that{' '}
                            <strong>you</strong> sent it. AWE cannot verify that — it only knows what
                            you tell it. Do not record it until the email has actually gone out.
                          </p>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
            </section>
          </div>
        </>
      )}
    </main>
  );
}
