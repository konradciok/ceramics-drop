/*
 * LOCAL-ONLY admin dashboard root layout. Lives OUTSIDE [locale] so it carries
 * none of the storefront i18n chrome; it is its own root layout (own <html>/
 * <body>) since the storefront's root layout is [locale]/layout.tsx. Never
 * committed/deployed (gitignored + middleware skip-worktree).
 */
import '@/styles/fonts.css';
import '@/styles/tokens.css';
import '@/styles/admin.css';

import type { Metadata } from 'next';
import { AdminNav } from './AdminNav';

export const metadata: Metadata = {
  title: 'Studio Admin',
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pl">
      <body>
        <div className="adm">
          <header className="adm-top">
            <span className="adm-brand">Anna&nbsp;Ciok · <b>Admin</b></span>
            <AdminNav />
            <span className="adm-top-tag">local only</span>
          </header>
          <main className="adm-main">{children}</main>
        </div>
      </body>
    </html>
  );
}
