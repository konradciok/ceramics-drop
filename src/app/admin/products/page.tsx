import { listProducts } from '@/lib/admin/catalog-list';
import type { ProductDisplayStatus } from '@/lib/catalog/status';
import { ProductsTable } from './ProductsTable';

// Consistent with the other admin pages (orders, inventory): force request-time
// rendering so admin data is never statically cached.
export const dynamic = 'force-dynamic';

/** KPI tiles that partition every product (counts sum to rows.length). */
const KPI_TILES: { label: string; statuses: ProductDisplayStatus[] }[] = [
  { label: 'Aktywne', statuses: ['active'] },
  { label: 'Rezerwacje', statuses: ['reserved'] },
  { label: 'Sprzedane', statuses: ['sold'] },
  { label: 'Showroom', statuses: ['showroom'] },
  { label: 'Brak stanu', statuses: ['out_of_stock'] },
  { label: 'Szkice', statuses: ['draft'] },
  { label: 'Ukryte / archiwum', statuses: ['hidden', 'archived'] },
];

export default async function ProductsPage() {
  const { rows, source, dbCount, expectedCount } = await listProducts();

  const counts = {} as Record<ProductDisplayStatus, number>;
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const tally = (statuses: ProductDisplayStatus[]) => statuses.reduce((n, s) => n + (counts[s] ?? 0), 0);

  return (
    <>
      <h1 className="adm-h1">Produkty</h1>
      <p className="adm-sub">
        {rows.length} pozycji · katalog (metadane) + stan magazynowy. Widok tylko do odczytu.
      </p>

      {source === 'registry' ? (
        <div className="adm-banner">
          {dbCount === 0 ? (
            <>Tabele katalogu są jeszcze puste — uruchom <code>npm run catalog:backfill</code>. Do czasu backfillu
            lista pochodzi z rejestru kodu (identyczna z tym, co wstawi backfill).</>
          ) : (
            <>Katalog w bazie jest niekompletny ({dbCount}/{expectedCount}) — uruchom ponownie{' '}
            <code>npm run catalog:backfill</code>. Do czasu synchronizacji lista pochodzi z rejestru kodu.</>
          )}
        </div>
      ) : null}

      <div className="adm-kpis adm-kpis--tight">
        {KPI_TILES.map((tile) => (
          <div className="adm-kpi" key={tile.label}>
            <p className="adm-kpi-label">{tile.label}</p>
            <div className="adm-kpi-value">{tally(tile.statuses)}</div>
          </div>
        ))}
      </div>

      <ProductsTable rows={rows} />
    </>
  );
}
