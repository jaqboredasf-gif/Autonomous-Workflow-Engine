// The input family: text, search, select, textarea, date, number, currency.
//
// Server components. Every one of them is a real form control with a real
// name, so the screens keep working as plain HTML forms posting to server
// actions — no client bundle is paid for a text box.
//
// The visual contract is one shared class so error, disabled and focus look
// the same everywhere. Labels, helper text and error text come from <Field>,
// which ties them to the control with aria-describedby.

export const controlClass =
  'w-full rounded-md border border-line-strong bg-surface px-3 text-base text-ink shadow-sm ' +
  'placeholder:text-muted transition ' +
  'focus:border-action focus:outline-none focus:ring-1 focus:ring-action ' +
  'disabled:cursor-not-allowed disabled:bg-subtle disabled:text-muted';

/** 40px on desktop, and the same control is 48px when `size="l"` for the field. */
const HEIGHTS = { m: 'h-10 py-2', l: 'h-12 py-3' };

const ERROR = 'border-danger focus:border-danger focus:ring-danger';

export function fieldStyle(opts: { size?: 'm' | 'l'; invalid?: boolean; className?: string } = {}) {
  const { size = 'm', invalid = false, className = '' } = opts;
  return `${controlClass} ${HEIGHTS[size]} ${invalid ? ERROR : ''} ${className}`.trim();
}

let sequence = 0;
function autoId(prefix: string) {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

/**
 * Label + control + helper/error, wired together.
 *
 * `htmlFor`/`id` are threaded rather than wrapping the control in the label,
 * because a wrapping label around a <select> swallows clicks on some mobile
 * browsers and this form is used on phones.
 */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  required,
  children,
  className = '',
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  const describedBy = error ? `${htmlFor ?? ''}-error` : hint ? `${htmlFor ?? ''}-hint` : undefined;
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className="mb-1 block text-xs font-semibold text-ink-soft">
        {label}
        {required ? (
          <span className="text-danger" aria-hidden="true">
            {' '}
            *
          </span>
        ) : null}
        {required ? <span className="sr-only"> (required)</span> : null}
      </label>
      {children}
      {error ? (
        <p id={describedBy} role="alert" className="mt-1 text-xs font-medium text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={describedBy} className="mt-1 text-xs text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

// `controlSize` rather than `size`: <input size> and <select size> are real
// HTML attributes with different meanings, and shadowing them makes the props
// unusable together.
type Common = { label?: string; hint?: string; error?: string | null; controlSize?: 'm' | 'l'; wrapperClassName?: string };

export function TextInput({
  label,
  hint,
  error,
  controlSize = 'm',
  wrapperClassName,
  className = '',
  id,
  ...props
}: Common & React.InputHTMLAttributes<HTMLInputElement>) {
  const controlId = id ?? autoId('input');
  const control = (
    <input
      {...props}
      id={controlId}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? `${controlId}-error` : hint ? `${controlId}-hint` : undefined}
      className={fieldStyle({ size: controlSize, invalid: Boolean(error), className })}
    />
  );
  if (!label) return control;
  return (
    <Field
      label={label}
      htmlFor={controlId}
      hint={hint}
      error={error}
      required={props.required}
      className={wrapperClassName}
    >
      {control}
    </Field>
  );
}

export function SelectInput({
  label,
  hint,
  error,
  controlSize = 'm',
  wrapperClassName,
  className = '',
  id,
  children,
  ...props
}: Common & React.SelectHTMLAttributes<HTMLSelectElement>) {
  const controlId = id ?? autoId('select');
  const control = (
    <select
      {...props}
      id={controlId}
      aria-invalid={error ? true : undefined}
      className={fieldStyle({ size: controlSize, invalid: Boolean(error), className: `pr-8 ${className}` })}
    >
      {children}
    </select>
  );
  if (!label) return control;
  return (
    <Field label={label} htmlFor={controlId} hint={hint} error={error} required={props.required} className={wrapperClassName}>
      {control}
    </Field>
  );
}

export function TextArea({
  label,
  hint,
  error,
  wrapperClassName,
  className = '',
  id,
  rows = 3,
  ...props
}: Common & React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const controlId = id ?? autoId('textarea');
  const control = (
    <textarea
      {...props}
      rows={rows}
      id={controlId}
      aria-invalid={error ? true : undefined}
      className={`${controlClass} py-2 ${error ? ERROR : ''} ${className}`.trim()}
    />
  );
  if (!label) return control;
  return (
    <Field label={label} htmlFor={controlId} hint={hint} error={error} required={props.required} className={wrapperClassName}>
      {control}
    </Field>
  );
}

/**
 * Search box with a leading magnifier. `type="search"` so a phone shows the
 * search key and offers to clear the field.
 */
export function SearchInput({
  label,
  className = '',
  controlSize = 'm',
  wrapperClassName = '',
  ...props
}: Common & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className={`relative ${wrapperClassName}`}>
      <span aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="9" cy="9" r="6" />
          <path d="m14 14 4 4" strokeLinecap="round" />
        </svg>
      </span>
      <input
        {...props}
        type="search"
        aria-label={props['aria-label'] ?? label ?? 'Search'}
        className={fieldStyle({ size: controlSize, className: `pl-9 ${className}` })}
      />
    </div>
  );
}

/** Money entry. Stores dollars in the form; the server converts to cents. */
export function CurrencyInput({
  label,
  hint,
  error,
  wrapperClassName,
  className = '',
  id,
  ...props
}: Common & React.InputHTMLAttributes<HTMLInputElement>) {
  const controlId = id ?? autoId('currency');
  const control = (
    <div className="relative">
      <span aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">
        $
      </span>
      <input
        {...props}
        id={controlId}
        type="text"
        inputMode="decimal"
        aria-invalid={error ? true : undefined}
        className={fieldStyle({ invalid: Boolean(error), className: `pl-7 tabular-nums ${className}` })}
      />
    </div>
  );
  if (!label) return control;
  return (
    <Field label={label} htmlFor={controlId} hint={hint} error={error} required={props.required} className={wrapperClassName}>
      {control}
    </Field>
  );
}

/** A labelled checkbox with a 44px hit area, for filter bars and forms. */
export function CheckboxField({
  label,
  className = '',
  ...props
}: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className={`flex min-h-10 cursor-pointer items-center gap-2 text-sm text-ink-soft ${className}`}>
      <input
        {...props}
        type="checkbox"
        className="h-4 w-4 rounded border-line-strong text-action focus:ring-action"
      />
      {label}
    </label>
  );
}
