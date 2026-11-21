import { revalidatePath } from 'next/cache';
import { NextResponse } from 'next/server';
import { publishVersion } from '@/lib/admin/content';
import { actorEmail, contentError, localizedPath, parseJson, versionBodySchema } from '@/lib/admin/content-routes';
import { registryProductsByCategory } from '@/lib/products';
import { HOME_PAGE_SLUG, type CmsLocale } from '@/lib/cms/types';
import type { CategorySlug } from '@/lib/types';

export const dynamic = 'force-dynamic';

function revalidateProductNotes(slug: string, locale: CmsLocale) {
  for (const product of registryProductsByCategory(slug as CategorySlug)) {
    revalidatePath(localizedPath(locale, `/${slug}/${product.id}`));
  }
}

export async function POST(req: Request) {
  const parsed = await parseJson(req, versionBodySchema);
  if (!parsed.ok) return parsed.res;
  try {
    const version = await publishVersion({ ...parsed.data, actorEmail: actorEmail(req) });
    if (parsed.data.kind === 'product_notes') revalidateProductNotes(parsed.data.slug, parsed.data.locale);
    if (parsed.data.kind === 'page' && parsed.data.slug === HOME_PAGE_SLUG) {
      revalidatePath(localizedPath(parsed.data.locale, '/'));
    }
    return NextResponse.json({ version });
  } catch (err) {
    return contentError(err);
  }
}
