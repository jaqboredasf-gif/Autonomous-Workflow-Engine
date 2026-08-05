import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import DemoBanner from '@/components/DemoBanner';
import Nav from '@/components/Nav';
import { PurchasingProvider } from '@/lib/store-context';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Lippolis Electric — Purchasing (Demo)',
  description: 'Purchasing control dashboard prototype. Simulated data only.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full font-sans">
        <PurchasingProvider>
          <DemoBanner />
          <Nav />
          {children}
        </PurchasingProvider>
      </body>
    </html>
  );
}
