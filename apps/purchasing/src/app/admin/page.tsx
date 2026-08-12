/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// Screen 10 — Administration.
//
// One route, eight modules, selected by the URL so an administrator can link a
// colleague straight to the thing being discussed. The modules that CHANGE
// BEHAVIOUR (approval authority, PO numbering, roles) are editable; the ones
// that only describe how the system is wired (permissions, notifications) are
// read-only, because inventing an editor for a table nothing writes would be a
// button that lies.
//
// BR-009 is visible here rather than merely respected: no module offers to
// delete a submitted purchasing record, and the screen says so where somebody
// would go looking for the button.
// ---------------------------------------------------------------------------
import { requireAccess, purchasingRequestContext } from '../../server/session.ts';
import * as S from '../../server/service.ts';
import { listEmailTemplates } from '../../purchasing/application/queries.ts';
import { describeActivity } from '../../purchasing/domain/activity.mjs';
import {
  CAPABILITIES,
  PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  ROLE_PRESETS,
  APPROVAL_GRANT_PERMISSIONS,
} from '../../purchasing/domain/roles.mjs';
import { NOTIFICATION_AUDIENCE, NOTIFICATION_EVENTS } from '../../purchasing/domain/activity.mjs';
import AdminUsers from '../../components/AdminUsers';
import { AdminVendors, AdminJobs } from '../../components/AdminDirectories';
import {
  Alert,
  Badge,
  Button,
  ConfirmSubmit,
  DataGrid,
  DataPoint,
  EmptyState,
  PageHeader,
  Panel,
  SubTabs,
  Table,
  TableFrame,
  TBody,
  TD,
  TextInput,
  TH,
  THead,
  TR,
  type TabItem,
} from '../../components/pcc';
import { updatePoConfigAction } from '../actions.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Administration — Lippolis Purchasing' };

const MODULES = [
  { key: 'users', label: 'Users' },
  { key: 'roles', label: 'Roles' },
  { key: 'permissions', label: 'Permissions' },
  { key: 'jobs', label: 'Jobs' },
  { key: 'vendors', label: 'Vendors' },
  { key: 'materials', label: 'Materials' },
  { key: 'notifications', label: 'Notifications' },
  { key: 'settings', label: 'Organization' },
  { key: 'audit', label: 'Audit log' },
];

export default async function AdminPage({ searchParams }: { searchParams: Promise<{ module?: string }> }) {
  // requireAccess() already refused anyone without admin.settings — a page that
  // renders a polite "not for you" with a 200 has not blocked anything.
  const actor = await requireAccess('/admin');
  const params = await searchParams;
  const active = MODULES.some((m) => m.key === params.module) ? (params.module as string) : 'users';

  const ctx = await purchasingRequestContext();
  const users = await S.listUsers(ctx, actor);
  const jobs = await S.listJobs(ctx, actor);

  const tabs: TabItem[] = MODULES.map((m) => ({ key: m.key, label: m.label }));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Administration"
        description="Who may do what, what the company buys, and the record of every change."
      />

      <SubTabs
        items={tabs}
        active={active}
        ariaLabel="Administration modules"
        hrefFor={(key) => `/admin?module=${key}`}
      />

      {active === 'users' ? (
        <AdminUsers users={users} jobs={jobs.map((j: any) => String(j.job_number))} />
      ) : null}

      {active === 'roles' ? <RolesModule /> : null}
      {active === 'permissions' ? <PermissionsModule /> : null}
      {active === 'jobs' ? <AdminJobs jobs={jobs} /> : null}
      {active === 'vendors' ? <AdminVendors vendors={await S.listVendors(ctx, actor)} /> : null}
      {active === 'materials' ? <MaterialsModule /> : null}
      {active === 'notifications' ? <NotificationsModule /> : null}
      {active === 'settings' ? (
        <SettingsModule
          po={await S.poConfig(ctx, actor)}
          settings={await ctx.reference.settings(actor.orgId)}
          locations={await S.listDeliveryLocations(ctx, actor)}
          templates={await listEmailTemplates(ctx, actor)}
        />
      ) : null}
      {active === 'audit' ? <AuditModule log={await S.auditLog(ctx, actor, 100)} /> : null}
    </div>
  );
}

// --- Roles ------------------------------------------------------------------

function RolesModule() {
  return (
    <div className="space-y-4">
      <Panel title="Role presets" subtitle="What an administrator picks when setting somebody up" bodyClassName="">
        <TableFrame className="rounded-none border-0 shadow-none">
          <Table>
            <THead sticky={false}>
              <tr>
                <TH>Preset</TH>
                <TH>Roles</TH>
                <TH>Approval authority</TH>
                <TH>What it is for</TH>
              </tr>
            </THead>
            <TBody>
              {ROLE_PRESETS.map((preset: any) => (
                <TR key={preset.key}>
                  <TD className="font-medium text-ink">{preset.key.replace(/_/g, ' ').toLowerCase()}</TD>
                  <TD>{preset.roles.join(', ')}</TD>
                  <TD>
                    {preset.canApprove ? <Badge tone="attention">Granted</Badge> : <span className="text-muted">No</span>}
                  </TD>
                  <TD className="text-muted">{preset.description}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableFrame>
      </Panel>

      <Alert tone="info" title="A preset is a starting point, not a new kind of authority">
        Each one expands to roles and grants that already exist. An administrator can still set a person&rsquo;s roles
        individually afterwards, and the system neither remembers nor cares which preset was used. Approval authority
        is a separate grant on top of a role, so office staff can be given it without being handed the whole
        purchasing role.
      </Alert>
    </div>
  );
}

// --- Permissions ------------------------------------------------------------

function PermissionsModule() {
  return (
    <div className="space-y-4">
      <Panel
        title="Permission matrix"
        subtitle="The one definition of who may do what — the server checks these names on every write"
        bodyClassName=""
      >
        <TableFrame className="rounded-none border-0 shadow-none">
          <Table>
            <THead>
              <tr>
                <TH>Permission</TH>
                {ROLES.map((role: string) => (
                  <TH key={role} align="center" className="text-[10px]">
                    {role.replace('WORKSHOP_', '')}
                  </TH>
                ))}
                <TH align="center" className="text-[10px]">
                  +APPROVAL
                </TH>
              </tr>
            </THead>
            <TBody>
              {PERMISSIONS.map((permission: string) => (
                <TR key={permission}>
                  <TD className="whitespace-nowrap font-mono text-xs text-ink">{permission}</TD>
                  {ROLES.map((role: string) => {
                    const held = (ROLE_PERMISSIONS as any)[role].includes(permission);
                    return (
                      <TD key={role} align="center">
                        {/* Text, not a coloured dot: the contract requires
                            meaning to survive without colour. */}
                        <span className={held ? 'font-semibold text-success' : 'text-muted'}>
                          {held ? 'yes' : '—'}
                        </span>
                      </TD>
                    );
                  })}
                  <TD align="center">
                    <span
                      className={
                        APPROVAL_GRANT_PERMISSIONS.includes(permission) ? 'font-semibold text-success' : 'text-muted'
                      }
                    >
                      {APPROVAL_GRANT_PERMISSIONS.includes(permission) ? 'yes' : '—'}
                    </span>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableFrame>
      </Panel>

      <Panel title="Capabilities" subtitle="The coarse names a contract or an operator uses, and what they resolve to">
        <ul className="space-y-2 text-sm">
          {Object.entries(CAPABILITIES).map(([capability, permissions]) => (
            <li key={capability} className="flex flex-wrap items-baseline gap-2">
              <span className="font-mono text-xs font-semibold text-ink">{capability}</span>
              <span className="text-xs text-muted">{(permissions as string[]).join(', ')}</span>
            </li>
          ))}
        </ul>
      </Panel>

      <Alert tone="warning" title="This matrix is read-only, and deliberately so">
        These are the permissions the code enforces, not a configuration table. Changing who may approve a purchase is
        done by changing a person&rsquo;s ROLES or granting approval authority on the Users module — an act that is
        audited against a name. Editing the matrix itself would be a change to the product, and it belongs in a
        release, not in a form.
      </Alert>
    </div>
  );
}

// --- Materials --------------------------------------------------------------

function MaterialsModule() {
  return (
    <div className="space-y-4">
      <Panel title="Material catalogue">
        <p className="text-sm text-ink-soft">
          The catalogue is built from purchase history rather than maintained by hand — every request line records
          the normalized form of what was typed, and the catalogue is a query over those. Browse it on the{' '}
          <a href="/materials" className="text-action hover:underline">
            Materials
          </a>{' '}
          screen.
        </p>
      </Panel>
      <Alert tone="info" title="Curation is not built yet">
        <code className="rounded bg-subtle px-1 py-0.5 text-xs">purchase_item_catalog</code> exists in both providers
        and the Materials screen already reads it, so a curated canonical name, category or preferred vendor would
        show up immediately. Nothing writes to it yet, and an editor that saved nowhere would be worse than its
        absence.
      </Alert>
    </div>
  );
}

// --- Notifications ----------------------------------------------------------

function NotificationsModule() {
  return (
    <div className="space-y-4">
      <Panel title="Who is told what" subtitle="The audience for each purchasing event" bodyClassName="">
        <TableFrame className="rounded-none border-0 shadow-none">
          <Table>
            <THead sticky={false}>
              <tr>
                <TH>Event</TH>
                <TH>Notifies</TH>
              </tr>
            </THead>
            <TBody>
              {NOTIFICATION_EVENTS.map((event: string) => (
                <TR key={event}>
                  <TD className="font-mono text-xs text-ink">{event}</TD>
                  <TD className="text-muted">
                    {((NOTIFICATION_AUDIENCE as any)[event] ?? []).join(', ') || 'nobody'}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableFrame>
      </Panel>
      <Alert tone="info" title="In-application only">
        Notifications appear in the recipient&rsquo;s Alerts inbox. Nothing is emailed: this system composes vendor
        email as a draft and cannot send, and that is a database constraint rather than a setting.
      </Alert>
    </div>
  );
}

// --- Organization settings --------------------------------------------------

function SettingsModule({
  po,
  settings,
  locations,
  templates,
}: {
  po: any;
  settings: any;
  locations: any[];
  templates: any[];
}) {
  return (
    <div className="space-y-4">
      <Panel
        title="PO numbering"
        subtitle="The number the next purchase order will carry. Setting this is how PCC is lined up with the office's paper book."
      >
        {/* WHAT THIS CHANGES, before the fields that change it. The office runs
            a paper sequence; PCC has to continue it rather than start a second
            one, and the person doing that needs to know three things: it
            affects future orders only, it cannot be wound back, and this is
            the number the NEXT order gets — not the last one issued. */}
        <Alert tone="warning" title="Changing this affects every purchase order issued from now on">
          <ul className="ml-4 list-disc space-y-1">
            <li>
              <strong>Next number</strong> is the number the NEXT purchase order will carry — not the last one the
              office issued. If the last paper PO was {po.prefix}
              {String(Math.max(0, Number(po.next_value) - 1)).padStart(Number(po.padding), '0')}, enter{' '}
              {String(po.next_value)}.
            </li>
            <li>
              The sequence can only move <strong>forward</strong>. Winding it back is refused, because a number already
              on a vendor&apos;s invoice must never be issued twice.
            </li>
            <li>Purchase orders already issued keep their numbers. Nothing is renumbered.</li>
            <li>Every change is recorded in the audit log with who made it.</li>
          </ul>
        </Alert>

        <form action={updatePoConfigAction} className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
          <TextInput label="Prefix" name="prefix" defaultValue={po.prefix} />
          <TextInput label="Digits" name="padding" defaultValue={po.padding} inputMode="numeric" />
          <TextInput label="Suffix" name="suffix" defaultValue={po.suffix} />
          <TextInput
            label="Next number"
            name="nextValue"
            defaultValue={po.next_value}
            inputMode="numeric"
            hint={`The next PO will be ${po.prefix}${String(po.next_value).padStart(Number(po.padding), '0')}${po.suffix ?? ''}`}
          />
          <div className="flex items-end">
            <ConfirmSubmit
              variant="primary"
              label="Save PO numbering"
              title="Change the purchase order sequence?"
              body={
                <>
                  <p>
                    The next purchase order raised will take the number you entered, and the sequence continues from
                    there. Orders already issued are untouched.
                  </p>
                  <p className="mt-2">
                    Check the number against the office&apos;s paper book before confirming. It cannot be wound back
                    afterwards, and a gap is much easier to live with than a duplicate.
                  </p>
                </>
              }
              confirmLabel="Change the sequence"
            />
          </div>
        </form>
      </Panel>

      <Panel title="Purchasing settings">
        <DataGrid>
          {/* BR-011: approval authority is granted per user, not by an
              org-wide flag. Showing a "Self-approval: Refused" line here was
              worse than showing nothing — it described a rule the system no
              longer enforces, and an administrator would have believed it. */}
          <DataPoint label="Approval authority">Per user — see Users</DataPoint>
          <DataPoint label="External email sending">Disabled (draft-only)</DataPoint>
          <DataPoint label="Email review before send">Required</DataPoint>
          <DataPoint label="PO template">{settings.poTemplateKey}</DataPoint>
        </DataGrid>
      </Panel>

      <Panel title="Delivery locations" subtitle={`${locations.length} active`}>
        {locations.length === 0 ? (
          <EmptyState title="No delivery locations" description="Requests need somewhere to be delivered to." />
        ) : (
          <ul className="space-y-1 text-sm text-ink-soft">
            {locations.map((l: any) => (
              <li key={l.id}>
                <span className="font-medium text-ink">{l.name}</span> · {l.kind}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Email templates" subtitle="Placeholders in {{double braces}} are filled at draft time">
        <ul className="space-y-2 text-sm">
          {templates.map((t: any) => (
            <li key={t.id}>
              <div className="font-medium text-ink">{t.template_key}</div>
              <div className="text-xs text-muted">{t.subject}</div>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

// --- Audit ------------------------------------------------------------------

function AuditModule({ log }: { log: any[] }) {
  return (
    <div className="space-y-4">
      <Panel title="Audit log" subtitle="The last 100 recorded actions across the organization (BR-008)" bodyClassName="">
        {log.length === 0 ? (
          <EmptyState title="Nothing recorded yet" />
        ) : (
          <ul className="divide-y divide-line">
            {log.map((entry: any) => (
              <li key={entry.id} className="flex flex-wrap items-baseline gap-x-3 px-4 py-2 text-sm">
                <time className="shrink-0 text-xs tabular-nums text-muted">
                  {String(entry.at).slice(0, 16).replace('T', ' ')}
                </time>
                <span className="text-ink-soft">
                  {describeActivity({ ...entry, details: entry.newValues ?? {} })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Alert tone="warning" title="Submitted purchasing records are never deleted (BR-009)">
        There is no delete button on this screen, and there is none anywhere else either. A request that should not
        proceed is CANCELLED, which keeps the record, the reason and the name of whoever cancelled it. The database
        refuses deletion of these tables outright — a trigger, not a convention — and the audit log itself has no
        update or delete policy at all.
      </Alert>
    </div>
  );
}
