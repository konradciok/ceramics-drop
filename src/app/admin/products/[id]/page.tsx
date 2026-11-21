import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getProductEditorState, listProductAudit } from '@/lib/admin/catalog-list';
import { ProductEditor } from './ProductEditor';
import { formatDateTime } from '../../ui';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ id: string }> };

const STATUS_ACTION_LABEL: Record<string, string> = {
  'status:active': 'Status: Aktywny',
  'status:draft': 'Status: Szkic',
  'status:hidden': 'Status: Ukryty',
  'status:archived': 'Status: Archiwum',
};

function auditActionLabel(action: string): string {
  if (action === 'update') return 'Aktualizacja metadanych';
  if (STATUS_ACTION_LABEL[action]) return STATUS_ACTION_LABEL[action];
  if (action === 'print_asset_revoke') return 'Unieważnienie assetu fulfilment';
  return action;
}

/** Single-product editor. Metadata/status writes only affect the storefront in
 *  CATALOG_SOURCE=db mode; the code registry is unaffected. */
export default async function ProductEditorPage({ params }: Props) {
  const { id } = await params;
  const [state, audit] = await Promise.all([
    getProductEditorState(id),
    listProductAudit(id),
  ]);
  if (!state) notFound();

  return (
    <>
      <Link className="adm-back" href="/admin/products">← Produkty</Link>
      <div className="adm-fulfillment-head">
        <div>
          <h1 className="adm-h1">{state.title}</h1>
          <p className="adm-sub">
            <span className="adm-mono">{state.row.id}</span> · {state.categoryLabel}
          </p>
        </div>
        <div className="adm-actions adm-actions--top">
          {state.row.status === 'active' ? (
            <Link className="adm-btn" href={state.pdpPath} target="_blank">Strona publiczna</Link>
          ) : (
            <span className="adm-muted">Niedostępny publicznie (status: {state.row.status})</span>
          )}
          <Link className="adm-btn" href={state.notesHref}>Opis (Treści)</Link>
        </div>
      </div>

      {state.source === 'registry' && (
        <div className="adm-banner">
          Ten produkt nie istnieje jeszcze w bazie — uruchom <span className="adm-mono">catalog:backfill</span>.
          Zapis i zmiana statusu będą możliwe dopiero po backfillu.
        </div>
      )}

      <ProductEditor state={state} />

      {audit.length > 0 && (
        <section className="adm-section">
          <h2 className="adm-section-title">Historia zmian</h2>
          <div className="adm-panel">
            <ul className="adm-timeline">
              {audit.map((entry) => (
                <li key={entry.id} className="done">
                  <span>{auditActionLabel(entry.action)}</span>
                  <span className="adm-num">
                    {formatDateTime(entry.created_at)}
                    {entry.actor_email ? ` · ${entry.actor_email}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
    </>
  );
}
