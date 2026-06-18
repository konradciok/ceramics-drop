/* LOCAL-ONLY admin route helpers. Shared body-parsing + uuid guard so the
 * POST action routes (refund / release-reservation / resend-confirmation) don't
 * each repeat the same preamble. */
import { NextResponse } from 'next/server';
import { isUuid } from './data';

type ParseResult = { ok: true; orderId: string } | { ok: false; res: NextResponse };

/** Read `{ orderId }` from a JSON body and validate it is a uuid. */
export async function parseOrderIdBody(req: Request): Promise<ParseResult> {
  let orderId: string | undefined;
  try {
    ({ orderId } = (await req.json()) as { orderId?: string });
  } catch {
    return { ok: false, res: NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) };
  }
  if (!isUuid(orderId)) {
    return { ok: false, res: NextResponse.json({ error: 'Valid orderId required' }, { status: 400 }) };
  }
  return { ok: true, orderId };
}
