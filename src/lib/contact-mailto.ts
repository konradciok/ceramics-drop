/** Long mailto: URLs silently fail on some OS/browser combos (~2000 char cap). */
const MAX_MAILTO_URL = 1900;

export interface ContactMailtoInput {
  to: string;
  subject: string;
  message: string;
  /** Appended verbatim after the message, e.g. "\n\n— Ania (ania@example.com)". */
  signature: string;
  /** Localized "message truncated — paste the rest" note shown inside the body. */
  truncatedNote: string;
}

/**
 * Builds the contact-form mailto: URL, truncating the message so the final
 * URL stays within budget. The cut is measured on the *encoded* URL — raw
 * character counts are useless here, since `encodeURIComponent` expands
 * Polish diacritics 6x and emoji 12x.
 */
export function buildContactMailto(
  { to, subject, message, signature, truncatedNote }: ContactMailtoInput,
  maxLength = MAX_MAILTO_URL,
): string {
  const base = `mailto:${to}?subject=${encodeURIComponent(subject)}`;
  const urlFor = (msg: string, truncated: boolean) =>
    `${base}&body=${encodeURIComponent(
      `${msg}${truncated ? `…\n[${truncatedNote}]` : ''}${signature}`,
    )}`;

  const full = urlFor(message, false);
  if (full.length <= maxLength) return full;

  // Binary-search the longest message prefix whose *encoded* URL still fits.
  let lo = 0;
  let hi = message.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (urlFor(sliceSafe(message, mid), true).length <= maxLength) lo = mid;
    else hi = mid - 1;
  }
  const truncated = urlFor(sliceSafe(message, lo), true);
  // Even an empty message may not fit (oversized signature/subject): rather
  // than hand the OS a broken URL, fall back to a bare compose window.
  return truncated.length <= maxLength ? truncated : base;
}

/** Slice without leaving a lone high surrogate — encodeURIComponent throws on those. */
function sliceSafe(s: string, n: number): string {
  const out = s.slice(0, n);
  const last = out.charCodeAt(out.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? out.slice(0, -1) : out;
}
