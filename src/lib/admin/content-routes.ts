import { z } from 'zod';
import { NextResponse } from 'next/server';
import { cmsKindSchema, cmsLocaleSchema, zodIssues } from '@/lib/cms/schemas';

export const contentRefSchema = z.object({
  kind: cmsKindSchema,
  slug: z.string().min(1),
  locale: cmsLocaleSchema,
});

export const draftBodySchema = contentRefSchema.extend({
  payload: z.unknown(),
});

export const versionBodySchema = contentRefSchema.extend({
  version: z.number().int().positive(),
});

export function actorEmail(req: Request): string | null {
  return req.headers.get('Cf-Access-Authenticated-User-Email') ?? req.headers.get('X-Admin-Actor-Email');
}

export async function parseJson<T>(req: Request, schema: z.ZodSchema<T>): Promise<{ ok: true; data: T } | { ok: false; res: NextResponse }> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return { ok: false, res: NextResponse.json({ error: 'invalid_json' }, { status: 400 }) };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      res: NextResponse.json({ error: 'validation_failed', fields: zodIssues(parsed.error) }, { status: 400 }),
    };
  }
  return { ok: true, data: parsed.data };
}

export function contentError(error: unknown): NextResponse {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('missing_locale:')) {
    return NextResponse.json({ error: 'missing_locale', locale: message.split(':')[1] }, { status: 409 });
  }
  if (message === 'unsupported_document' || message === 'document_not_found' || message === 'version_not_found') {
    return NextResponse.json({ error: message }, { status: 404 });
  }
  if (error instanceof z.ZodError) {
    return NextResponse.json({ error: 'validation_failed', fields: zodIssues(error) }, { status: 400 });
  }
  return NextResponse.json({ error: message || 'cms_failed' }, { status: 500 });
}
