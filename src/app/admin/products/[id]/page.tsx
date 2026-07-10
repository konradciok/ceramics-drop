import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getProductEditorState } from '@/lib/admin/catalog-list';
import { ProductEditor } from './ProductEditor';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ id: string }> };

/** Single-product editor. Metadata/status writes only affect the storefront in
 *  CATALOG_SOURCE=db mode; the code registry is unaffected. */
export default async function ProductEditorPage({ params }: Props) {
  const { id } = await params;
  const state = await getProductEditorState(id);
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
          <Link className="adm-btn" href={state.pdpPath} target="_blank">Strona publiczna</Link>
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
    </>
  );
}
