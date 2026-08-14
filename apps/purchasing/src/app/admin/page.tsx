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
import { declarePoPairNewAction, initializePoSequenceAction } from '../actions.ts';

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
          sequences={await S.poSequences(ctx, actor)}
          vendors={await S.listVendors(ctx, actor)}
          jobs={jobs}
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
  sequences,
  vendors,
  jobs,
  settings,
  locations,
  templates,
}: {
  sequences: any[];
  vendors: any[];
  jobs: any[];
  settings: any;
  locations: any[];
  templates: any[];
}) {
  return (
    <div className="space-y-4">
      <Panel
        title="PO numbering"
        subtitle="Job number, vendor, and a number that counts from 1 for that job and that vendor."
      >
        {/* THE RULE, SAID PLAINLY AND FIRST. An administrator arriving here
            used to find a prefix, a padding and a single company-wide "next
            number" — a scheme the office does not use. There is nothing to
            configure now, so what this panel owes the reader is the rule
            itself and the one case where a person still has to say something. */}
        <Alert tone="info" title="How a purchase order number is made">
          <p>
            A purchase order number is the <strong>job number</strong>, the <strong>vendor</strong>, and a{' '}
            <strong>number that counts from 1</strong> — and it counts separately for each job and vendor.
          </p>
          <ul className="ml-4 mt-2 list-disc space-y-1">
            <li>Job 1234, first order to Cooper → <code>1234-COOPER-1</code></li>
            <li>Job 1234, second order to Cooper → <code>1234-COOPER-2</code></li>
            <li>Job 1234, first order to Graybar → <code>1234-GRAYBAR-1</code></li>
            <li>Job 5678, first order to Cooper → <code>5678-COOPER-1</code></li>
          </ul>
          <p className="mt-2">
            Nothing here needs setting up for a new job or a new vendor: the count starts at 1 because nothing has
            been ordered yet. A number, once issued, never changes — renaming a vendor or a job does not touch it.
          </p>
        </Alert>

        {/* THE ONE THING A PERSON STILL HAS TO SAY. If the office already
            wrote paper purchase orders for a job and a vendor, PCC starting
            that pair at 1 would put a number a supplier already has on a
            second, different order. */}
        <Alert
          tone="warning"
          title="If the office already wrote paper purchase orders for a job and vendor, say so here first"
        >
          <p>
            PCC counts from 1 for a job and vendor it has issued nothing for. Where the office has <em>already</em>{' '}
            written orders for that pair by hand, tell PCC where the pair had reached — otherwise the next order
            carries a number a supplier already has.
          </p>
          <p className="mt-2">
            Only for pairs that already have paper orders. <strong>Do not guess a number.</strong> A sequence can
            only move forward, and PCC refuses anything at or below a number it has already issued itself.
          </p>
        </Alert>

        <form action={initializePoSequenceAction} className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
          <label className="text-xs font-medium text-ink-soft sm:col-span-1">
            Job number
            <select
              name="jobNumber"
              className="mt-1 w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink"
              defaultValue=""
            >
              <option value="" disabled>
                Choose a job
              </option>
              {jobs.map((j: any) => (
                <option key={String(j.job_number)} value={String(j.job_number)}>
                  {String(j.job_number)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-ink-soft sm:col-span-1">
            Vendor
            <select
              name="vendorId"
              className="mt-1 w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink"
              defaultValue=""
            >
              <option value="" disabled>
                Choose a vendor
              </option>
              {vendors.map((v: any) => (
                <option key={v.id} value={v.id}>
                  {v.name} ({v.code})
                </option>
              ))}
            </select>
          </label>
          {/* Two ways to say the same thing, because both are things a person
              actually knows. Exactly one is required, so a half-filled form
              cannot be mistaken for an answer. */}
          <TextInput
            label="Last paper number"
            name="lastIssuedSequence"
            inputMode="numeric"
            hint="e.g. 3 if the last one written was 1234-COOPER-3"
          />
          <TextInput
            label="or next number"
            name="nextSequence"
            inputMode="numeric"
            hint="e.g. 4 if the next one should be 1234-COOPER-4"
          />
          {/* REQUIRED ONLY WHEN THE PAIR IS ALREADY IN USE. Moving a sequence
              that has real purchase orders behind it is legitimate — an office
              reconciling a gap after an outage — and a bad accident. The server
              refuses it without this box, naming the count, so the two are told
              apart by whether the person had seen the orders. */}
          <label className="col-span-2 flex items-start gap-2 text-xs text-ink-soft sm:col-span-5">
            <input type="checkbox" name="acknowledgeIssued" value="true" className="mt-0.5" />
            <span>
              This job and vendor <strong>already has purchase orders raised in PCC</strong>, and I mean to move its
              sequence anyway. Leave unticked unless PCC refused and told you the count.
            </span>
          </label>
          <div className="flex items-end">
            <ConfirmSubmit
              variant="primary"
              label="Set this pair"
              title="Set the sequence for this job and vendor?"
              body={
                <>
                  <p>
                    The next purchase order PCC raises for this job and this vendor will take the number you
                    entered, and the count continues from there. No other job or vendor is affected, and no order
                    already issued is renumbered.
                  </p>
                  <p className="mt-2">
                    Check it against the office&rsquo;s paper file before confirming. It cannot be wound back
                    afterwards, and a gap is much easier to live with than a duplicate.
                  </p>
                </>
              }
              confirmLabel="Set the sequence"
            />
          </div>
        </form>

        {/* THE OTHER ANSWER, and its own form on purpose. "This pair is new"
            is a different sentence from "this pair stands at N", and a person
            who can give the second by accident while meaning the first is how a
            job with paper history gets confirmed as having none. Until one of
            the two is recorded, pcc-verify-production.mjs keeps asking. */}
        <form action={declarePoPairNewAction} className="mt-5 grid grid-cols-2 gap-3 border-t border-line pt-4 sm:grid-cols-5">
          <label className="text-xs font-medium text-ink-soft sm:col-span-1">
            Job number
            <select
              name="jobNumber"
              className="mt-1 w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink"
              defaultValue=""
            >
              <option value="" disabled>
                Choose a job
              </option>
              {jobs.map((j: any) => (
                <option key={String(j.job_number)} value={String(j.job_number)}>
                  {String(j.job_number)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-ink-soft sm:col-span-1">
            Vendor
            <select
              name="vendorId"
              className="mt-1 w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink"
              defaultValue=""
            >
              <option value="" disabled>
                Choose a vendor
              </option>
              {vendors.map((v: any) => (
                <option key={v.id} value={v.id}>
                  {v.name} ({v.code})
                </option>
              ))}
            </select>
          </label>
          <p className="col-span-2 self-end text-xs text-muted sm:col-span-2">
            Use this when the office has checked and there are <strong>no paper purchase orders</strong> for this job
            and vendor. Nothing about the count changes — it starts at 1 either way — but the pair stops being an
            unanswered question before go-live.
          </p>
          <div className="flex items-end">
            <ConfirmSubmit
              variant="secondary"
              label="Confirm as new"
              title="Confirm this job and vendor has no paper history?"
              body={
                <p>
                  Record that the office has checked and this job and vendor has never had a purchase order written
                  for it by hand. Its first PCC order will be number 1. If paper orders DO exist, use the form above
                  instead — starting at 1 would issue a number the supplier already holds.
                </p>
              }
              confirmLabel="It has no paper history"
            />
          </div>
        </form>

        {/* WHERE EVERY PAIR STANDS. A counter appears here the first time an
            order is raised against the pair, so an empty table on a new
            installation is the truth and not a missing setup step. */}
        <div className="mt-5">
          {sequences.length === 0 ? (
            <EmptyState
              title="No purchase orders have been numbered yet"
              description="A job and vendor appears here as soon as its first order is raised, or when its paper sequence is set above."
            />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-muted">
                  <th className="py-1">Job</th>
                  <th className="py-1">Vendor</th>
                  <th className="py-1">Issued by PCC</th>
                  <th className="py-1">Next number</th>
                  <th className="py-1">How it was settled</th>
                </tr>
              </thead>
              <tbody>
                {sequences.map((row: any) => (
                  <tr key={`${row.job_number}:${row.vendor_id}`} className="border-t border-line">
                    <td className="py-1 font-medium text-ink">{row.job_number}</td>
                    <td className="py-1 text-ink-soft">
                      {row.vendor_name} <span className="text-muted">({row.vendor_code})</span>
                    </td>
                    <td className="py-1 text-ink-soft">{Number(row.issued_count ?? 0)}</td>
                    {/* PRINTED, NOT ASSEMBLED. The organization's numbering
                        strategy produced this string; the screen does not know
                        that a purchase order number contains a job. */}
                    <td className="py-1 font-mono text-xs text-ink">{row.nextPoNumber}</td>
                    {/* The same four states pcc-verify-production.mjs reports,
                        so the screen and the go/no-go check cannot disagree
                        about which pairs are still open questions. */}
                    <td className="py-1 text-xs text-muted">
                      {Number(row.issued_count ?? 0) > 0
                        ? 'In use — PCC has issued numbers'
                        : row.initialized_at && Number(row.next_value) > 1
                          ? `Continued from paper, set ${new Date(row.initialized_at).toLocaleDateString()}`
                          : row.initialized_at
                            ? `Confirmed as new, ${new Date(row.initialized_at).toLocaleDateString()}`
                            : 'Not confirmed — will start at 1'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
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
