/*
 * Studio admin dashboard root layout. Lives OUTSIDE [locale] so it carries none
 * of the storefront i18n chrome; it is its own root layout (own <html>/<body>)
 * since the storefront's root layout is [locale]/layout.tsx. Production access
 * is gated by Cloudflare Access JWT verification in worker.ts.
 */
import '@/styles/fonts.css';
import '@/styles/tokens.css';
import '@/styles/admin.css';

import type { Metadata } from 'next';
import { AdminNav } from './AdminNav';
import { ToastProvider } from '@/components/admin/Toast';

export const metadata: Metadata = {
  title: 'Studio Admin',
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pl">
      <body>
        <ToastProvider>
          <div className="adm">
            <header className="adm-top">
              <span className="adm-brand">Anna&nbsp;Ciok · <b>Admin</b></span>
              <AdminNav />
              <span className="adm-top-tag">studio</span>
            </header>
            <main className="adm-main">{children}</main>
          </div>
        </ToastProvider>
      </body>
    </html>
  );
}
