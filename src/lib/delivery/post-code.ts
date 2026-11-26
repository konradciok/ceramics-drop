/**
 * Polish postcodes ("00-000"). The InPost courier is domestic only, so the
 * courier address form and its server check both speak this one format.
 */

/** The canonical form: two digits, a hyphen, three digits. */
export const PL_POST_CODE_RE = /^\d{2}-\d{3}$/;

/**
 * As-you-type formatting for the postcode field: keeps the digits (at most
 * five) and puts the hyphen after the second one, so "31019" reads "31-019".
 */
export function formatPlPostCode(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 5);
  return digits.length > 2 ? `${digits.slice(0, 2)}-${digits.slice(2)}` : digits;
}

/**
 * The canonical postcode for a typed one, or null when it is not a Polish
 * postcode. Accepts "31-019", "31019" and "31 019".
 */
export function normalizePlPostCode(raw: string): string | null {
  const match = /^(\d{2})[-\s]?(\d{3})$/.exec(raw.trim());
  return match ? `${match[1]}-${match[2]}` : null;
}
