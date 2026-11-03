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
 *
 * READ-ONLY as of the CmsApi pricing cutover (plan step 7). Editing moved to
 * the CMS's own pricing screen, which goes through /v1/pricing's versioned
 * draft/publish path (save_pricing_draft -> publish_pricing_revision) instead
 * of the direct, unversioned `.update().eq('id', true)` this panel used. This
 * page stays as a live read-out of the values checkout is actually charging —
 * which is exactly what it is best at, since it renders them through the same
 * derivePrice the storefront uses.
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
      {/* Always locked — see the cutover note above. Not `locked={loadError !== null}`
          any more: this panel is no longer a writer under any condition. */}
      <PricingEditor initial={config} locked />
    </>
  );
}
