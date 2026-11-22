import { NextResponse } from 'next/server';
import { mintPreviewToken } from '@/lib/cms/server';
import { editableDocument } from '@/lib/admin/content';
import { contentError, localizedPath, parseJson, versionBodySchema } from '@/lib/admin/content-routes';
import { registryProductsByCategory } from '@/lib/products';
import { PRINT_PDP_SLUG, type CmsLocale } from '@/lib/cms/types';
import type { CategorySlug } from '@/lib/types';

export const dynamic = 'force-dynamic';

function previewPath(kind: string, slug: string, locale: CmsLocale): string {
  // The print-pdp document now only feeds the gift-card page (bio, accordions).
  if (kind === 'page' && slug === PRINT_PDP_SLUG) return localizedPath(locale, '/karta-podarunkowa');
  if (kind !== 'product_notes') return localizedPath(locale, '/');
  const product = registryProductsByCategory(slug as CategorySlug)[0];
  return localizedPath(locale, product ? `/${slug}/${product.id}` : `/${slug}`);
}

export async function POST(req: Request) {
  const parsed = await parseJson(req, versionBodySchema);
  if (!parsed.ok) return parsed.res;
  if (!editableDocument(parsed.data.kind, parsed.data.slug)) {
    return NextResponse.json({ error: 'unsupported_document' }, { status: 404 });
  }
  try {
    const token = await mintPreviewToken(parsed.data);
    return NextResponse.json({ token, path: previewPath(parsed.data.kind, parsed.data.slug, parsed.data.locale) });
  } catch (err) {
    return contentError(err);
  }
}
