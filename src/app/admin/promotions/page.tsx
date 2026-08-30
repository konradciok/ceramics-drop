import { adminSupabase } from '@/lib/admin/clients';
import { listPromotions, type PromoWithStats } from '@/lib/admin/promotions';
import { PromotionsEditor } from './PromotionsEditor';

export const dynamic = 'force-dynamic';

/**
 * Promo-code management. Reads promotions + live utilization stats fresh on
 * every render (admin reads the DB directly); a failed read renders an error
 * banner over an empty table instead of blanking the page. Deactivation takes
 * effect immediately for new checkouts — promo reads are uncached by design.
 */
export default async function PromotionsPage() {
  let promotions: PromoWithStats[] = [];
  let loadError: string | null = null;
  try {
    promotions = await listPromotions(adminSupabase());
  } catch (err) {
    loadError = 'Nie udało się wczytać promocji z bazy. Odśwież stronę lub sprawdź logi serwera.';
    console.error('[admin/promotions] read failed', err);
  }

  return (
    <>
      <h1 className="adm-h1">Promocje</h1>
      <p className="adm-sub">
        Kody rabatowe dla obu ścieżek zakupowych (ceramika i printy). Rabat dotyczy wartości
        produktów — nigdy wysyłki. Dezaktywacja działa natychmiast dla nowych płatności; statystyki
        liczone są z rejestru użyć i opłaconych zamówień.
      </p>
      {loadError && <p className="adm-banner">{loadError}</p>}
      <PromotionsEditor promotions={promotions} />
    </>
  );
}
