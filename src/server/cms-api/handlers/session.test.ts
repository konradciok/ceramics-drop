import { describe, expect, it } from 'vitest';
import { sessionRoute } from './session';
import type { HandlerContext } from '../router';

const ctx: HandlerContext = { actorEmail: 'anna@anna-ciok.studio', requestId: 'req_test', supabase: {} as never };

describe('sessionRoute', () => {
  it('reports the actor email from the verified access context', async () => {
    const res = await sessionRoute.handler(new Request('https://x.test/v1/session'), {} as CloudflareEnv, {}, ctx);
    const body = await res.json();
    expect(body.email).toBe('anna@anna-ciok.studio');
    expect(body.writesEnabled).toBe(true);
    expect(body.contractVersion).toBe('1.0.0');
  });

  it('reports environment=integration when CMS_API_ENVIRONMENT=integration', async () => {
    const res = await sessionRoute.handler(
      new Request('https://x.test/v1/session'),
      { CMS_API_ENVIRONMENT: 'integration' } as CloudflareEnv,
      {},
      ctx,
    );
    expect((await res.json()).environment).toBe('integration');
  });

  it('defaults environment to production when unset', async () => {
    const res = await sessionRoute.handler(new Request('https://x.test/v1/session'), {} as CloudflareEnv, {}, ctx);
    expect((await res.json()).environment).toBe('production');
  });
});
