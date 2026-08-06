'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */
// User administration: invite, disable, reset access, set roles, assign a
// foreman to a job site, designate a delivery receiver.
//
// Every one of these posts to a server action that re-checks the permission —
// this component decides what to SHOW, never what is allowed.
import { useActionState, useState } from 'react';

import {
  inviteUserAction, resetUserAccessAction, setDeliveryReceiverAction,
  setJobAssignmentAction, setUserDisabledAction, setUserRolesAction,
} from '../app/actions.ts';
import { ROLES } from '../purchasing/domain/roles.mjs';
import { Field, Section, buttonClass, inputClass, secondaryButtonClass } from './ui';

export default function AdminUsers({ users, jobs }: { users: any[]; jobs: string[] }) {
  const [inviteState, inviteAction, inviting] = useActionState(inviteUserAction, null as any);
  const [resetState, resetAction, resetting] = useActionState(resetUserAccessAction, null as any);
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="space-y-5">
      <Section title="Invite someone" subtitle="Creates the person, then asks the credential provider for a password.">
        <form action={inviteAction} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Full name" required>
            <input name="fullName" className={inputClass} required />
          </Field>
          <Field label="Email" required>
            <input name="email" type="email" className={inputClass} autoCapitalize="none" required />
          </Field>
          <Field label="Temporary password" required hint="At least 10 characters. They should change it.">
            <input name="temporaryPassword" className={inputClass} required minLength={10} />
          </Field>
          <Field label="Job sites" hint="Comma separated. Only needed for a foreman who signs for deliveries.">
            <input name="jobNumbers" className={inputClass} placeholder="24-118, 25-007" list="admin-job-numbers" />
            <datalist id="admin-job-numbers">
              {jobs.map((j) => (
                <option key={j} value={j} />
              ))}
            </datalist>
          </Field>
          <fieldset className="sm:col-span-2">
            <legend className="mb-1 text-xs font-medium text-slate-700">Roles</legend>
            <div className="flex flex-wrap gap-3">
              {ROLES.map((role: string) => (
                <label key={role} className="flex items-center gap-1 text-sm text-slate-800">
                  <input type="checkbox" name="roles" value={role} />
                  {role}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="flex items-center gap-2 text-sm text-slate-800">
            <input type="checkbox" name="canApprove" />
            Approval authority
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-800">
            <input type="checkbox" name="isDeliveryReceiver" />
            Designated delivery receiver
          </label>
          {inviteState && inviteState.ok === false ? (
            <p role="alert" className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-900 sm:col-span-2">
              {inviteState.error}
            </p>
          ) : null}
          {inviteState?.ok ? (
            <p className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 sm:col-span-2">
              Invited. Give them the temporary password in person — this system does not email it.
            </p>
          ) : null}
          <div className="sm:col-span-2">
            <button className={buttonClass} disabled={inviting}>
              {inviting ? 'Inviting…' : 'Invite user'}
            </button>
          </div>
        </form>
      </Section>

      <Section title="People" subtitle="Roles, approval authority, job assignments and account status.">
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-slate-200 text-xs uppercase text-slate-500">
              <tr>
                <th className="py-2 pr-3">Name</th>
                <th className="py-2 pr-3">Roles</th>
                <th className="py-2 pr-3">Approval</th>
                <th className="py-2 pr-3">Job sites</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2 pr-3">Manage</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {users.map((u: any) => (
                <tr key={u.id} className="align-top">
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
                    {u.jobs?.length ? u.jobs.join(', ') : '—'}
                    {u.is_delivery_receiver ? <span className="block text-xs text-slate-500">receiver</span> : null}
                  </td>
                  <td className="py-2 pr-3">
                    {u.is_active ? <span className="text-emerald-700">active</span> : <span className="text-rose-700">disabled</span>}
                  </td>
                  <td className="py-2 pr-3">
                    <button
                      type="button"
                      className="text-xs text-slate-700 underline"
                      onClick={() => setExpanded(expanded === u.id ? null : u.id)}
                    >
                      {expanded === u.id ? 'Close' : 'Manage'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {expanded ? <ManagePanel user={users.find((u: any) => u.id === expanded)} jobs={jobs} resetAction={resetAction} resetState={resetState} resetting={resetting} /> : null}
      </Section>
    </div>
  );
}

function ManagePanel({
  user, jobs, resetAction, resetState, resetting,
}: {
  user: any; jobs: string[]; resetAction: any; resetState: any; resetting: boolean;
}) {
  return (
    <div className="mt-4 space-y-4 rounded-lg border border-slate-300 bg-slate-50 p-4">
      <h3 className="text-sm font-semibold text-slate-900">{user.full_name}</h3>

      <form action={setUserRolesAction} className="space-y-2">
        <input type="hidden" name="userId" value={user.id} />
        <div className="flex flex-wrap gap-3">
          {ROLES.map((role: string) => (
            <label key={role} className="flex items-center gap-1 text-sm text-slate-800">
              <input type="checkbox" name="roles" value={role} defaultChecked={user.roles.includes(role)} />
              {role}
            </label>
          ))}
        </div>
        <button className={secondaryButtonClass}>Save roles</button>
      </form>

      <form action={setDeliveryReceiverAction} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="userId" value={user.id} />
        <input type="hidden" name="isReceiver" value={user.is_delivery_receiver ? 'false' : 'true'} />
        <button className={secondaryButtonClass}>
          {user.is_delivery_receiver ? 'Remove as delivery receiver' : 'Designate as delivery receiver'}
        </button>
      </form>

      <form action={setJobAssignmentAction} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="userId" value={user.id} />
        <Field label="Assign to job site">
          <input name="jobNumber" className={inputClass} list="admin-job-numbers" placeholder="24-118" />
        </Field>
        <input type="hidden" name="assigned" value="true" />
        <button className={secondaryButtonClass}>Assign</button>
      </form>

      {user.jobs?.length ? (
        <div className="flex flex-wrap gap-2">
          {user.jobs.map((job: string) => (
            <form key={job} action={setJobAssignmentAction}>
              <input type="hidden" name="userId" value={user.id} />
              <input type="hidden" name="jobNumber" value={job} />
              <input type="hidden" name="assigned" value="false" />
              <button className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs text-slate-700">
                {job} ✕
              </button>
            </form>
          ))}
        </div>
      ) : null}

      <form action={resetAction} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="userId" value={user.id} />
        <Field label="Reset access" hint="Sets a new temporary password through the credential provider.">
          <input name="temporaryPassword" className={inputClass} minLength={10} placeholder="new temporary password" />
        </Field>
        <button className={secondaryButtonClass} disabled={resetting}>
          {resetting ? 'Resetting…' : 'Reset access'}
        </button>
        {resetState && resetState.ok === false ? (
          <span className="text-sm text-rose-800">{resetState.error}</span>
        ) : null}
        {resetState?.ok ? <span className="text-sm text-emerald-800">Password set.</span> : null}
      </form>

      <form action={setUserDisabledAction}>
        <input type="hidden" name="userId" value={user.id} />
        <input type="hidden" name="disabled" value={user.is_active ? 'true' : 'false'} />
        <button
          className={
            user.is_active
              ? 'rounded-md border border-rose-300 bg-white px-4 py-2 text-sm font-medium text-rose-700'
              : secondaryButtonClass
          }
        >
          {user.is_active ? 'Disable account' : 'Re-enable account'}
        </button>
      </form>
    </div>
  );
}
