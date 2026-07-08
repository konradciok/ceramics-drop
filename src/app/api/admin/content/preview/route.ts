import { NextResponse } from 'next/server';
import { mintPreviewToken } from '@/lib/cms/server';
import { contentError, parseJson, versionBodySchema } from '@/lib/admin/content-routes';
import { getProductsByCategory } from '@/lib/products';
import type { CategorySlug } from '@/lib/types';

export const dynamic = 'force-dynamic';

function localizedPath(locale: string, path: string): string {
  return locale === 'pl' ? path : `/${locale}${path}`;
}

function previewPath(kind: string, slug: string, locale: string): string {
  if (kind !== 'product_notes') return localizedPath(locale, '/');
  if (slug === 'fine-art-prints') return localizedPath(locale, '/fine-art-prints/fap01');
  const product = getProductsByCategory(slug as CategorySlug)[0];
  return localizedPath(locale, product ? `/${slug}/${product.id}` : `/${slug}`);
}

export async function POST(req: Request) {
  const parsed = await parseJson(req, versionBodySchema);
  if (!parsed.ok) return parsed.res;
  try {
    const token = await mintPreviewToken(parsed.data);
    return NextResponse.json({ token, path: previewPath(parsed.data.kind, parsed.data.slug, parsed.data.locale) });
  } catch (err) {
    return contentError(err);
  }
}
