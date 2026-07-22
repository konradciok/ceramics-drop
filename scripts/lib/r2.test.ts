import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifyR2GetFailure,
  resolveBucketName,
  r2PutIfAbsent,
  resolveR2ConditionalCredentials,
} from './r2';

describe('classifyR2GetFailure', () => {
  it('treats R2 NoSuchKey / not-found messages as a definitively absent object', () => {
    expect(classifyR2GetFailure('The specified key does not exist.')).toBe('absent');
    expect(classifyR2GetFailure('Object not found')).toBe('absent');
    expect(classifyR2GetFailure('NoSuchKey: the object was not found')).toBe('absent');
    expect(classifyR2GetFailure('HTTP 404')).toBe('absent');
    expect(classifyR2GetFailure('R2 error 10007')).toBe('absent');
  });

  it('treats auth / network / throttling faults as errors (upload must fail closed, not put)', () => {
    expect(classifyR2GetFailure('Authentication error [code: 10000]')).toBe('error');
    expect(classifyR2GetFailure('fetch failed: ECONNRESET')).toBe('error');
    expect(classifyR2GetFailure('You need to login first')).toBe('error');
    expect(classifyR2GetFailure('exit null')).toBe('error');
  });
});

describe('resolveBucketName', () => {
  it('defaults to the wrangler.jsonc binding bucket name', () => {
    expect(resolveBucketName({})).toBe('anna-ciok-print-assets');
  });

  it('honours a PRINT_ASSETS_BUCKET override from the merged env stack (e.g. .dev.vars)', () => {
    expect(resolveBucketName({ PRINT_ASSETS_BUCKET: 'anna-ciok-print-assets-staging' })).toBe(
      'anna-ciok-print-assets-staging',
    );
  });
});

// ── Conditional (If-None-Match: *) fulfilment PUT ─────────────────────────────

/** Scratch files created for the streamed-body tests; removed in afterAll. */
const scratchFiles: string[] = [];
function tmpFile(bytes: string | Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-cond-'));
  const file = path.join(dir, 'derivative.bin');
  fs.writeFileSync(file, bytes);
  scratchFiles.push(dir);
  return file;
}

afterAll(() => {
  for (const dir of scratchFiles) fs.rmSync(dir, { recursive: true, force: true });
});

describe('r2PutIfAbsent', () => {
  let filePath: string;
  beforeAll(() => {
    filePath = tmpFile(Buffer.from('derivative-bytes'));
  });

  const input = (over: Record<string, unknown> = {}) => ({
    accountId: 'acct',
    accessKeyId: 'AK',
    secretAccessKey: 'SK',
    bucket: 'anna-ciok-print-assets',
    key: 'prints/fap01/rev1/3600x4800-aaaa.jpg',
    filePath,
    contentType: 'image/jpeg',
    sha256: 'a'.repeat(64),
    ...over,
  });

  it('maps 2xx→created, 412→exists, other→throw, and sends the conditional headers', async () => {
    const fakeClient = { fetch: vi.fn() };
    fakeClient.fetch.mockResolvedValueOnce(new Response('', { status: 200 }));
    const resultFor200 = await r2PutIfAbsent(input(), fakeClient);

    fakeClient.fetch.mockResolvedValueOnce(new Response('', { status: 412 }));
    const resultFor412 = await r2PutIfAbsent(input(), fakeClient);

    fakeClient.fetch.mockResolvedValueOnce(new Response('server exploded', { status: 500 }));
    const resultFor500 = r2PutIfAbsent(input(), fakeClient);

    expect(resultFor200).toBe('created');
    expect(resultFor412).toBe('exists');
    await expect(resultFor500).rejects.toThrow(/R2 conditional PUT failed.*500/);

    const [, init] = vi.mocked(fakeClient.fetch).mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(headers.get('if-none-match')).toBe('*');
    expect(headers.get('x-amz-content-sha256')).toBe('a'.repeat(64));
    expect(headers.get('content-type')).toBe('image/jpeg');
  });

  it('constructs and signs a streamed request through the real AwsClient (Node 22 boundary)', async () => {
    const bytes = Buffer.from('real-aws-client-streamed-body-payload');
    const streamedFile = tmpFile(bytes);
    let captured: Request | undefined;
    const fetchMock = vi.fn(async (request: Request) => {
      captured = request;
      return new Response('', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await r2PutIfAbsent({
        accountId: 'acct123',
        accessKeyId: 'AKIAEXAMPLE',
        secretAccessKey: 'secretExampleValue',
        bucket: 'anna-ciok-print-assets',
        key: `prints/fap01/rev1/3600x4800-${'a'.repeat(64)}.jpg`,
        filePath: streamedFile,
        contentType: 'image/jpeg',
        sha256: 'b'.repeat(64),
      });

      expect(result).toBe('created');
      expect(fetchMock).toHaveBeenCalledOnce();
      const request = captured!;
      expect(request).toBeInstanceOf(Request);
      // The file stream survived Readable.toWeb → AwsClient duplex Request → fetch intact.
      const body = Buffer.from(await request.arrayBuffer());
      expect(body.equals(bytes)).toBe(true);
      // A real SigV4 Authorization header proves Node 22 signed the streamed request.
      expect(request.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\//);
      expect(request.headers.get('if-none-match')).toBe('*');
      expect(request.headers.get('x-amz-content-sha256')).toBe('b'.repeat(64));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('targets the account R2 S3 endpoint with a URL-encoded bucket/key path', async () => {
    const fakeClient = { fetch: vi.fn().mockResolvedValue(new Response('', { status: 200 })) };
    await r2PutIfAbsent(input({ accountId: 'acct123', bucket: 'my-bucket', key: 'prints/f p/rev1/obj.jpg' }), fakeClient);
    const [url] = vi.mocked(fakeClient.fetch).mock.calls[0]!;
    expect(url).toBe('https://acct123.r2.cloudflarestorage.com/my-bucket/prints/f%20p/rev1/obj.jpg');
  });
});

describe('resolveR2ConditionalCredentials', () => {
  const full = {
    R2_S3_ACCOUNT_ID: 'acct',
    R2_S3_ACCESS_KEY_ID: 'AK',
    R2_S3_SECRET_ACCESS_KEY: 'SK',
  };

  it('returns trimmed, non-empty credentials from the merged env stack', () => {
    expect(
      resolveR2ConditionalCredentials({
        R2_S3_ACCOUNT_ID: '  acct  ',
        R2_S3_ACCESS_KEY_ID: 'AK\n',
        R2_S3_SECRET_ACCESS_KEY: ' SK ',
        UNRELATED: 'x',
      }),
    ).toEqual({ accountId: 'acct', accessKeyId: 'AK', secretAccessKey: 'SK' });
  });

  it.each(['R2_S3_ACCOUNT_ID', 'R2_S3_ACCESS_KEY_ID', 'R2_S3_SECRET_ACCESS_KEY'])(
    'rejects a missing %s, naming only that variable',
    (missingKey) => {
      const env: Record<string, string | undefined> = { ...full, [missingKey]: undefined };
      expect(() => resolveR2ConditionalCredentials(env)).toThrow(new RegExp(missingKey));
    },
  );

  it('rejects a blank (whitespace-only) value', () => {
    expect(() => resolveR2ConditionalCredentials({ ...full, R2_S3_ACCESS_KEY_ID: '   ' })).toThrow(
      /R2_S3_ACCESS_KEY_ID/,
    );
  });

  it('names only the missing variable and never leaks present credential values', () => {
    const env = {
      R2_S3_ACCOUNT_ID: 'acct-1234-secret',
      R2_S3_ACCESS_KEY_ID: 'AKIA-secret-id',
      R2_S3_SECRET_ACCESS_KEY: '   ',
    };
    let message = '';
    try {
      resolveR2ConditionalCredentials(env);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/R2_S3_SECRET_ACCESS_KEY/);
    expect(message).not.toMatch(/acct-1234-secret|AKIA-secret-id/);
  });
});
