/**
 * Pure conversion helpers for the promotions editor. Kept out of the client
 * component so the datetime-local ↔ UTC ISO and major → minor unit rules are
 * unit-testable (the zod schema rejects raw timezone-less datetime-local
 * values, so the editor MUST convert before submit).
 */

/**
 * `datetime-local` input value (timezone-less `YYYY-MM-DDTHH:mm`, interpreted
 * in the operator's local timezone) → UTC ISO string for the API. Empty or
 * unparseable → null.
 */
export function datetimeLocalToIso(value: string): string | null {
  const t = value.trim();
  if (!t) return null;
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** UTC ISO (or null) → the local `datetime-local` input value; null → ''. */
export function isoToDatetimeLocal(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Operator-entered MAJOR units ("50" zł) → minor units for the API. Empty →
 * null; non-numeric values propagate as NaN so the server zod check rejects
 * them with a per-field error instead of the client silently coercing.
 */
export function majorToMinor(value: string): number | null {
  const t = value.trim();
  if (!t) return null;
  const n = Number(t);
  // NaN would serialize to `null` over JSON, hiding a bad entry from the
  // server zod check as an omitted field instead of an invalid one — send a
  // value the schema actually rejects (amount_pln is z.number().positive()).
  return Number.isFinite(n) ? Math.round(n * 100) : -1;
}
