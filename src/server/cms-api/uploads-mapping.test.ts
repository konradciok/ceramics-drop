import { describe, expect, it, vi } from 'vitest';
import {
  UPLOAD_PRESIGN_TTL_SECS,
  buildUploadR2Key,
  confirmUploadRow,
  getUploadRowById,
  insertUploadRow,
  mapConfirmedUploadToAsset,
  mapUploadRowToIntent,
  presignUploadPutUrl,
  resolveR2PresignCredentials,
  type UploadRow,
} from './uploads-mapping';

describe('buildUploadR2Key', () => {
  it('builds an id-addressed key with a .jpg extension for image/jpeg', () => {
    expect(buildUploadR2Key('abc-123', 'image/jpeg')).toBe('uploads/abc-123.jpg');
  });

  it('builds a .png extension for image/png', () => {
    expect(buildUploadR2Key('abc-123', 'image/png')).toBe('uploads/abc-123.png');
  });
});

describe('resolveR2PresignCredentials', () => {
  const full = {
    R2_S3_ACCOUNT_ID: 'acct',
    R2_S3_ACCESS_KEY_ID: 'AK',
    R2_S3_SECRET_ACCESS_KEY: 'SK',
  };

  it('returns trimmed, non-empty credentials', () => {
    expect(
      resolveR2PresignCredentials({
        R2_S3_ACCOUNT_ID: '  acct  ',
        R2_S3_ACCESS_KEY_ID: 'AK\n',
        R2_S3_SECRET_ACCESS_KEY: ' SK ',
      }),
    ).toEqual({ accountId: 'acct', accessKeyId: 'AK', secretAccessKey: 'SK' });
  });

  it.each(['R2_S3_ACCOUNT_ID', 'R2_S3_ACCESS_KEY_ID', 'R2_S3_SECRET_ACCESS_KEY'])(
    'rejects a missing %s, naming only that variable',
    (missingKey) => {
      const env: Record<string, string | undefined> = { ...full, [missingKey]: undefined };
      expect(() => resolveR2PresignCredentials(env)).toThrow(new RegExp(missingKey));
    },
  );

  it('rejects a blank (whitespace-only) value', () => {
    expect(() => resolveR2PresignCredentials({ ...full, R2_S3_ACCESS_KEY_ID: '   ' })).toThrow(/R2_S3_ACCESS_KEY_ID/);
  });

  it('never leaks a present credential value in the error message', () => {
    let message = '';
    try {
      resolveR2PresignCredentials({ R2_S3_ACCOUNT_ID: 'acct-secret-1234', R2_S3_ACCESS_KEY_ID: 'AKIA-secret', R2_S3_SECRET_ACCESS_KEY: '' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/R2_S3_SECRET_ACCESS_KEY/);
    expect(message).not.toMatch(/acct-secret-1234|AKIA-secret/);
  });
});

describe('presignUploadPutUrl', () => {
  const creds = { accountId: 'acct123', accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secretExampleValue' };

  it('targets the R2 S3 endpoint with the given bucket/key and signs the query string (PUT, SigV4)', async () => {
    const url = await presignUploadPutUrl(creds, 'uploads/abc-123.jpg', 900, 'anna-ciok-print-assets');
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://acct123.r2.cloudflarestorage.com/anna-ciok-print-assets/uploads/abc-123.jpg');
    expect(parsed.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(parsed.searchParams.get('X-Amz-Credential')).toMatch(/^AKIAEXAMPLE\//);
    expect(parsed.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('URL-encodes a key containing special characters', async () => {
    const url = await presignUploadPutUrl(creds, 'uploads/a b.jpg', 900, 'bucket');
    expect(url).toContain('/bucket/uploads/a%20b.jpg');
  });

  it('defaults to UPLOAD_PRESIGN_TTL_SECS and the production bucket name when not overridden', async () => {
    const url = await presignUploadPutUrl(creds, 'uploads/abc-123.jpg');
    const parsed = new URL(url);
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe(String(UPLOAD_PRESIGN_TTL_SECS));
    expect(parsed.pathname).toBe('/anna-ciok-print-assets/uploads/abc-123.jpg');
  });

  it('signs a PUT request (not GET)', async () => {
    const client = { sign: vi.fn(async (input: string, init?: RequestInit) => new Request(input, init)) };
    await presignUploadPutUrl(creds, 'uploads/abc-123.jpg', 900, 'bucket', client);
    expect(client.sign).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ method: 'PUT' }));
  });
});

describe('mapUploadRowToIntent', () => {
  it('maps a fresh row + presigned URL to the UploadIntent shape (assetId mirrors id in Phase 1)', () => {
    const row = { id: 'up_1', expires_at: '2026-09-17T12:15:00.000Z' };
    expect(mapUploadRowToIntent(row, 'https://signed.example/put')).toEqual({
      id: 'up_1',
      assetId: 'up_1',
      uploadUrl: 'https://signed.example/put',
      expiresAt: '2026-09-17T12:15:00.000Z',
    });
  });
});

const baseRow: UploadRow = {
  id: 'up_1',
  filename: 'kubek-01.jpg',
  content_type: 'image/jpeg',
  declared_byte_size: 1000,
  ratio: '4:5',
  r2_key: 'uploads/up_1.jpg',
  status: 'confirmed',
  revision: 1,
  confirmed_byte_size: 1000,
  confirmed_content_type: 'image/jpeg',
  created_by: 'anna@anna-ciok.studio',
  created_at: '2026-09-17T12:00:00.000Z',
  expires_at: '2026-09-17T12:15:00.000Z',
  updated_at: '2026-09-17T12:05:00.000Z',
};

describe('mapConfirmedUploadToAsset', () => {
  it('maps a confirmed row to the Asset shape — status "uploaded" (awaiting Phase 2+ processing)', () => {
    expect(mapConfirmedUploadToAsset({ ...baseRow, status: 'confirmed' })).toEqual({
      id: 'up_1',
      name: 'kubek-01.jpg',
      revision: 1,
      status: 'uploaded',
      ratio: '4:5',
      url: 'https://anna-ciok.studio/api/print-assets/uploads/up_1',
      usages: [],
      error: '',
    });
  });
});

// ---------------------------------------------------------------------------
// I/O — always over the handler context's ctx.supabase, never adminSupabase()
// / getCloudflareContext() (see request-handler.test.ts's Task 5 regression).
// ---------------------------------------------------------------------------

function fakeSupabase(rows: { insert?: UploadRow; get?: UploadRow | null; update?: UploadRow | null }) {
  return {
    from(table: string) {
      if (table !== 'print_asset_uploads') throw new Error(`unexpected table: ${table}`);
      return {
        insert: () => ({
          select: () => ({ single: async () => ({ data: rows.insert, error: null }) }),
        }),
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: rows.get, error: null }),
          }),
        }),
        update: () => ({
          eq: () => ({
            eq: () => ({
              select: () => ({ maybeSingle: async () => ({ data: rows.update, error: null }) }),
            }),
          }),
        }),
      };
    },
  } as never;
}

describe('insertUploadRow', () => {
  it('inserts and returns the created row', async () => {
    const supabase = fakeSupabase({ insert: baseRow });
    const result = await insertUploadRow(supabase, {
      id: 'up_1',
      filename: 'kubek-01.jpg',
      contentType: 'image/jpeg',
      bytes: 1000,
      ratio: '4:5',
      r2Key: 'uploads/up_1.jpg',
      createdBy: 'anna@anna-ciok.studio',
      expiresAt: '2026-09-17T12:15:00.000Z',
    });
    expect(result).toEqual(baseRow);
  });
});

describe('getUploadRowById', () => {
  it('returns the row when found', async () => {
    const supabase = fakeSupabase({ get: baseRow });
    expect(await getUploadRowById(supabase, 'up_1')).toEqual(baseRow);
  });

  it('returns null when absent', async () => {
    const supabase = fakeSupabase({ get: null });
    expect(await getUploadRowById(supabase, 'missing')).toBeNull();
  });
});

describe('confirmUploadRow', () => {
  it('returns the updated row on a successful CAS', async () => {
    const supabase = fakeSupabase({ update: { ...baseRow, status: 'confirmed', revision: 1 } });
    const result = await confirmUploadRow(supabase, 'up_1', 0, { byteSize: 1000, contentType: 'image/jpeg' });
    expect(result?.status).toBe('confirmed');
    expect(result?.revision).toBe(1);
  });

  it('returns null when the CAS misses (revision already moved on)', async () => {
    const supabase = fakeSupabase({ update: null });
    const result = await confirmUploadRow(supabase, 'up_1', 0, { byteSize: 1000, contentType: 'image/jpeg' });
    expect(result).toBeNull();
  });
});
