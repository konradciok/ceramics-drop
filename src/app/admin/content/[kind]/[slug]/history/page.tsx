import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getContentEditorState } from '@/lib/admin/content';
import { CMS_LOCALES } from '@/lib/cms/types';
import { isCmsKind } from '@/lib/cms/schemas';
import { formatDateTime, StatusPill } from '@/app/admin/ui';
import { RevertButton } from './RevertButton';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ kind: string; slug: string }> };

export default async function ContentHistoryPage({ params }: Props) {
  const { kind, slug } = await params;
  if (!isCmsKind(kind)) notFound();
  const state = await getContentEditorState(kind, slug);
  if (!state) notFound();

  return (
    <>
      <Link className="adm-back" href={`/admin/content/${kind}/${slug}`}>← Edytor</Link>
      <h1 className="adm-h1">Historia · {state.label}</h1>
      <p className="adm-sub"><span className="adm-mono">{kind}:{slug}</span></p>

      {CMS_LOCALES.map((locale) => {
        const versions = state.locales[locale].versions;
        return (
          <section className="adm-section" key={locale}>
            <h2 className="adm-section-title">{locale}</h2>
            <div className="adm-tablewrap">
              {versions.length === 0 ? (
                <div className="adm-empty">Brak wersji CMS dla tego locale.</div>
              ) : (
                <table className="adm-table adm-table--stack">
                  <thead>
                    <tr>
                      <th>Wersja</th>
                      <th>Status</th>
                      <th>Autor</th>
                      <th>Utworzono</th>
                      <th><span className="adm-sr-only">Akcje</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {versions.map((version) => (
                      <tr key={version.id}>
                        <td className="adm-num" data-label="Wersja">v{version.version}</td>
                        <td data-label="Status"><StatusPill status={version.status} /></td>
                        <td data-label="Autor">{version.created_by ?? <span className="adm-muted">—</span>}</td>
                        <td className="adm-num" data-label="Utworzono">{formatDateTime(version.created_at)}</td>
                        <td data-label="Akcje">
                          <RevertButton kind={state.kind} slug={state.slug} locale={locale} version={version.version} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        );
      })}
    </>
  );
}
