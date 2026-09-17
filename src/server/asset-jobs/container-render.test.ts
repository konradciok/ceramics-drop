import { describe, it, expect, vi } from 'vitest';
import {
  RESULT_HEADER,
  SPEC_HEADER,
  decodeDerivativeSpec,
  encodeResultHeaders,
  MAX_SOURCE_BYTES,
  MAX_SOURCE_PIXELS,
} from './container-protocol';
import { buildDerivativeSpec, renderAndStoreDerivative, type ContainerRequestInit, type RenderInput } from './container-render';

const SHA = 'b'.repeat(64);

const INPUT: RenderInput = {
  jobId: '22222222-2222-2222-2222-222222222222',
  uploadId: '11111111-1111-1111-1111-111111111111',
  productId: 'print-001',
  revision: 'cms-11111111-1111-1111-1111-111111111111',
  sourceKey: 'uploads/11111111-1111-1111-1111-111111111111.jpg',
  sourceContentType: 'image/jpeg',
  expectedRatio: '3x4',
  target: { w: 3600, h: 4800 },
  format: 'jpg',
};

function sourceObject() {
  return { key: INPUT.sourceKey, size: 10, httpEtag: '"e"', body: new ReadableStream() } as unknown as R2ObjectBody;
}

function okResponse(overrides: Record<string, string> = {}) {
  const headers = { ...encodeResultHeaders({ sha256: SHA, byteSize: 4242, width: 3600, height: 4800, format: 'jpg' }), ...overrides };
  return new Response('derivative-bytes', { status: 200, headers });
}

function makeDeps(opts: {
  get?: () => Promise<R2ObjectBody | null>;
  put?: (key: string, value: unknown, options?: unknown) => Promise<unknown>;
  fetch?: (url: string, init: ContainerRequestInit) => Promise<Response>;
}) {
  const put = vi.fn(opts.put ?? (async () => ({})));
  const get = vi.fn(opts.get ?? (async () => sourceObject()));
  const containerFetch = vi.fn(opts.fetch ?? (async () => okResponse()));
  return {
    deps: { bucket: { get, put } as unknown as Pick<R2Bucket, 'get' | 'put'>, containerFetch },
    get,
    put,
    containerFetch,
  };
}

describe('buildDerivativeSpec', () => {
  it('carries the master plan limits (100 MiB / 160 MP) into every request', () => {
    const spec = buildDerivativeSpec(INPUT);
    expect(spec.maxSourceBytes).toBe(MAX_SOURCE_BYTES);
    expect(spec.maxSourcePixels).toBe(MAX_SOURCE_PIXELS);
    expect(MAX_SOURCE_BYTES).toBe(100 * 1024 * 1024);
    expect(MAX_SOURCE_PIXELS).toBe(160_000_000);
  });
});

describe('renderAndStoreDerivative', () => {
  it('streams R2 → container → R2 and returns a staged row under the content-addressed key', async () => {
    const { deps, put, containerFetch } = makeDeps({});
    const result = await renderAndStoreDerivative(deps, INPUT);

    expect(result).toEqual({
      kind: 'ok',
      asset: {
        product_id: 'print-001',
        revision: INPUT.revision,
        profile_key: '3600x4800',
        r2_key: `prints/print-001/${INPUT.revision}/3600x4800-${SHA}.jpg`,
        sha256: SHA,
        content_type: 'image/jpeg',
        width_px: 3600,
        height_px: 4800,
        byte_size: 4242,
        status: 'staged',
      },
    });

    // The key embeds the sha the container reported — proving the Worker read
    // the response HEADERS before touching the body (the whole reason the
    // metadata travels in headers rather than a JSON envelope).
    const [key, , options] = put.mock.calls[0];
    expect(key).toBe(`prints/print-001/${INPUT.revision}/3600x4800-${SHA}.jpg`);
    expect(options).toEqual({ httpMetadata: { contentType: 'image/jpeg' } });

    const [url, init] = containerFetch.mock.calls[0];
    expect(url).toMatch(/\/v1\/derivative$/);
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('image/jpeg');
    expect(decodeDerivativeSpec(init.headers[SPEC_HEADER])).toMatchObject({
      jobId: INPUT.jobId,
      uploadId: INPUT.uploadId,
      expectedRatio: '3x4',
      target: { w: 3600, h: 4800 },
      format: 'jpg',
    });
  });

  it('never buffers the source: the R2 body stream is handed straight to the container request', async () => {
    const body = new ReadableStream();
    const { deps, containerFetch } = makeDeps({
      get: async () => ({ key: INPUT.sourceKey, size: 10, httpEtag: '"e"', body }) as unknown as R2ObjectBody,
    });
    await renderAndStoreDerivative(deps, INPUT);
    expect(containerFetch.mock.calls[0][1].body).toBe(body);
  });

  it('missing source object is permanent (the upload was deleted — a retry cannot help)', async () => {
    const { deps, containerFetch } = makeDeps({ get: async () => null });
    const result = await renderAndStoreDerivative(deps, INPUT);
    expect(result).toEqual({ kind: 'permanent', code: 'SOURCE_MISSING', message: expect.stringContaining(INPUT.sourceKey) });
    expect(containerFetch).not.toHaveBeenCalled();
  });

  it('an R2 get fault is retryable', async () => {
    const { deps } = makeDeps({
      get: async () => {
        throw new Error('R2 down');
      },
    });
    expect(await renderAndStoreDerivative(deps, INPUT)).toMatchObject({ kind: 'retryable', code: 'R2_GET_FAILED' });
  });

  it('an unreachable container is retryable', async () => {
    const { deps } = makeDeps({
      fetch: async () => {
        throw new Error('connection refused');
      },
    });
    expect(await renderAndStoreDerivative(deps, INPUT)).toMatchObject({ kind: 'retryable', code: 'CONTAINER_UNREACHABLE' });
  });

  it('a 422 from the container is permanent and carries its code/message through', async () => {
    const { deps, put } = makeDeps({
      fetch: async () => new Response(JSON.stringify({ code: 'WOULD_UPSCALE', message: 'too small' }), { status: 422 }),
    });
    expect(await renderAndStoreDerivative(deps, INPUT)).toEqual({
      kind: 'permanent',
      code: 'WOULD_UPSCALE',
      message: 'too small',
    });
    expect(put).not.toHaveBeenCalled();
  });

  it('a 500 from the container is retryable', async () => {
    const { deps } = makeDeps({
      fetch: async () => new Response(JSON.stringify({ code: 'RENDER_FAILED', message: 'sharp blew up' }), { status: 500 }),
    });
    expect(await renderAndStoreDerivative(deps, INPUT)).toMatchObject({ kind: 'retryable', code: 'RENDER_FAILED' });
  });

  it('a 429 from the container is retryable (capacity, not input)', async () => {
    const { deps } = makeDeps({ fetch: async () => new Response('busy', { status: 429 }) });
    expect(await renderAndStoreDerivative(deps, INPUT)).toMatchObject({ kind: 'retryable' });
  });

  it('a 200 with unreadable metadata is permanent, not an infinite retry', async () => {
    const { deps, put } = makeDeps({ fetch: async () => okResponse({ [RESULT_HEADER.sha256]: 'nope' }) });
    expect(await renderAndStoreDerivative(deps, INPUT)).toMatchObject({ kind: 'permanent', code: 'CONTAINER_BAD_RESPONSE' });
    expect(put).not.toHaveBeenCalled();
  });

  it('refuses to store a derivative whose dimensions do not match the requested target', async () => {
    const { deps, put } = makeDeps({
      fetch: async () => okResponse({ [RESULT_HEADER.width]: '3000' }),
    });
    expect(await renderAndStoreDerivative(deps, INPUT)).toMatchObject({
      kind: 'permanent',
      code: 'CONTAINER_BAD_RESPONSE',
      message: expect.stringContaining('3000x4800'),
    });
    expect(put).not.toHaveBeenCalled();
  });

  it('an R2 put fault is retryable', async () => {
    const { deps } = makeDeps({
      put: async () => {
        throw new Error('put failed');
      },
    });
    expect(await renderAndStoreDerivative(deps, INPUT)).toMatchObject({ kind: 'retryable', code: 'R2_PUT_FAILED' });
  });

  it('a png source produces a png derivative under a .png key with image/png', async () => {
    const { deps, put } = makeDeps({
      fetch: async () =>
        new Response('bytes', {
          status: 200,
          headers: encodeResultHeaders({ sha256: SHA, byteSize: 9, width: 3600, height: 4800, format: 'png' }),
        }),
    });
    const result = await renderAndStoreDerivative(deps, { ...INPUT, sourceContentType: 'image/png', format: 'png' });
    expect(result).toMatchObject({ kind: 'ok', asset: { content_type: 'image/png' } });
    expect(put.mock.calls[0][0]).toMatch(/\.png$/);
  });
});
