/* eslint-disable @typescript-eslint/no-explicit-any */
// Admin. Milestone 1 ships the two settings that change how the system BEHAVES
// (approval authority and PO numbering) as editable, and everything else as
// read-only inventories of what is configured, plus the audit log. Vendor,
// template and location editing is the next slice — the tables and the
// permissions for it already exist, so it is screens, not architecture.
import { redirect } from 'next/navigation';

import { currentActor } from '../../server/session.ts';
import { getDb } from '../../server/db.ts';
import * as S from '../../server/service.ts';
import { Empty, ReadOnly, Section, buttonClass, inputClass, secondaryButtonClass } from '../../components/ui';
import { describeActivity } from '../../domain/activity.mjs';
import { isAdmin } from '../../domain/roles.mjs';
import { setApprovalAuthorityAction, updatePoConfigAction } from '../actions.ts';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  const actor = await currentActor();
  if (!actor) redirect('/signin');
  if (!isAdmin(actor)) {
    return (
      <Section title="Administration">
        <Empty>Administration is restricted to administrators.</Empty>
      </Section>
    );
  }

  const ctx = S.context(getDb());
  const db = getDb();
  const users = S.listUsers(ctx, actor);
  const vendors = S.listVendors(ctx, actor);
  const locations = S.listDeliveryLocations(ctx, actor);
  const templates = db.prepare('select * from email_templates where org_id = ? order by template_key').all(actor.orgId) as any[];
  const settings = S.loadSettings(db, actor.orgId);
  const po = S.poConfig(ctx, actor);
  const log = S.auditLog(ctx, actor, 100);

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold text-slate-900">Administration</h1>

      <Section title="Users, roles and approval authority">
        <table className="min-w-full text-left text-sm">
          <thead className="border-b border-slate-200 text-xs uppercase text-slate-500">
            <tr>
              <th className="py-2 pr-3">Name</th>
              <th className="py-2 pr-3">Roles</th>
              <th className="py-2 pr-3">Approval</th>
              <th className="py-2 pr-3">Change</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {users.map((u: any) => (
              <tr key={u.id}>
                <td className="py-2 pr-3">
                  {u.full_name}
                  <span className="block text-xs text-slate-500">{u.email}</span>
                </td>
                <td className="py-2 pr-3">{u.roles.join(', ')}</td>
                <td className="py-2 pr-3">
                  {u.can_approve ? 'yes' : 'no'}
                  {u.is_primary_approver ? ' · primary' : ''}
                  {u.is_backup_approver ? ' · backup' : ''}
                </td>
                <td className="py-2 pr-3">
                  <form action={setApprovalAuthorityAction}>
                    <input type="hidden" name="userId" value={u.id} />
                    <input type="hidden" name="canApprove" value={u.can_approve ? 'false' : 'true'} />
                    <button className="text-xs text-slate-700 underline">
                      {u.can_approve ? 'Revoke approval authority' : 'Grant approval authority'}
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="PO numbering" subtitle="The sequence is database-controlled and can only move forward.">
        <form action={updatePoConfigAction} className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <label className="text-xs text-slate-700">
            Prefix
            <input name="prefix" className={inputClass} defaultValue={po.prefix} />
          </label>
          <label className="text-xs text-slate-700">
            Digits
            <input name="padding" className={inputClass} defaultValue={po.padding} inputMode="numeric" />
          </label>
          <label className="text-xs text-slate-700">
            Suffix
            <input name="suffix" className={inputClass} defaultValue={po.suffix} />
          </label>
          <label className="text-xs text-slate-700">
            Next number
            <input name="nextValue" className={inputClass} defaultValue={po.next_value} inputMode="numeric" />
          </label>
          <div className="flex items-end">
            <button className={buttonClass}>Save</button>
          </div>
        </form>
      </Section>

      <Section title="Purchasing settings">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <ReadOnly label="Self-approval" value={settings.allowSelfApproval ? 'allowed' : 'refused'} />
          <ReadOnly label="External email sending" value="disabled (draft-only)" />
          <ReadOnly label="Email review before send" value="required" />
          <ReadOnly label="PO template" value={settings.poTemplateKey} />
        </div>
      </Section>

      <Section title="Vendors" subtitle={`${vendors.length} active`}>
        <ul className="space-y-1 text-sm">
          {vendors.map((v: any) => (
            <li key={v.id}>
              <span className="font-medium">{v.name}</span>{' '}
              <span className="text-slate-600">
                {v.contact_name ? `· ${v.contact_name} <${v.contact_email}>` : '· no primary contact on file'}
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Delivery locations" subtitle={`${locations.length} active`}>
        <ul className="space-y-1 text-sm">
          {locations.map((l: any) => (
            <li key={l.id}>
              <span className="font-medium">{l.name}</span> <span className="text-slate-600">· {l.kind}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Email templates" subtitle="Placeholders in {{double braces}} are filled at draft time.">
        <ul className="space-y-2 text-sm">
          {templates.map((t: any) => (
            <li key={t.id}>
              <div className="font-medium">{t.template_key}</div>
              <div className="text-xs text-slate-600">{t.subject}</div>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Audit log" subtitle="The last 100 recorded actions across the organization.">
        <ul className="space-y-1 text-sm">
          {log.map((entry: any) => (
            <li key={entry.id} className="flex flex-wrap gap-x-2">
              <span className="text-xs tabular-nums text-slate-500">{String(entry.at).slice(0, 16).replace('T', ' ')}</span>
              <span>
                {describeActivity({
                  ...entry,
                  actorName: entry.actor_name,
                  details: entry.new_values ? JSON.parse(entry.new_values) : {},
                })}
              </span>
            </li>
          ))}
        </ul>
        <a href="/queue" className={`${secondaryButtonClass} mt-3`}>
          Back to the queue
        </a>
      </Section>
    </div>
  );
}
