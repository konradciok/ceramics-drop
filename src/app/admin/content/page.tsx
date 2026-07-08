import Link from 'next/link';
import { listContentSummaries } from '@/lib/admin/content';
import { CMS_LOCALES } from '@/lib/cms/types';
import { formatDateTime, StatusPill } from '../ui';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ status?: string }>;

export default async function ContentPage({ searchParams }: { searchParams: SearchParams }) {
  const { status } = await searchParams;
  const active = status ?? 'all';
  const docs = await listContentSummaries(active);

  const chip = (label: string, value: string) => {
    const href = value === 'all' ? '/admin/content' : `/admin/content?status=${value}`;
    return <Link className={`adm-chip ${active === value ? 'is-active' : ''}`} href={href}>{label}</Link>;
  };

  return (
    <>
      <h1 className="adm-h1">Tresci</h1>
      <p className="adm-sub">{docs.length} dokumentow edytowalnych w lekkim CMS.</p>

      <div className="adm-toolbar">
        {chip('Wszystkie', 'all')}
        {chip('Opublikowane', 'published')}
        {chip('Szkice', 'draft')}
        {chip('Brak CMS', 'missing')}
      </div>

      <div className="adm-tablewrap">
        <table className="adm-table adm-table--stack">
          <thead>
            <tr>
              <th>Dokument</th>
              <th>Status</th>
              <th>Locale</th>
              <th>Aktualizacja</th>
              <th>Publikacja</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {docs.map((doc) => (
              <tr key={`${doc.kind}:${doc.slug}`}>
                <td data-label="Dokument">
                  <div className="adm-contact">
                    <Link href={`/admin/content/${doc.kind}/${doc.slug}`}>{doc.label}</Link>
                    <span className="adm-muted adm-mono">{doc.kind}:{doc.slug}</span>
                  </div>
                </td>
                <td data-label="Status">
                  {doc.status === 'missing' ? <span className="adm-pill expired">missing</span> : <StatusPill status={doc.status} />}
                </td>
                <td data-label="Locale">
                  <div className="adm-locale-grid">
                    {CMS_LOCALES.map((locale) => {
                      const state = doc.locales[locale];
                      const cls = state.published ? 'published' : state.draft ? 'pending' : 'missing';
                      return <span key={locale} className={`adm-locale ${cls}`}>{locale}</span>;
                    })}
                  </div>
                </td>
                <td className="adm-num" data-label="Aktualizacja">{formatDateTime(doc.updatedAt)}</td>
                <td className="adm-num" data-label="Publikacja">{formatDateTime(doc.publishedAt)}</td>
                <td data-label="">
                  <Link className="adm-btn" href={`/admin/content/${doc.kind}/${doc.slug}`}>Edytuj</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
