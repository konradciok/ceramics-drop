import type { Metadata } from 'next';

/**
 * `metadata.robots` for a page whose indexability depends on the mere
 * PRESENCE of a `?preview` query param, never its value. An admin-only draft
 * view must never be indexable — even `?preview=` (empty) or an invalid
 * token, since the page body falls back to published content regardless
 * (see verifyPreviewToken/getPreviewContent in src/lib/cms/server.ts).
 * Next.js delivers a repeated query key (`?preview=a&preview=b`) as
 * `string[]`, which must noindex too. Only the true ABSENCE of the `preview`
 * key is indexable — returns `undefined` so callers can spread it straight
 * into `Metadata.robots` and inherit the (unset) layout default.
 */
export function previewRobots(previewParam: string | string[] | undefined): Metadata['robots'] {
  return previewParam !== undefined ? { index: false, follow: false } : undefined;
}
