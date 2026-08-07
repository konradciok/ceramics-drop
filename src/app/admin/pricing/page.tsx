import { adminSupabase } from '@/lib/admin/clients';
import { readPrintPricingConfig } from '@/lib/print-pricing-config/repository';
import { DEFAULT_PRINT_PRICING } from '@/lib/print-pricing';
import { PricingEditor } from './PricingEditor';

export const dynamic = 'force-dynamic';

/**
 * Global fine-art-print price list. Reads the single `print_pricing_config`
 * row fresh on every render (admin reads the DB directly, regardless of
 * CATALOG_SOURCE); a failed read renders the editor over the code defaults
 * with a warning banner instead of blanking the page.
 */
export default async function PricingPage() {
  let config = DEFAULT_PRINT_PRICING;
  let loadError: string | null = null;
  try {
    config = await readPrintPricingConfig(adminSupabase());
  } catch (err) {
    loadError =
      err instanceof Error && err.message === 'print_pricing_missing'
        ? 'Brak wiersza cennika w bazie — zastosuj migrację print_pricing_config. Pokazuję wartości domyślne z kodu.'
        : 'Nie udało się wczytać cennika z bazy — pokazuję wartości domyślne z kodu.';
    console.error('[admin/pricing] read failed', err);
  }

  return (
    <>
      <h1 className="adm-h1">Cennik — Fine Art Prints</h1>
      <p className="adm-sub">
        Jeden globalny cennik dla wszystkich printów: ceny bazowe wg rozmiaru oraz dopłaty za ramę
        i passe-partout, edytowane w EUR. PLN i GBP są wyliczane z kursów (zaokrąglenie do 5 zł / 1 £).
      </p>
      {loadError && <p className="adm-banner">{loadError}</p>}
      <PricingEditor initial={config} locked={loadError !== null} />
    </>
  );
}
