import type { Metadata } from 'next';

// Stripe return callback is a 'use client' page and can't export
// generateMetadata itself — this sibling layout keeps it out of the index,
// matching the noindex already set on /koszyk.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function ReturnLayout({ children }: { children: React.ReactNode }) {
  return children;
}
