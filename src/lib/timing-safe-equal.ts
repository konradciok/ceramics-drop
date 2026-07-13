/**
 * Constant-time string equality. Unequal lengths short-circuit (a length
 * mismatch already reveals the strings differ), but equal-length inputs are
 * compared in full so a timing side-channel can't reveal how many leading
 * bytes matched. Used to compare webhook secrets and signatures.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
