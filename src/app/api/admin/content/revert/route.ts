import { NextResponse } from 'next/server';
import { revertVersion } from '@/lib/admin/content';
import { actorEmail, contentError, parseJson, versionBodySchema } from '@/lib/admin/content-routes';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const parsed = await parseJson(req, versionBodySchema);
  if (!parsed.ok) return parsed.res;
  try {
    const version = await revertVersion({ ...parsed.data, actorEmail: actorEmail(req) });
    return NextResponse.json({ version });
  } catch (err) {
    return contentError(err);
  }
}
