import { listProducts } from '@/lib/admin/catalog-list';
import { ProductsTable } from './ProductsTable';

// Consistent with the other admin pages (orders, inventory): force request-time
// rendering so admin data is never statically cached.
export const dynamic = 'force-dynamic';

export default async function ProductsPage() {
  const { rows, source, dbCount, expectedCount } = await listProducts();

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

      <ProductsTable rows={rows} />
    </>
  );
}
