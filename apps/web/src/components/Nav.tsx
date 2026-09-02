'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/', label: 'Home' },
  { href: '/timesheets', label: 'Timesheets' },
  { href: '/schedule', label: 'Schedule' },
  { href: '/completions', label: 'Completions' },
  { href: '/requests/new', label: 'New Request' },
  { href: '/approvals', label: 'Approvals' },
  { href: '/map', label: 'Map' },
  { href: '/flags', label: 'Flags' },
  { href: '/sites', label: 'Job Sites' },
  { href: '/employees', label: 'Employees' },
  { href: '/payroll', label: 'Payroll' },
  { href: '/settings', label: 'Settings' },
];

export default function Nav() {
  const path = usePathname();
  return (
    <nav className="flex gap-1 border-b bg-neutral-50 px-4 py-2 text-sm dark:bg-neutral-900">
      {LINKS.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          className={`rounded px-3 py-1.5 ${
            path === l.href
              ? 'bg-blue-600 text-white'
              : 'text-neutral-600 hover:bg-neutral-200 dark:text-neutral-300 dark:hover:bg-neutral-800'
          }`}
        >
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
