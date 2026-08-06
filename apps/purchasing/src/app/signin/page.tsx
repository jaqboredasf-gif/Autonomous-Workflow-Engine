// Sign-in for the pilot: pick who you are. See src/server/session.ts for the
// stated gap — this identifies, it does not authenticate.
import { signInOptions } from '../../server/session.ts';
import { signInAction } from '../actions.ts';
import { buttonClass } from '../../components/ui';

export const dynamic = 'force-dynamic';

export default function SignInPage() {
  const users = signInOptions();
  return (
    <div className="mx-auto max-w-md">
      <h1 className="text-xl font-semibold text-slate-900">Sign in</h1>
      <p className="mt-1 text-sm text-slate-600">
        Pilot sign-in. Choose the person you are; the server records everything you do under that name.
      </p>
      <div className="mt-6 space-y-2">
        {users.map((u) => (
          <form key={u.id} action={signInAction}>
            <input type="hidden" name="userId" value={u.id} />
            <button
              type="submit"
              className="flex w-full items-center justify-between rounded-lg border border-slate-200 bg-white px-4 py-3 text-left shadow-sm hover:border-slate-400"
            >
              <span>
                <span className="block text-sm font-medium text-slate-900">{u.name}</span>
                <span className="block text-xs text-slate-500">
                  {u.roles.join(', ')}
                  {u.isPrimaryApprover ? ' · primary approver' : ''}
                  {u.isBackupApprover ? ' · backup approver' : ''}
                  {u.canApprove && !u.roles.includes('WORKSHOP_APPROVER') ? ' · approval granted' : ''}
                </span>
              </span>
              <span className={buttonClass}>Sign in</span>
            </button>
          </form>
        ))}
      </div>
    </div>
  );
}
