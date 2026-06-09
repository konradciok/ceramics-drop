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

/** PL phone → E.164 digits, no '+'. 9-digit local numbers get the 48 country code. */
export function normalizePhonePl(raw: string): string | null {
  let digits = raw.replace(/[^0-9]/g, '');
  if (digits.length === 0) return null;
  if (digits.length === 9) digits = `48${digits}`;
  return digits;
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
