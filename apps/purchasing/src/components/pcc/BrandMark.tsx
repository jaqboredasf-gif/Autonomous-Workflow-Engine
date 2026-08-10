'use client';
// The Lippolis mark, in one place.
//
// EVERY appearance of the logo goes through this component, so replacing the
// artwork is a file swap in public/brand/ and nothing else. Nowhere else in the
// app may reference the image path directly.
//
// A client component only for the fallback: if the SVG cannot be fetched or
// parsed, `onError` swaps to the PNG. That is not a theoretical case — an SVG
// with a malformed comment renders as a broken image and takes the brand off
// every screen at once, silently. The PNG is the seatbelt.
import { useState } from 'react';

const SVG = '/brand/lippolis-logo.svg';
const PNG = '/brand/lippolis-logo.png';

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
};

export function BrandMark({ size = 28, variant = 'mark', subtitle = 'Purchasing Control Center', className = '' }: BrandMarkProps) {
  const [src, setSrc] = useState(SVG);

  // The logo is decorative WHEN a text lockup names the company beside it, and
  // meaningful when it stands alone. Screen readers should hear the company
  // once, not twice.
  const mark = (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={variant === 'lockup' ? '' : 'Lippolis Electric'}
      aria-hidden={variant === 'lockup' ? true : undefined}
      onError={() => setSrc((current) => (current === SVG ? PNG : current))}
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
        <span className="block truncate text-sm font-semibold tracking-tight text-ink">Lippolis Electric</span>
        {subtitle ? (
          <span className="block truncate text-[11px] font-medium uppercase tracking-wider text-muted">{subtitle}</span>
        ) : null}
      </span>
    </span>
  );
}

export default BrandMark;
