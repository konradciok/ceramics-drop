import { listProducts } from '@/lib/admin/catalog-list';
import { ProductsTable } from './ProductsTable';

export const dynamic = 'force-dynamic';

export default async function ProductsPage() {
  const { rows, source } = await listProducts();

  const counts = { active: 0, sold: 0, hidden: 0, draft: 0 };
  for (const r of rows) {
    if (r.status === 'active') counts.active += 1;
    else if (r.status === 'sold') counts.sold += 1;
    else if (r.status === 'hidden' || r.status === 'archived') counts.hidden += 1;
    else if (r.status === 'draft') counts.draft += 1;
  }

  return (
    <>
      <h1 className="adm-h1">Produkty</h1>
      <p className="adm-sub">
        {rows.length} pozycji · katalog (metadane) + stan magazynowy. Widok tylko do odczytu.
      </p>

      {source === 'registry' ? (
        <div className="adm-banner">
          Tabele katalogu są jeszcze puste — uruchom <code>npm run catalog:backfill</code>. Do czasu backfillu
          lista pochodzi z rejestru kodu (identyczna z tym, co wstawi backfill).
        </div>
      ) : null}

      <div className="adm-kpis adm-kpis--tight">
        <div className="adm-kpi"><p className="adm-kpi-label">Aktywne</p><div className="adm-kpi-value">{counts.active}</div></div>
        <div className="adm-kpi"><p className="adm-kpi-label">Sprzedane</p><div className="adm-kpi-value">{counts.sold}</div></div>
        <div className="adm-kpi"><p className="adm-kpi-label">Szkice</p><div className="adm-kpi-value">{counts.draft}</div></div>
        <div className="adm-kpi"><p className="adm-kpi-label">Ukryte / archiwum</p><div className="adm-kpi-value">{counts.hidden}</div></div>
      </div>

      <ProductsTable rows={rows} />
    </>
  );
}
