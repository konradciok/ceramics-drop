export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function normalizeEmail(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  return v.length > 0 ? v : null;
}

/**
 * Calling codes for destinations whose national numbers are 9 digits with no
 * trunk prefix, so a bare local number can be completed unambiguously.
 */
const NINE_DIGIT_CALLING_CODES: Record<string, string> = { PL: '48', ES: '34' };

/**
 * Phone → Meta's `ph` format: digits only, country code included, no '+' or
 * leading zeros. An international number (`+…` / `00…`) is kept as typed. A bare
 * 9-digit local number gets the calling code of the parcel's destination;
 * without a known destination it is assumed Polish (home market, and InPost
 * Poland only accepts PL mobiles). Any other bare number is passed through —
 * guessing a country would hash a number that matches no-one.
 */
export function normalizePhone(raw: string, countryCode: string | null = null): string | null {
  const trimmed = raw.trim();
  let digits = trimmed.replace(/[^0-9]/g, '');
  if (digits.length === 0) return null;
  if (trimmed.startsWith('+') || digits.startsWith('00')) return digits.replace(/^0+/, '') || null;
  const callingCode = NINE_DIGIT_CALLING_CODES[(countryCode ?? 'PL').toUpperCase()];
  if (digits.length === 9 && callingCode) digits = `${callingCode}${digits}`;
  return digits;
}

/** Postal code → Meta's `zp` format: lowercase, no spaces and no dash (`30-001` → `30001`). */
export function normalizePostCode(raw: string): string | null {
  const v = raw.trim().toLowerCase().replace(/[\s-]+/g, '');
  return v.length > 0 ? v : null;
}

/**
 * City → Meta's `ct` format: lowercase, no spaces, no punctuation
 * (`Bielsko-Biała` → `bielskobiała`). Letters outside a–z are kept as UTF-8,
 * which Meta accepts.
 */
export function normalizeCity(raw: string): string | null {
  const v = raw.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  return v.length > 0 ? v : null;
}

export function normalizeText(raw: string, opts: { stripSpaces?: boolean } = {}): string | null {
  let v = raw.trim().toLowerCase();
  if (opts.stripSpaces) v = v.replace(/\s+/g, '');
  return v.length > 0 ? v : null;
}

/** Hash one user field into Meta's `[hash]` array shape, or undefined if empty. */
export async function hashUserField(
  raw: string | null | undefined,
  normalize: (v: string) => string | null,
): Promise<string[] | undefined> {
  if (!raw) return undefined;
  const normalized = normalize(raw);
  if (!normalized) return undefined;
  return [await sha256Hex(normalized)];
}
