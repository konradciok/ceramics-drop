import { revalidatePath } from 'next/cache';
import { NextResponse } from 'next/server';
import { publishVersion } from '@/lib/admin/content';
import { actorEmail, contentError, parseJson, versionBodySchema } from '@/lib/admin/content-routes';
import { getProductsByCategory } from '@/lib/products';
import { getPrintDesigns } from '@/lib/prints';
import type { CmsLocale } from '@/lib/cms/types';
import type { CategorySlug } from '@/lib/types';

export const dynamic = 'force-dynamic';

function localizedPath(locale: CmsLocale, path: string): string {
  return locale === 'pl' ? path : `/${locale}${path}`;
}

function revalidateProductNotes(slug: string, locale: CmsLocale) {
  if (slug === 'fine-art-prints') {
    for (const design of getPrintDesigns()) revalidatePath(localizedPath(locale, `/fine-art-prints/${design.id}`));
  } else {
    for (const product of getProductsByCategory(slug as CategorySlug)) {
      revalidatePath(localizedPath(locale, `/${slug}/${product.id}`));
    }
  }
  revalidatePath('/api/feed/google');
  revalidatePath('/api/feed/meta');
}

export async function POST(req: Request) {
  const parsed = await parseJson(req, versionBodySchema);
  if (!parsed.ok) return parsed.res;
  try {
    const version = await publishVersion({ ...parsed.data, actorEmail: actorEmail(req) });
    if (parsed.data.kind === 'product_notes') revalidateProductNotes(parsed.data.slug, parsed.data.locale);
    return NextResponse.json({ version });
  } catch (err) {
    return contentError(err);
  }
}
