import { NextResponse } from 'next/server';
import { listContentSummaries } from '@/lib/admin/content';
import { contentError } from '@/lib/admin/content-routes';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const status = new URL(req.url).searchParams.get('status') ?? undefined;
    const documents = await listContentSummaries(status);
    return NextResponse.json({ documents });
  } catch (err) {
    return contentError(err);
  }
}
