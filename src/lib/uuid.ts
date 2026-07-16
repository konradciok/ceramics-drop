/** Canonical 8-4-4-4-12 hex UUID shape (any version), case-insensitive. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Truthy guard for uuid-shaped strings — null/empty/undefined → false. */
export function isUuid(s: string | null | undefined): s is string {
  return !!s && UUID_RE.test(s);
}
