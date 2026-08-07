/* eslint-disable @typescript-eslint/no-explicit-any */
// The authenticated product shell.
//
// It resolves the caller ONCE on the server and hands the chrome a finished
// list of destinations. A signed-out request renders its children bare, which
// is what lets /sign-in, /forgot-password and /unauthorized keep their own
// full-page centred layouts without the shell fighting them.
import { currentActor, purchasingRequestContext } from '../../server/session.ts';
import { navigationFor } from '../../purchasing/domain/navigation.mjs';
import { hasPermission } from '../../purchasing/domain/roles.mjs';
import { signOutAction } from '../../app/auth-actions.ts';
import { ShellChrome } from './ShellChrome';

export default async function AppShell({ children }: { children: React.ReactNode }) {
  const actor = await currentActor();
  if (!actor) return <>{children}</>;

  const groups = navigationFor(actor).map((g: any) => ({
    key: g.key,
    label: g.label,
    items: g.items.map((i: any) => ({ key: i.key, label: i.label, path: i.path })),
  }));

  // The notification count is the one query the shell makes. It is wrapped
  // because a shell that throws takes every page down with it, and an unread
  // badge is not worth that.
  let unread = 0;
  try {
    const ctx = await purchasingRequestContext();
    unread = (await ctx.notifications.inboxFor(actor.id)).filter((n: any) => !n.read_at).length;
  } catch {
    unread = 0;
  }

  // Global search lands wherever this person's work actually is: the
  // purchasing queue if they run it, their own request list otherwise.
  const searchPath = hasPermission(actor, 'review.read_queue')
    ? '/workshop'
    : hasPermission(actor, 'request.read.all')
      ? '/office'
      : '/requests';

  return (
    <ShellChrome
      groups={groups}
      user={{
        name: actor.name,
        roles: actor.roles,
        canApprove: Boolean(actor.canApprove),
        approvalByGrant: Boolean(actor.canApprove) && !actor.roles.includes('WORKSHOP_APPROVER'),
      }}
      unread={unread}
      searchPath={searchPath}
      signOut={
        <form action={signOutAction}>
          <button
            type="submit"
            className="text-xs font-medium text-muted underline underline-offset-2 hover:text-ink"
          >
            Sign out
          </button>
        </form>
      }
    >
      {children}
    </ShellChrome>
  );
}
