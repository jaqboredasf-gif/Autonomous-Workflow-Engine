/* eslint-disable @typescript-eslint/no-explicit-any */
import Link from 'next/link';

import { requireAccess, purchasingRequestContext } from '../../server/session.ts';
import { Empty, Section } from '../../components/ui';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Notifications — Lippolis Purchasing' };

export default async function NotificationsPage() {
  const actor = await requireAccess('/notifications');
  const ctx = purchasingRequestContext();
  const items = await ctx.notifications.inboxFor(actor.id);

  return (
    <Section title="Notifications" subtitle="What has happened on work you are part of.">
      {items.length === 0 ? (
        <Empty>Nothing yet.</Empty>
      ) : (
        <ul className="space-y-2 text-sm">
          {items.map((n: any) => (
            <li key={n.id} className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-xs tabular-nums text-slate-500">
                {String(n.created_at).slice(0, 16).replace('T', ' ')}
              </span>
              {n.request_id ? (
                <Link href={`/requests/${n.request_id}`} className="text-slate-800 underline underline-offset-2">
                  {describe(n.event)}
                </Link>
              ) : (
                <span className="text-slate-800">{describe(n.event)}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function describe(event: string) {
  return event.replace(/^purchase_/, '').replace(/[._]/g, ' ');
}
