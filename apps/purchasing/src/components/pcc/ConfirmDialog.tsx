'use client';
// Confirmation before an action a person cannot take back.
//
// Wraps a real submit button inside a real <form>: the button opens a native
// <dialog>, and confirming calls form.requestSubmit(). If JavaScript never
// loads, the fallback is a plain submit button — the action still works, it
// just is not double-checked. Failing OPEN here is right: a foreman on bad
// site signal must still be able to record what arrived.
//
// `requireTyping` is for the genuinely destructive end (cancelling an order a
// vendor has already been told about). BR-009 means nothing here ever hard
// deletes; the strongest thing this guards is a cancel.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { buttonStyle, type ButtonSize, type ButtonVariant } from './Button';

/** Whether we are on the client never changes after hydration, so nothing subscribes. */
const subscribeToNothing = () => () => {};

export function ConfirmSubmit({
  label,
  title,
  body,
  confirmLabel,
  cancelLabel = 'Go back',
  variant = 'danger',
  size = 'm',
  requireTyping,
  name,
  value,
  className = '',
  disabled,
}: {
  label: string;
  title: string;
  body: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** When set, the user must type this exact word before confirming. */
  requireTyping?: string;
  name?: string;
  value?: string;
  className?: string;
  disabled?: boolean;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [typed, setTyped] = useState('');
  // Only take over the button once the client is running. Before that the
  // button is an ordinary submit and the action is reachable without JS.
  //
  // useSyncExternalStore rather than a set-a-flag effect: the server snapshot
  // is false and the client snapshot is true, which is exactly this question,
  // and it answers it without a second render or a synchronous setState.
  const enhanced = useSyncExternalStore(subscribeToNothing, () => true, () => false);

  const ready = !requireTyping || typed.trim().toUpperCase() === requireTyping.toUpperCase();

  const open = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (!enhanced) return;
    event.preventDefault();
    setTyped('');
    dialogRef.current?.showModal();
  };

  const confirm = () => {
    if (!ready) return;
    dialogRef.current?.close();
    // requestSubmit() runs validation and fires submit, which is what a server
    // action is listening for. .submit() would skip both.
    buttonRef.current?.form?.requestSubmit(buttonRef.current);
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="submit"
        name={name}
        value={value}
        disabled={disabled}
        onClick={open}
        className={buttonStyle(variant, size, className)}
      >
        {label}
      </button>

      <dialog
        ref={dialogRef}
        aria-labelledby="confirm-title"
        className="w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-line bg-surface p-0 text-ink shadow-pop backdrop:bg-ink/40"
        onClose={() => setTyped('')}
      >
        <div className="p-5">
          <h2 id="confirm-title" className="text-base font-semibold text-ink">
            {title}
          </h2>
          <div className="mt-2 text-sm text-ink-soft">{body}</div>

          {requireTyping ? (
            <label className="mt-4 block text-sm text-ink-soft">
              Type <strong className="font-semibold text-ink">{requireTyping}</strong> to confirm
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                className="mt-1 h-10 w-full rounded-md border border-line-strong bg-surface px-3 text-base text-ink focus:border-action focus:outline-none focus:ring-1 focus:ring-action"
              />
            </label>
          ) : null}

          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <button type="button" onClick={() => dialogRef.current?.close()} className={buttonStyle('secondary', 'm')}>
              {cancelLabel}
            </button>
            <button type="button" disabled={!ready} onClick={confirm} className={buttonStyle(variant, 'm')}>
              {confirmLabel ?? label}
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}

/**
 * Warn before leaving a form with unsaved edits. Mounted inside the form it
 * guards; it watches for any input event and arms the browser's own prompt.
 */
export function UnsavedChangesGuard({ formId }: { formId: string }) {
  useEffect(() => {
    const form = document.getElementById(formId) as HTMLFormElement | null;
    if (!form) return;

    let dirty = false;
    const markDirty = () => {
      dirty = true;
    };
    const clear = () => {
      dirty = false;
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = '';
    };

    form.addEventListener('input', markDirty);
    form.addEventListener('submit', clear);
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      form.removeEventListener('input', markDirty);
      form.removeEventListener('submit', clear);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [formId]);

  return null;
}
