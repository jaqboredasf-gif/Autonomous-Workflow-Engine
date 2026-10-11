// ---------------------------------------------------------------------------
// MoreDetails — the fold everything unusual lives below.
//
// THE PROBLEM IT SOLVES. Both working screens had grown to hold every field the
// domain supports, which is a different thing from every field the job needs.
// The field form asked a foreman standing in a parking lot for twelve answers
// to order one coupling; the review screen asked Mike for eleven per line. Both
// were complete and both were slower than the phone call they replace.
//
// Nothing is deleted — an unusual case still has to be reachable, and a control
// that disappears when it is needed is worse than one that is always there.
// They move below a fold, and the ordinary path is what remains above it.
//
// Native <details>, so it works without JavaScript, is keyboard-operable and
// announces itself to a screen reader without any of that being written here.
// ---------------------------------------------------------------------------

export function MoreDetails({
  label = 'More details',
  hint,
  open = false,
  children,
}: {
  label?: string;
  /** One line saying what is under the fold, so opening it is not a guess. */
  hint?: string;
  /** Start open — for a case the screen already knows is unusual. */
  open?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details open={open} className="group rounded-md border border-line bg-surface">
      <summary
        className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm font-medium text-ink-soft
                   hover:bg-subtle [&::-webkit-details-marker]:hidden"
      >
        <span
          aria-hidden
          className="inline-block text-xs text-muted transition-transform group-open:rotate-90"
        >
          ▶
        </span>
        {label}
        {hint ? <span className="ml-1 text-xs font-normal text-muted">{hint}</span> : null}
      </summary>
      <div className="space-y-3 border-t border-line p-3">{children}</div>
    </details>
  );
}
