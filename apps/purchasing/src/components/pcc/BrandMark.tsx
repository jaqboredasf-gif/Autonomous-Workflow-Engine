'use client';
// The organization's mark, in one place.
//
// EVERY appearance of the logo goes through this component, so replacing the
// artwork is a file swap in public/brand/ and nothing else. Nowhere else in the
// app may reference the image path directly.
//
// THE COMPANY IS NO LONGER HARD-CODED. This file named Lippolis three times —
// the SVG path, the image's alt text, and the lockup's company line — so a
// second organization's staff would have signed in under another company's
// mark. The name comes from the installation's own identity now, and an
// organization that has supplied no artwork gets a text wordmark of its own
// name, which is a real answer rather than a placeholder.
//
// A client component only for the fallback: if the SVG cannot be fetched or
// parsed, `onError` swaps to the PNG. That is not a theoretical case — an SVG
// with a malformed comment renders as a broken image and takes the brand off
// every screen at once, silently. The PNG is the seatbelt.
import { useState } from 'react';

export type BrandMarkProps = {
  /** Rendered height in px. The mark's own aspect ratio does the rest. */
  size?: number;
  /**
   * `mark` is the logo alone (tight spaces: the sidebar rail, a print header).
   * `lockup` adds the company and product names beside it.
   */
  variant?: 'mark' | 'lockup';
  /** Product line under the company name. Omitted from the print sheet. */
  subtitle?: string | null;
  className?: string;
  /** The installation's own company name. From organization/identity.mjs. */
  companyName: string;
  /** Same-origin path to the organization's artwork, or null for a wordmark. */
  logoSrc?: string | null;
  logoFallbackSrc?: string | null;
};

export function BrandMark({
  size = 28, variant = 'mark', subtitle = 'Purchasing Control Center', className = '',
  companyName, logoSrc = null, logoFallbackSrc = null,
}: BrandMarkProps) {
  const [src, setSrc] = useState(logoSrc);

  // The logo is decorative WHEN a text lockup names the company beside it, and
  // meaningful when it stands alone. Screen readers should hear the company
  // once, not twice.
  // NO ARTWORK, NO PROBLEM. An organization that has supplied no logo gets its
  // initials in the product's own accent, which is legible, correct, and does
  // not block a pilot on somebody locating a vector file.
  const wordmark = (
    <span
      aria-hidden={variant === 'lockup' ? true : undefined}
      aria-label={variant === 'lockup' ? undefined : companyName}
      role={variant === 'lockup' ? undefined : 'img'}
      style={{ height: size, width: size, fontSize: Math.round(size * 0.42) }}
      className="inline-flex shrink-0 select-none items-center justify-center rounded-md bg-ink font-semibold tracking-tight text-white"
    >
      {companyName.split(/\s+/).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join('')}
    </span>
  );

  const mark = !src ? wordmark : (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={variant === 'lockup' ? '' : companyName}
      aria-hidden={variant === 'lockup' ? true : undefined}
      onError={() => setSrc((current) => (current === logoSrc ? logoFallbackSrc : current))}
      // An SVG can LOAD and still draw nothing — no intrinsic size means
      // `width: auto` resolves to zero, and `onError` never fires because
      // nothing errored. That failure is invisible in code review and obvious
      // to every user, so it falls back on the same path as a real error.
      onLoad={(event) => {
        const img = event.currentTarget;
        if (img.naturalWidth === 0) setSrc((current) => (current === logoSrc ? logoFallbackSrc : current));
      }}
      style={{ height: size, width: 'auto' }}
      className="shrink-0 select-none"
      draggable={false}
    />
  );

  if (variant === 'mark') return <span className={`inline-flex ${className}`}>{mark}</span>;

  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      {mark}
      <span className="min-w-0 leading-tight">
        <span className="block truncate text-sm font-semibold tracking-tight text-ink">{companyName}</span>
        {subtitle ? (
          <span className="block truncate text-[11px] font-medium uppercase tracking-wider text-muted">{subtitle}</span>
        ) : null}
      </span>
    </span>
  );
}

export default BrandMark;
