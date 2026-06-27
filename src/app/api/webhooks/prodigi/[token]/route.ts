import { NextResponse } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { handleProdigiCallback } from '@/server/prodigi/callbacks';

export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  { params }: { params: { token: string } },
) {
  const { env } = getCloudflareContext();

  if (params.token !== env.PRODIGI_CALLBACK_TOKEN) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const result = await handleProdigiCallback(body, env);
  return NextResponse.json({ message: result.message }, { status: result.status });
}
