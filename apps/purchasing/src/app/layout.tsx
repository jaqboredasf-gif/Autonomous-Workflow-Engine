import type { Metadata } from 'next';
import { Inter, Geist_Mono } from 'next/font/google';

import './globals.css';
import AppShell from '../components/pcc/AppShell';
import { PilotBanner } from '../components/ui';
import { appTitle } from '../purchasing/organization/identity.mjs';

// Inter is the PCC's typeface (02_DESIGN_SYSTEM). The mono face stays for the
// PO sheet, where columns of numbers have to line up when printed.
const inter = Inter({ variable: '--font-inter', subsets: ['latin'], display: 'swap' });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: appTitle(),
  description: 'Material requests, workshop review, purchase orders and receiving.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full bg-canvas font-sans text-ink">
        <PilotBanner />
        {/* The shell renders itself only for a signed-in caller; public pages
            come through untouched and keep their own centred layouts. */}
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
