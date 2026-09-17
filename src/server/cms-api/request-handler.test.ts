import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { SignJWT, generateKeyPair, exportJWK } from 'jose';
import { handleCmsApiRequest } from './request-handler';

const TEAM_DOMAIN = 'https://anna-ciok-test.cloudflareaccess.com';
const AUD = 'cms-test-audience';
const OWNER_EMAIL = 'anna@anna-ciok.studio';

let privateKey: CryptoKey;
let publicJwk: Record<string, unknown>;

beforeAll(async () => {
  const { publicKey, privateKey: priv } = await generateKeyPair('RS256');
  privateKey = priv;
  publicJwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes('/cdn-cgi/access/certs')) {
        return new Response(JSON.stringify({ keys: [publicJwk] }), { headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    }),
  );
});

afterAll(() => {
  vi.unstubAllGlobals();
});

async function signToken(claims: Record<string, unknown>, expSecondsFromNow = 600): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + expSecondsFromNow)
    .sign(privateKey);
}

const baseEnv = {
  CMS_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  CMS_ACCESS_AUD: AUD,
  CMS_OWNERS: OWNER_EMAIL,
} as unknown as CloudflareEnv;

const deps = { makeSupabase: () => ({}) as never };

function reqWithToken(path: string, token?: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (token) headers.set('Cf-Access-Jwt-Assertion', token);
  return new Request(`https://internal.test${path}`, { ...init, headers });
}

describe('handleCmsApiRequest — real Access JWT verification (brief §8 negative scenarios)', () => {
  it('401s a request with no token at all', async () => {
    const res = await handleCmsApiRequest(reqWithToken('/v1/session'), baseEnv, deps);
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('UNAUTHORIZED');
  });

  it('401s an expired token', async () => {
    const token = await signToken({ email: OWNER_EMAIL, aud: AUD, iss: TEAM_DOMAIN }, -600);
    const res = await handleCmsApiRequest(reqWithToken('/v1/session', token), baseEnv, deps);
    expect(res.status).toBe(401);
  });

  it('401s a validly-signed token with no exp claim (requiredClaims enforces expiry is present, not just unexpired)', async () => {
    const token = await new SignJWT({ email: OWNER_EMAIL, aud: AUD, iss: TEAM_DOMAIN })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuedAt()
      .sign(privateKey);
    const res = await handleCmsApiRequest(reqWithToken('/v1/session', token), baseEnv, deps);
    expect(res.status).toBe(401);
  });

  it('401s a token forged with the wrong signing key', async () => {
    const { privateKey: otherKey } = await generateKeyPair('RS256');
    const token = await new SignJWT({ email: OWNER_EMAIL, aud: AUD, iss: TEAM_DOMAIN })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(otherKey);
    const res = await handleCmsApiRequest(reqWithToken('/v1/session', token), baseEnv, deps);
    expect(res.status).toBe(401);
  });

  it('403s a genuinely valid token issued for the wrong audience (e.g. the storefront admin app)', async () => {
    const token = await signToken({ email: OWNER_EMAIL, aud: 'some-other-app-audience', iss: TEAM_DOMAIN });
    const res = await handleCmsApiRequest(reqWithToken('/v1/session', token), baseEnv, deps);
    expect(res.status).toBe(403);
  });

  // Note: this signs with the SAME trusted test key and only varies the
  // `iss` claim string — it is not a real "wrong team" token. A genuine
  // wrong-team Access token would be signed by that other team's own key
  // (getJwks() always fetches from the configured CMS_ACCESS_TEAM_DOMAIN,
  // never from the token's own `iss`), so it would fail signature
  // verification and get 401 — see 'wrong signing key' above. This test
  // exercises the narrower, defense-in-depth case: a same-key token whose
  // `iss` claim is mismatched.
  it('403s a genuinely valid, correctly-signed token whose iss claim does not match the configured team domain', async () => {
    const token = await signToken({ email: OWNER_EMAIL, aud: AUD, iss: 'https://someone-elses-team.cloudflareaccess.com' });
    const res = await handleCmsApiRequest(reqWithToken('/v1/session', token), baseEnv, deps);
    expect(res.status).toBe(403);
  });

  it('403s a valid, correctly-audienced token whose email is not in CMS_OWNERS', async () => {
    const token = await signToken({ email: 'stranger@example.com', aud: AUD, iss: TEAM_DOMAIN });
    const res = await handleCmsApiRequest(reqWithToken('/v1/session', token), baseEnv, deps);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('FORBIDDEN');
  });

  it('lets a valid owner token through end-to-end (real crypto verify -> router -> handler)', async () => {
    const token = await signToken({ email: OWNER_EMAIL, aud: AUD, iss: TEAM_DOMAIN });
    const res = await handleCmsApiRequest(reqWithToken('/v1/session', token), baseEnv, deps);
    expect(res.status).toBe(200);
    expect((await res.json()).email).toBe(OWNER_EMAIL);
  });

  it('404s when CMS_ACCESS_TEAM_DOMAIN/AUD/OWNERS are unset — fails closed, leaks no surface', async () => {
    const res = await handleCmsApiRequest(reqWithToken('/v1/session'), {} as CloudflareEnv, deps);
    expect(res.status).toBe(404);
  });

  it('404s an unregistered path even carrying a fully valid owner token', async () => {
    // Every contracts/cms-v1.json S1-S4 path is now registered — collections,
    // content, pricing, shipping-rates (Task 7), uploads/assets (Task 9), and
    // (as of Task 10, Phase 2) jobs. There is no longer a real future
    // contract path left to point this at, so this now uses a path that is
    // not in the contract at all, purely to prove the router's own
    // NOT_IMPLEMENTED fallback still works.
    const token = await signToken({ email: OWNER_EMAIL, aud: AUD, iss: TEAM_DOMAIN });
    const res = await handleCmsApiRequest(reqWithToken('/v1/does-not-exist', token), baseEnv, deps);
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('NOT_IMPLEMENTED');
  });

  // Task 6 — the pricing handlers must never reach for adminSupabase() /
  // getCloudflareContext() (the Task 5 gap documented on the /v1/content test
  // below). This exercises the real, unmocked pricing read path
  // (pricing-list.ts -> pricing-mapping.ts's loadPricingResource) through the
  // full entrypoint with nothing but a minimal Supabase stand-in in
  // deps.makeSupabase — exactly the role it plays in production. If any
  // pricing module acquired a getCloudflareContext() dependency, this would
  // throw rather than return 200.
  it('GET /v1/pricing (real, unmocked path) succeeds via ctx.supabase without ever calling getCloudflareContext()', async () => {
    const token = await signToken({ email: OWNER_EMAIL, aud: AUD, iss: TEAM_DOMAIN });
    const rowsByTable: Record<string, unknown> = {
      print_pricing_config: { published_revision: 1 },
      pricing_config_drafts: { revision: 1, payload: { fields: [] } },
    };
    const fakeSupabase = {
      from: (table: string) => {
        if (!(table in rowsByTable)) throw new Error(`unexpected table in pricing stub: ${table}`);
        const builder = {
          select: () => builder,
          order: () => builder,
          limit: () => builder,
          maybeSingle: async () => ({ data: rowsByTable[table], error: null }),
        };
        return builder;
      },
    } as unknown as never;
    const res = await handleCmsApiRequest(reqWithToken('/v1/pricing', token), baseEnv, { makeSupabase: () => fakeSupabase });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ id: 'print-pricing', kind: 'pricing', revision: 1, publishedRevision: 1 });
  });

  // Task 7 — the same guard for the shipping-rates handlers: they must never
  // reach for adminSupabase() / getCloudflareContext() (the Task 5 gap
  // documented on the /v1/content test below). This exercises the real,
  // unmocked read path (shipping-rates-list.ts -> shipping-rates-mapping.ts's
  // loadAllShippingRateResources) through the full entrypoint with nothing but
  // a minimal Supabase stand-in in deps.makeSupabase — exactly the role it
  // plays in production. If any shipping-rates module acquired a
  // getCloudflareContext() dependency, this would throw rather than return 200.
  it('GET /v1/shipping-rates (real, unmocked path) succeeds via ctx.supabase without ever calling getCloudflareContext()', async () => {
    const token = await signToken({ email: OWNER_EMAIL, aud: AUD, iss: TEAM_DOMAIN });
    const fakeSupabase = {
      from: (table: string) => {
        if (table !== 'shipping_rates' && table !== 'shipping_rate_drafts') {
          throw new Error(`unexpected table in shipping-rates stub: ${table}`);
        }
        let rateId = '';
        const builder = {
          select: () => builder,
          eq: (_col: string, value: string) => {
            rateId = value;
            return builder;
          },
          order: () => builder,
          limit: () => builder,
          maybeSingle: async () => ({
            data:
              table === 'shipping_rates'
                ? { published_revision: 1 }
                : { revision: 1, payload: { fields: [{ key: `${rateId}_probe`, label: 'p', type: 'number', value: '1', locale: 'none', sourceLocale: 'none' }] } },
            error: null,
          }),
        };
        return builder;
      },
    } as unknown as never;
    const res = await handleCmsApiRequest(reqWithToken('/v1/shipping-rates', token), baseEnv, { makeSupabase: () => fakeSupabase });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((i: { id: string }) => i.id)).toEqual(['domestic', 'international']);
    expect(body.items[0]).toMatchObject({ kind: 'shipping-rates', revision: 1, publishedRevision: 1 });
  });

  // Task 9 — the uploads/assets handlers must never reach for adminSupabase()
  // / getCloudflareContext() either (the Task 5 gap documented on the
  // /v1/content test below). This exercises the real, unmocked read path
  // (assets-list.ts -> assets-mapping.ts's loadAssetList, including a REAL
  // signPrintAssetUrl HMAC signature — not mocked) through the full
  // entrypoint with nothing but a minimal Supabase stand-in in
  // deps.makeSupabase — exactly the role it plays in production.
  it('GET /v1/assets (real, unmocked path) succeeds via ctx.supabase without ever calling getCloudflareContext()', async () => {
    const token = await signToken({ email: OWNER_EMAIL, aud: AUD, iss: TEAM_DOMAIN });
    const fakeSupabase = {
      from: (table: string) => {
        if (table === 'print_fulfilment_assets') {
          return {
            select: () => ({
              in: () => ({
                order: async () => ({
                  data: [
                    { id: 'a1', product_id: 'fap01', revision: '2026-07-11-r1', profile_key: null, status: 'ready', width_px: 3600, height_px: 4800 },
                  ],
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'print_variant_asset_assignments') {
          return { select: async () => ({ data: [], error: null }) };
        }
        throw new Error(`unexpected table in assets stub: ${table}`);
      },
    } as unknown as never;
    const envWithSecret = { ...baseEnv, PRINT_ASSET_TOKEN_SECRET: 'test-secret' } as CloudflareEnv;
    const res = await handleCmsApiRequest(reqWithToken('/v1/assets', token), envWithSecret, { makeSupabase: () => fakeSupabase });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ id: 'a1', status: 'ready', ratio: '3:4' });
    expect(body.items[0].url).toMatch(/^https:\/\/anna-ciok\.studio\/api\/print-assets\/a1\?exp=\d+&sig=[0-9a-f]{64}$/);
  });

  // Task 9 — same guard for POST /v1/uploads: the real, unmocked write path
  // (uploads-create.ts -> uploads-mapping.ts's insertUploadRow/presignUploadPutUrl,
  // including a real aws4fetch SigV4 signature — not mocked) through the full
  // entrypoint. Also proves the idempotency claim goes through ctx.supabase.
  it('POST /v1/uploads (real, unmocked path) succeeds via ctx.supabase without ever calling getCloudflareContext()', async () => {
    const token = await signToken({ email: OWNER_EMAIL, aud: AUD, iss: TEAM_DOMAIN });
    let insertedRow: Record<string, unknown> | undefined;
    const fakeSupabase = {
      from: (table: string) => {
        if (table === 'cms_api_idempotency_keys') {
          const chain = { eq: () => chain, select: () => ({ maybeSingle: async () => ({ data: { id: 'lease_1' }, error: null }) }) };
          return {
            insert: () => ({ select: () => ({ maybeSingle: async () => ({ data: { id: 'lease_1' }, error: null }) }) }),
            update: () => chain,
          };
        }
        // Task 12: loadActivePrintVariants (profiles.ts) reads these two
        // tables to validate the request body's productId before the handler
        // ever reaches print_asset_uploads — same real, unmocked-logic path
        // this test exists to exercise, so stub them with a real active
        // print product rather than mocking the check itself away.
        if (table === 'products') {
          return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { status: 'active' }, error: null }) }) }) };
        }
        if (table === 'product_variants') {
          const chain = {
            eq: () => chain,
            then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
              Promise.resolve({
                data: [{ variant_key: '30x40:false:false:black', print_area_width_px: 3600, print_area_height_px: 4800 }],
                error: null,
              }).then(resolve, reject),
          };
          return { select: () => chain };
        }
        if (table === 'print_asset_uploads') {
          return {
            insert: (payload: Record<string, unknown>) => ({
              select: () => ({
                single: async () => {
                  insertedRow = payload;
                  return {
                    data: {
                      id: payload.id,
                      filename: payload.filename,
                      content_type: payload.content_type,
                      declared_byte_size: payload.declared_byte_size,
                      ratio: payload.ratio,
                      product_id: payload.product_id,
                      r2_key: payload.r2_key,
                      status: 'pending',
                      revision: 0,
                      confirmed_byte_size: null,
                      confirmed_content_type: null,
                      created_by: payload.created_by,
                      created_at: '2026-09-17T12:00:00.000Z',
                      expires_at: payload.expires_at,
                      updated_at: '2026-09-17T12:00:00.000Z',
                    },
                    error: null,
                  };
                },
              }),
            }),
          };
        }
        throw new Error(`unexpected table in uploads stub: ${table}`);
      },
    } as unknown as never;
    const envWithCreds = {
      ...baseEnv,
      R2_S3_ACCOUNT_ID: 'acct123',
      R2_S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
      R2_S3_SECRET_ACCESS_KEY: 'secretExampleValue',
    } as CloudflareEnv;
    const res = await handleCmsApiRequest(
      reqWithToken('/v1/uploads', token, {
        method: 'POST',
        headers: { 'Idempotency-Key': 'up-key-1' },
        body: JSON.stringify({ filename: 'kubek-01.jpg', contentType: 'image/jpeg', bytes: 1000, ratio: '4:5', productId: 'print-01' }),
      }),
      envWithCreds,
      { makeSupabase: () => fakeSupabase },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.assetId).toBe(body.id);
    expect(body.uploadUrl).toMatch(/^https:\/\/acct123\.r2\.cloudflarestorage\.com\/anna-ciok-print-assets\/uploads\/[0-9a-f-]+\.jpg\?/);
    expect(body.uploadUrl).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256');
    expect(body.uploadUrl).toMatch(/X-Amz-Signature=[0-9a-f]{64}/);
    expect(insertedRow?.created_by).toBe(OWNER_EMAIL);
    expect(insertedRow?.product_id).toBe('print-01');
  });

  it('422s POST /v1/products with a valid owner token but no Idempotency-Key', async () => {
    const token = await signToken({ email: OWNER_EMAIL, aud: AUD, iss: TEAM_DOMAIN });
    const res = await handleCmsApiRequest(
      reqWithToken('/v1/products', token, { method: 'POST', body: JSON.stringify({}) }),
      baseEnv,
      deps,
    );
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('IDEMPOTENCY_REQUIRED');
  });

  // Regression test for the CmsApi/content.ts getCloudflareContext() gap:
  // CmsApi is a WorkerEntrypoint invoked over a Cloudflare service binding
  // (see cms-ceramics/wrangler.jsonc's STORE binding), never wrapped by
  // @opennextjs/cloudflare's `runWithCloudflareRequestContext` the way the
  // default Next.js `fetch` export is. content.ts's `adminSupabase()`
  // (used as content.ts's fallback client) calls `getCloudflareContext()`,
  // which throws outside that wrapper. Before content.ts's five I/O
  // functions (getRawDocument/listContentSummaries/getContentEditorState/
  // ensureDocument/nextVersion, and the public saveDraft/publishVersion/
  // revertVersion) accepted an injectable client that content-mapping.ts's
  // wrappers thread through from `ctx.supabase`, this exact request threw
  // that getCloudflareContext error (there is no Cloudflare request
  // context anywhere in this Vitest process — the real production failure
  // mode). This test exercises the real, unmocked call chain
  // (content-list.ts -> content-mapping.ts's loadAllContentResources ->
  // content.ts's getContentEditorState -> getRawDocument) — nothing here
  // is mocked with vi.mock; only the Supabase client itself is a minimal
  // stand-in, the same role `deps.makeSupabase(env)` plays in production.
  it('GET /v1/content (real, unmocked content.ts path) succeeds via ctx.supabase without ever calling getCloudflareContext()', async () => {
    const token = await signToken({ email: OWNER_EMAIL, aud: AUD, iss: TEAM_DOMAIN });
    // `cms_documents` reports "no document saved yet" for every slug (a
    // legitimate real-world state — a brand-new document); content.ts
    // falls back to its own default per-locale payload with no further
    // Supabase calls, so this minimal stub is sufficient for the whole
    // read path to complete.
    const fakeSupabase = {
      from: (table: string) => {
        if (table !== 'cms_documents') throw new Error(`unexpected table in repro stub: ${table}`);
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: null, error: null }),
              }),
            }),
          }),
        };
      },
    } as unknown as never;
    const res = await handleCmsApiRequest(reqWithToken('/v1/content', token), baseEnv, { makeSupabase: () => fakeSupabase });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
    // EDITABLE_DOCUMENTS.length (12) x CMS_LOCALES.length (4) — see
    // content-mapping.ts's loadAllContentResources.
    expect(body.items.length).toBe(48);
  });

  // Task 10 (Priority 8 / Phase 2) — the jobs handlers must never reach for
  // adminSupabase() / getCloudflareContext() either (the Task 5 gap documented
  // on the /v1/content test above). This exercises the real, unmocked read
  // path (jobs-list.ts -> jobs-mapping.ts's listJobRows/mapJobRowToResponse)
  // through the full entrypoint with nothing but a minimal Supabase stand-in
  // in deps.makeSupabase — exactly the role it plays in production.
  it('GET /v1/jobs (real, unmocked path) succeeds via ctx.supabase without ever calling getCloudflareContext()', async () => {
    const token = await signToken({ email: OWNER_EMAIL, aud: AUD, iss: TEAM_DOMAIN });
    const jobRow = {
      id: 'job-1',
      upload_id: 'upload-1',
      asset_id: null,
      asset_revision: 1,
      status: 'queued',
      attempts: 0,
      idempotency_key: 'print-asset-job:upload-1:v1',
      last_error: null,
      created_at: '2026-09-17T12:00:00.000Z',
      updated_at: '2026-09-17T12:00:00.000Z',
    };
    const fakeSupabase = {
      from: (table: string) => {
        if (table !== 'print_asset_jobs') throw new Error(`unexpected table in jobs-list stub: ${table}`);
        return { select: () => ({ order: async () => ({ data: [jobRow], error: null }) }) };
      },
    } as unknown as never;
    const res = await handleCmsApiRequest(reqWithToken('/v1/jobs', token), baseEnv, { makeSupabase: () => fakeSupabase });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([{ id: 'job-1', assetId: 'upload-1', revision: 1, status: 'queued', progress: 0, error: '' }]);
  });

  // Task 10 — same guard for the WRITE path, POST /v1/jobs: the real,
  // unmocked chain (jobs-create.ts -> uploads-mapping.ts's getUploadRowById ->
  // asset-jobs/enqueue.ts's enqueueAssetJob, including a real
  // env.ASSET_JOBS_QUEUE.send() call — not mocked) through the full
  // entrypoint. Also proves the idempotency claim goes through ctx.supabase,
  // and that the ASSET_JOBS_QUEUE binding is read straight off `env` (not
  // resolved via getCloudflareContext()).
  it('POST /v1/jobs (real, unmocked path) succeeds via ctx.supabase without ever calling getCloudflareContext()', async () => {
    const token = await signToken({ email: OWNER_EMAIL, aud: AUD, iss: TEAM_DOMAIN });
    const uploadRow = {
      id: 'upload-1',
      filename: 'kubek-01.jpg',
      content_type: 'image/jpeg',
      declared_byte_size: 1000,
      ratio: '4:5',
      r2_key: 'uploads/upload-1.jpg',
      status: 'confirmed',
      revision: 1,
      confirmed_byte_size: 1000,
      confirmed_content_type: 'image/jpeg',
      created_by: OWNER_EMAIL,
      created_at: '2026-09-17T12:00:00.000Z',
      expires_at: '2026-09-17T12:15:00.000Z',
      updated_at: '2026-09-17T12:05:00.000Z',
    };
    let insertedJob: Record<string, unknown> | undefined;
    const fakeSupabase = {
      from: (table: string) => {
        if (table === 'cms_api_idempotency_keys') {
          const chain = { eq: () => chain, select: () => ({ maybeSingle: async () => ({ data: { id: 'lease_1' }, error: null }) }) };
          return {
            insert: () => ({ select: () => ({ maybeSingle: async () => ({ data: { id: 'lease_1' }, error: null }) }) }),
            update: () => chain,
          };
        }
        if (table === 'print_asset_uploads') {
          return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: uploadRow, error: null }) }) }) };
        }
        if (table === 'print_asset_jobs') {
          return {
            upsert: (payload: Record<string, unknown>) => ({
              select: () => ({
                maybeSingle: async () => {
                  insertedJob = payload;
                  return {
                    data: { ...payload, asset_id: null, attempts: 0, last_error: null, created_at: '2026-09-17T12:10:00.000Z', updated_at: '2026-09-17T12:10:00.000Z' },
                    error: null,
                  };
                },
              }),
            }),
          };
        }
        throw new Error(`unexpected table in jobs-create stub: ${table}`);
      },
    } as unknown as never;
    const queueSend = vi.fn().mockResolvedValue(undefined);
    const envWithQueue = { ...baseEnv, ASSET_JOBS_QUEUE: { send: queueSend } } as unknown as CloudflareEnv;
    const res = await handleCmsApiRequest(
      reqWithToken('/v1/jobs', token, {
        method: 'POST',
        headers: { 'Idempotency-Key': 'job-key-1' },
        body: JSON.stringify({ assetId: 'upload-1', expectedRevision: 1 }),
      }),
      envWithQueue,
      { makeSupabase: () => fakeSupabase },
    );
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({ assetId: 'upload-1', revision: 1, status: 'queued', progress: 0, error: '' });
    expect(insertedJob?.upload_id).toBe('upload-1');
    expect(queueSend).toHaveBeenCalledWith({ jobId: body.id, uploadId: 'upload-1' });
  });
});
