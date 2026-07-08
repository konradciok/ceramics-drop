import { NextResponse } from 'next/server';
import { saveDraft } from '@/lib/admin/content';
import { actorEmail, contentError, draftBodySchema, parseJson } from '@/lib/admin/content-routes';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const parsed = await parseJson(req, draftBodySchema);
  if (!parsed.ok) return parsed.res;
  try {
    const version = await saveDraft({ ...parsed.data, actorEmail: actorEmail(req) });
    return NextResponse.json({ version });
  } catch (err) {
    return contentError(err);
  }
}
