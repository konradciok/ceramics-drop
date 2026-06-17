import { notFound } from 'next/navigation';
import { isCategoryHidden } from './products';
import type { CategorySlug } from './types';

/**
 * 404 a withdrawn (hidden) family. Call it from BOTH a collection route's
 * `generateMetadata` and its page body (and from the PDP) so a hidden family
 * returns a real HTTP 404 with no indexable `<head>` — title, description and
 * hreflang `alternatesFor` would otherwise still be emitted on the 404 shell.
 *
 * Lives in its own module (not `products.ts`) so the `next/navigation` import
 * never leaks into the Node-only scripts and unit tests that consume the
 * product registry.
 */
export function assertCategoryPublic(slug: CategorySlug): void {
  if (isCategoryHidden(slug)) notFound();
}
