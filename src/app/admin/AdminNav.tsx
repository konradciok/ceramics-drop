'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/admin', label: 'Przegląd' },
  { href: '/admin/orders', label: 'Zamówienia' },
  { href: '/admin/customers', label: 'Klienci' },
  { href: '/admin/inventory', label: 'Magazyn' },
];

export function AdminNav() {
  const path = usePathname();
  return (
    <nav className="adm-nav">
      {LINKS.map((l) => {
        const active = l.href === '/admin' ? path === '/admin' : path.startsWith(l.href);
        return (
          <Link key={l.href} href={l.href} className={active ? 'is-active' : ''}>
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
