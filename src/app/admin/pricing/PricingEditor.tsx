'use client';

/* ============================================================
   PricingEditor — the global fine-art-print price list form.
   9 EUR values (per-size base / frame / mount surcharges) + 2 conversion
   rates, saved in one POST to /api/admin/print-pricing. The derived PLN/GBP
   preview uses the SAME derivePrice the storefront and checkout use, so what
   the operator sees is exactly what ships. Per-field server errors follow the
   ContentEditor pattern (Zod `fields` → adm-field-error), success/failure go
   through the shared toast stack.
   ============================================================ */
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useToast } from '@/components/admin/Toast';
import {
  derivePrice,
  type PrintPricingConfig,
} from '@/lib/print-pricing';
import type { PrintSize } from '@/lib/types';

const SIZES: PrintSize[] = ['30x40', '50x70', '70x100'];
const SIZE_LABEL: Record<PrintSize, string> = { '30x40': '30 × 40 cm', '50x70': '50 × 70 cm', '70x100': '70 × 100 cm' };
const GROUPS = [
  { key: 'baseEur', label: 'Cena bazowa (bez ramy)' },
  { key: 'frameEur', label: 'Dopłata za ramę' },
  { key: 'mountEur', label: 'Dopłata za passe-partout' },
] as const;

const ERROR_MAP: Record<string, string> = {
  validation_failed: 'Popraw dane w formularzu.',
  invalid_json: 'Nieprawidłowe żądanie.',
  print_pricing_missing: 'Brak wiersza cennika w bazie — zastosuj migrację print_pricing_config.',
  pricing_write_failed: 'Zapis nie powiódł się. Spróbuj ponownie lub sprawdź logi serwera.',
};

type FieldErrors = Record<string, string>;

/** Raw string field state keyed by the Zod path (baseEur.30x40, eurToPln, …). */
function toFields(config: PrintPricingConfig): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const g of GROUPS) for (const s of SIZES) fields[`${g.key}.${s}`] = String(config[g.key][s]);
  fields.eurToPln = String(config.eurToPln);
  fields.eurToGbp = String(config.eurToGbp);
  return fields;
}

/** Build the POST body from raw strings. Sends raw Numbers (NaN and decimals
    included) so the server Zod check rejects bad input with per-field errors
    instead of the client silently rounding it. */
function toBody(fields: Record<string, string>) {
  const perSize = (key: (typeof GROUPS)[number]['key']) =>
    Object.fromEntries(SIZES.map((s) => [s, Number(fields[`${key}.${s}`])]));
  return {
    baseEur: perSize('baseEur'),
    frameEur: perSize('frameEur'),
    mountEur: perSize('mountEur'),
    eurToPln: Number(fields.eurToPln),
    eurToGbp: Number(fields.eurToGbp),
  };
}

async function postJson(path: string, body: unknown) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; fields?: FieldErrors };
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`) as Error & { fields?: FieldErrors };
    err.fields = data.fields;
    throw err;
  }
  return data;
}

export function PricingEditor({ initial, locked }: { initial: PrintPricingConfig; locked?: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const init = useMemo(() => toFields(initial), [initial]);
  const [fields, setFields] = useState(init);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  // Baseline for the dirty flag — reset to the just-saved values after a
  // successful POST so "Niezapisane zmiany" clears on save.
  const [savedValues, setSavedValues] = useState(init);

  const dirty = useMemo(
    () => Object.keys(fields).some((k) => fields[k] !== savedValues[k]),
    [fields, savedValues],
  );

  function setField(key: string, value: string) {
    setFields((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  // Live preview config from the raw strings; non-numeric fields make their
  // derived cells render as "—" rather than breaking the form.
  const preview = toBody(fields) as PrintPricingConfig;
  const derived = (eur: number, currency: 'pln' | 'gbp') => {
    if (!Number.isFinite(eur) || !Number.isFinite(preview.eurToPln) || !Number.isFinite(preview.eurToGbp)) return '—';
    const v = derivePrice(eur, currency, preview);
    return Number.isFinite(v) ? `${v} ${currency === 'pln' ? 'zł' : '£'}` : '—';
  };

  async function save() {
    setBusy(true);
    setErrors({});
    try {
      await postJson('/api/admin/print-pricing', toBody(fields));
      setSavedValues({ ...fields });
      toast.notify(true, 'Cennik zapisany.');
      router.refresh();
    } catch (err) {
      const e = err as Error & { fields?: FieldErrors };
      setErrors(e.fields ?? {});
      toast.notify(false, ERROR_MAP[e.message] ?? e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="adm-detail-layout">
      <div className="adm-detail-main">
        <section className="adm-editor">
          <h2 className="adm-h">Ceny w EUR</h2>
          <div className="adm-tablewrap">
            <table className="adm-table adm-pricing-table">
              <thead>
                <tr>
                  <th>Rozmiar</th>
                  {GROUPS.map((g) => (
                    <th key={g.key}>{g.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {SIZES.map((size) => (
                  <tr key={size}>
                    <td>{SIZE_LABEL[size]}</td>
                    {GROUPS.map((g) => {
                      const key = `${g.key}.${size}`;
                      return (
                        <td key={key}>
                          <label className="adm-pricing-cell">
                            <span className="adm-visually-hidden">{`${g.label} ${SIZE_LABEL[size]} (EUR)`}</span>
                            <input
                              type="number"
                              min={0}
                              step={1}
                              inputMode="numeric"
                              className={`adm-pricing-input${errors[key] ? ' has-error' : ''}`}
                              value={fields[key]}
                              onChange={(e) => setField(key, e.target.value)}
                              disabled={locked}
                            />
                            <span className="adm-muted">€</span>
                          </label>
                          {errors[key] && <span className="adm-field-error">{errors[key]}</span>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="adm-muted">
            Kolor ramy nie wpływa na cenę. Passe-partout jest dopłatą do wariantu z ramą (nie
            występuje bez ramy).
          </p>
        </section>

        <section className="adm-editor">
          <h2 className="adm-h">Kursy przeliczeniowe</h2>
          {(
            [
              { key: 'eurToPln', label: 'EUR → PLN (wynik zaokrąglany do 5 zł)' },
              { key: 'eurToGbp', label: 'EUR → GBP (wynik zaokrąglany do 1 £)' },
            ] as const
          ).map(({ key, label }) => (
            <label key={key} className="adm-note-label">
              {label}
              <input
                type="number"
                min={0}
                step={0.01}
                inputMode="decimal"
                className={`adm-pricing-input${errors[key] ? ' has-error' : ''}`}
                value={fields[key]}
                onChange={(e) => setField(key, e.target.value)}
                disabled={locked}
              />
              {errors[key] && <span className="adm-field-error">{errors[key]}</span>}
            </label>
          ))}
        </section>

        <div className="adm-actions">
          <button className="adm-btn" disabled={busy || locked} onClick={save}>
            {busy ? 'Zapisywanie…' : 'Zapisz cennik'}
          </button>
          {dirty && <span className="adm-action-msg">Niezapisane zmiany</span>}
        </div>
      </div>

      <aside className="adm-detail-side">
        <section className="adm-editor">
          <h2 className="adm-h">Podgląd cen wynikowych</h2>
          <div className="adm-tablewrap">
            <table className="adm-table adm-pricing-table">
              <thead>
                <tr>
                  <th>Pozycja</th>
                  <th>EUR</th>
                  <th>PLN</th>
                  <th>GBP</th>
                </tr>
              </thead>
              <tbody>
                {GROUPS.flatMap((g) =>
                  SIZES.map((size) => {
                    const eur = preview[g.key][size];
                    return (
                      <tr key={`${g.key}.${size}`}>
                        <td>
                          {g.key === 'baseEur' ? 'Baza' : g.key === 'frameEur' ? '+ Rama' : '+ Passe-partout'}{' '}
                          {SIZE_LABEL[size]}
                        </td>
                        <td className="adm-num">{Number.isFinite(eur) ? `${eur} €` : '—'}</td>
                        <td className="adm-num">{derived(eur, 'pln')}</td>
                        <td className="adm-num">{derived(eur, 'gbp')}</td>
                      </tr>
                    );
                  }),
                )}
              </tbody>
            </table>
          </div>
          <p className="adm-muted">
            Dokładnie te wartości zobaczy klient — podgląd używa tej samej funkcji wyliczającej co
            sklep i checkout. Cena wariantu = baza + (rama) + (passe-partout), składniki wyliczane
            osobno.
          </p>
        </section>
      </aside>
    </div>
  );
}
