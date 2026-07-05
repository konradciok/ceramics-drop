/**
 * Shared admin UI for InPost packing recommendations (orders + fulfillment).
 * The plan is guidance only — `shipx.ts` still creates every shipment with its
 * fixed default parcel (locker template `medium` / courier 38 × 64 × 19 cm box),
 * so the panel spells out where the recommendation and the label diverge.
 */
import { productRef } from '@/lib/admin/products';
import { PARCEL_LABEL, recommendPacking, type PackingConfidence } from '@/lib/packing';

const CONFIDENCE_LABEL: Record<PackingConfidence, string> = {
  high: 'wysoka',
  medium: 'średnia',
  low: 'niska',
};

const kg = (v: number) => `~${v.toFixed(1).replace('.', ',')} kg`;

/** Compact package-plan cell: `B`, `C + A`, `—` for pickup, ⚠ when unsure. */
export function packingCell(deliveryMethod: string | null, productIds: string[]): string {
  if (deliveryMethod === 'odbior' || productIds.length === 0) return '—';
  const plan = recommendPacking(productIds);
  return plan.manualReview ? `${plan.planLabel} ⚠` : plan.planLabel;
}

/** The "Pakowanie" panel body (wrapped in its own `adm-panel`). */
export function PackingPanel({ deliveryMethod, productIds }: { deliveryMethod: string | null; productIds: string[] }) {
  const packing = deliveryMethod === 'odbior' ? null : recommendPacking(productIds);

  const shipxWarnings: string[] = [];
  if (packing && packing.packages.length > 1) {
    shipxWarnings.push(
      `Plan wymaga ${packing.packages.length} paczek — system tworzy automatycznie tylko jedną przesyłkę InPost, kolejne etykiety trzeba nadać ręcznie.`,
    );
  }
  if (packing && deliveryMethod === 'kurier' && packing.packages.some((p) => p.size === 'C')) {
    shipxWarnings.push(
      'Kurier: domyślna etykieta deklaruje karton 38 × 64 × 19 cm — paczka gabarytu C wymaga ręcznej korekty wymiarów przesyłki.',
    );
  }
  if (packing && deliveryMethod === 'paczkomat' && packing.packages.some((p) => p.size === 'C')) {
    shipxWarnings.push(
      'Paczkomat: domyślna etykieta rezerwuje skrytkę gabarytu B — paczka gabarytu C się w niej nie zmieści, zmień rozmiar przesyłki przy nadaniu.',
    );
  }

  return (
    <div className="adm-panel">
      <h3>Pakowanie</h3>
      {!packing ? (
        <p className="adm-muted">Odbiór osobisty — bez paczki.</p>
      ) : (
        <>
          <dl className="adm-dl">
            <dt>Plan</dt>
            <dd>
              {packing.planLabel}
              {packing.manualReview ? <span className="adm-text-danger"> · do weryfikacji</span> : null}
            </dd>
            <dt>Waga</dt><dd>{kg(packing.totalWeightKg)}</dd>
            <dt>Pewność</dt><dd>{CONFIDENCE_LABEL[packing.confidence]}</dd>
          </dl>
          {packing.packages.map((parcel, i) => (
            <div className="adm-item" key={`${parcel.size}-${i}`}>
              <div className="adm-item-meta">
                <div>Paczka {i + 1} · {PARCEL_LABEL[parcel.size]}</div>
                <div className="id">{parcel.itemIds.map((pid) => productRef(pid).label).join(', ')}</div>
              </div>
              <div className="adm-num">{kg(parcel.weightKg)}</div>
            </div>
          ))}
          <ul className="adm-packing-notes">
            {[...packing.warnings, ...shipxWarnings].map((w, i) => (
              <li key={`warn-${i}`} className="adm-text-danger">{w}</li>
            ))}
            {packing.notes.map((note, i) => (
              <li key={`note-${i}`} className="adm-muted">{note}</li>
            ))}
            <li className="adm-muted">
              Etykieta InPost powstaje dziś z domyślnym rozmiarem (gabaryt B) — plan powyżej to wskazówka pakowania.
            </li>
          </ul>
        </>
      )}
    </div>
  );
}
