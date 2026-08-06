/* eslint-disable @typescript-eslint/no-explicit-any */
// Vendor email draft review. Nothing on this page sends anything: the buttons
// move a row through GENERATED -> REVIEWED -> APPROVED_TO_SEND -> SENT, and
// "sent" means a human copied the text into their own mail client.
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { requireAccess, purchasingRequestContext } from '../../../../server/session.ts';
import * as S from '../../../../server/service.ts';
import { Empty, Section, buttonClass, inputClass, secondaryButtonClass } from '../../../../components/ui';
import { advanceEmailDraftAction, generateEmailDraftAction, updateEmailDraftAction } from '../../../actions.ts';

export const dynamic = 'force-dynamic';

export default async function EmailDraftPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await requireAccess('/requests');

  let detail: any;
  try {
    detail = await S.getRequestDetail(purchasingRequestContext(), actor, id);
  } catch {
    notFound();
  }

  const drafts = detail.emailDrafts;
  if (!drafts.length) {
    // A page that only says "nothing here" is a dead end. If a purchase order
    // exists, the thing you came to do is one button away.
    return (
      <Section title="Vendor email">
        {detail.purchaseOrder ? (
          <div className="space-y-3">
            <p className="text-sm text-slate-700">
              No draft has been created for purchase order {detail.purchaseOrder.poNumber} yet.
            </p>
            <form action={generateEmailDraftAction}>
              <input type="hidden" name="requestId" value={id} />
              <button className={buttonClass}>Create vendor email draft</button>
            </form>
          </div>
        ) : (
          <Empty>Generate the purchase order first, then draft the vendor email.</Empty>
        )}
      </Section>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-slate-900">Vendor email drafts</h1>
        <Link href={`/requests/${id}`} className={secondaryButtonClass}>
          Back to request
        </Link>
      </div>

      <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
        This system does not send email. Review the draft, then send it from your own mail client and mark it sent so
        the record matches what actually happened.
      </div>

      {drafts.map((d: any) => (
        <Section
          key={d.id}
          title={`${d.templateKey.replace(/_/g, ' ').toLowerCase()} · ${d.status}`}
          subtitle={`To ${d.to.join(', ') || '(no recipient on file)'}`}
        >
          {d.status === 'GENERATED' ? (
            <form action={updateEmailDraftAction} className="space-y-2">
              <input type="hidden" name="requestId" value={id} />
              <input type="hidden" name="draftId" value={d.id} />
              <input name="subject" className={inputClass} defaultValue={d.subject} />
              <textarea name="body" rows={16} className={`${inputClass} font-mono text-sm`} defaultValue={d.body} />
              <button className={secondaryButtonClass}>Save edits</button>
            </form>
          ) : (
            <div className="space-y-2">
              <div className="text-sm font-medium text-slate-900">{d.subject}</div>
              <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-slate-200 bg-slate-50 p-3 font-mono text-xs text-slate-800">
                {d.body}
              </pre>
              <p className="text-xs text-slate-500">Frozen: this draft has been reviewed, so the words cannot change.</p>
            </div>
          )}

          {d.attachments.length ? (
            <p className="mt-2 text-xs text-slate-600">
              Attachment: {d.attachments.map((a: any) => a.filename).join(', ')}
            </p>
          ) : null}

          <div className="mt-3 flex flex-wrap gap-2">
            {d.status === 'GENERATED' ? (
              <form action={advanceEmailDraftAction}>
                <input type="hidden" name="requestId" value={id} />
                <input type="hidden" name="draftId" value={d.id} />
                <input type="hidden" name="to" value="REVIEWED" />
                <button className={buttonClass}>Mark reviewed</button>
              </form>
            ) : null}
            {d.status === 'REVIEWED' ? (
              <form action={advanceEmailDraftAction}>
                <input type="hidden" name="requestId" value={id} />
                <input type="hidden" name="draftId" value={d.id} />
                <input type="hidden" name="to" value="APPROVED_TO_SEND" />
                <button className={buttonClass}>Approve to send</button>
              </form>
            ) : null}
            {d.status === 'APPROVED_TO_SEND' ? (
              <>
                <a
                  className={secondaryButtonClass}
                  href={`mailto:${encodeURIComponent(d.to.join(','))}?subject=${encodeURIComponent(d.subject)}&body=${encodeURIComponent(d.body)}`}
                >
                  Open in my mail client
                </a>
                <form action={advanceEmailDraftAction}>
                  <input type="hidden" name="requestId" value={id} />
                  <input type="hidden" name="draftId" value={d.id} />
                  <input type="hidden" name="to" value="SENT" />
                  <button className={buttonClass}>I sent it — mark sent</button>
                </form>
              </>
            ) : null}
            {['GENERATED', 'REVIEWED', 'APPROVED_TO_SEND'].includes(d.status) ? (
              <form action={advanceEmailDraftAction}>
                <input type="hidden" name="requestId" value={id} />
                <input type="hidden" name="draftId" value={d.id} />
                <input type="hidden" name="to" value="CANCELLED" />
                <button className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700">
                  Cancel draft
                </button>
              </form>
            ) : null}
          </div>
        </Section>
      ))}
    </div>
  );
}
