// Button and ButtonLink — one definition, four variants, two sizes.
//
// Server components: no state, no effects. A form's submit button, a link
// styled as a button, and a destructive action all come from here so a screen
// never has to hand-roll a className string.
import Link from 'next/link';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'm' | 'l';

const BASE =
  'inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium ' +
  'transition select-none disabled:cursor-not-allowed disabled:opacity-50';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-action text-white shadow-sm hover:bg-action-hover',
  secondary: 'border border-line-strong bg-surface text-ink-soft shadow-sm hover:bg-subtle',
  ghost: 'text-ink-soft hover:bg-subtle',
  danger: 'bg-danger text-white shadow-sm hover:brightness-95',
};

// 40px and 48px. The large size is the field size: a gloved thumb on a phone.
const SIZES: Record<ButtonSize, string> = {
  m: 'h-10 px-4',
  l: 'h-12 px-5 text-base',
};

export function buttonStyle(variant: ButtonVariant = 'primary', size: ButtonSize = 'm', extra = '') {
  return `${BASE} ${VARIANTS[variant]} ${SIZES[size]} ${extra}`.trim();
}

export function Button({
  variant = 'primary',
  size = 'm',
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button {...props} className={buttonStyle(variant, size, className)} />;
}

export function ButtonLink({
  href,
  variant = 'primary',
  size = 'm',
  className = '',
  children,
  ...props
}: {
  href: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children: React.ReactNode;
} & Omit<React.ComponentProps<typeof Link>, 'href' | 'className'>) {
  return (
    <Link href={href} className={buttonStyle(variant, size, className)} {...props}>
      {children}
    </Link>
  );
}

/** A row of actions with consistent spacing. Wraps on narrow screens. */
export function ButtonRow({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`flex flex-wrap items-center gap-2 ${className}`}>{children}</div>;
}
