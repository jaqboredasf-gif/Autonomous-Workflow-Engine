'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/', label: 'Dashboard' },
  { href: '/requests/new', label: 'New Request' },
  { href: '/settings', label: 'Settings' },
];

export default function Nav() {
  const path = usePathname();

  return (
    <header className="no-print border-b border-neutral-200 bg-white">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
        <Link href="/" className="flex items-baseline gap-2">
          <span className="text-lg font-bold tracking-tight text-neutral-900">
            LIPPOLIS ELECTRIC
          </span>
          <span className="text-xs font-medium uppercase tracking-widest text-neutral-500">
            Purchasing
          </span>
        </Link>
        <nav className="flex gap-1 text-sm">
          {LINKS.map((l) => {
            const active = l.href === '/' ? path === '/' : path.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`rounded px-3 py-1.5 font-medium ${
                  active
                    ? 'bg-neutral-900 text-white'
                    : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900'
                }`}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
