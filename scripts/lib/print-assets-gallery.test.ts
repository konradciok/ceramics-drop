import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  tryLoadManifestV2: vi.fn(),
  localDerivativePath: vi.fn(),
  hashFile: vi.fn(),
  r2GetToFile: vi.fn(),
}));

vi.mock('./print-assets-cli', () => ({
  tryLoadManifestV2: mocks.tryLoadManifestV2,
  localDerivativePath: mocks.localDerivativePath,
}));
vi.mock('./image-facts', () => ({ hashFile: mocks.hashFile }));
vi.mock('./r2', () => ({ r2GetToFile: mocks.r2GetToFile }));

import { resolveGallerySource } from './print-assets-gallery';
import type { ReadyAssetDetail } from './print-assets-resolve';

const SHA = 'a'.repeat(64);
const OTHER_SHA = 'b'.repeat(64);
const SCRATCH_DIR = '/tmp/print-assets-gallery-scratch';
const BUCKET = 'anna-ciok-print-assets';
const LOCAL_PATH = `/repo/design/print-assets/fap01/2026-07-13-r2/3600x4800-${SHA}.jpg`;

const ASSET: ReadyAssetDetail = {
  id: '11111111-1111-1111-1111-111111111111',
  revision: '2026-07-13-r2',
  profile_key: '3600x4800',
  sha256: SHA,
  r2_key: `prints/fap01/2026-07-13-r2/3600x4800-${SHA}.jpg`,
  verified_at: '2026-07-13T10:00:00Z',
};

/** A manifest whose single derivative matches ASSET's profile_key by px, with the given sha256. */
function manifestWithDerivative(sha256: string) {
  return { derivatives: [{ width: 3600, height: 4800, format: 'jpg', sha256 }] };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.localDerivativePath.mockReturnValue(LOCAL_PATH);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveGallerySource', () => {
  it('returns the local derivative path when its bytes match the asset hash exactly', async () => {
    mocks.tryLoadManifestV2.mockReturnValue(manifestWithDerivative(SHA));
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    mocks.hashFile.mockResolvedValue(SHA);

    const result = await resolveGallerySource('fap01', ASSET, SCRATCH_DIR, BUCKET);

    expect(result).toBe(LOCAL_PATH);
    expect(mocks.hashFile).toHaveBeenCalledWith(LOCAL_PATH);
    expect(mocks.r2GetToFile).not.toHaveBeenCalled();
  });

  it('falls back to a verified R2 download when the local file has drifted from the manifest hash', async () => {
    mocks.tryLoadManifestV2.mockReturnValue(manifestWithDerivative(SHA));
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    // Local bytes no longer hash to what the manifest/DB claim (drift/corruption);
    // the re-downloaded bytes at the scratch destination do.
    mocks.hashFile.mockImplementation(async (p: string) => (p === LOCAL_PATH ? OTHER_SHA : SHA));
    mocks.r2GetToFile.mockReturnValue({ ok: true });

    const result = await resolveGallerySource('fap01', ASSET, SCRATCH_DIR, BUCKET);

    const expectedDestination = path.join(SCRATCH_DIR, `source-${ASSET.profile_key}.jpg`);
    expect(result).toBe(expectedDestination);
    expect(mocks.r2GetToFile).toHaveBeenCalledWith(BUCKET, ASSET.r2_key, expectedDestination);
  });

  it('throws an integrity-mismatch error when the downloaded bytes do not match the expected hash', async () => {
    mocks.tryLoadManifestV2.mockReturnValue(null);
    mocks.r2GetToFile.mockReturnValue({ ok: true });
    mocks.hashFile.mockResolvedValue(OTHER_SHA);

    await expect(resolveGallerySource('fap01', ASSET, SCRATCH_DIR, BUCKET)).rejects.toThrow(
      /Integrity mismatch for .*: expected .*, got .*/,
    );
  });

  it('falls back to R2 when the local manifest is missing or a recognized legacy shape (tryLoadManifestV2 → null)', async () => {
    mocks.tryLoadManifestV2.mockReturnValue(null);
    mocks.r2GetToFile.mockReturnValue({ ok: true });
    mocks.hashFile.mockResolvedValue(SHA);

    const result = await resolveGallerySource('fap01', ASSET, SCRATCH_DIR, BUCKET);

    expect(result).toBe(path.join(SCRATCH_DIR, `source-${ASSET.profile_key}.jpg`));
    // No manifest ⇒ no derivative match ⇒ never even asked for a local path.
    expect(mocks.localDerivativePath).not.toHaveBeenCalled();
  });

  it('rejects a malformed/unknown local manifest before ever touching R2', async () => {
    mocks.tryLoadManifestV2.mockImplementation(() => {
      throw new Error('Malformed legacy manifest at design/print-assets/fap01/2026-07-13-r2/manifest.json');
    });

    await expect(resolveGallerySource('fap01', ASSET, SCRATCH_DIR, BUCKET)).rejects.toThrow(
      /Malformed legacy manifest/,
    );
    expect(mocks.r2GetToFile).not.toHaveBeenCalled();
  });

  it('throws when the R2 fulfilment object is missing', async () => {
    mocks.tryLoadManifestV2.mockReturnValue(null);
    mocks.r2GetToFile.mockReturnValue({ ok: false, kind: 'absent', error: 'The specified key does not exist.' });

    await expect(resolveGallerySource('fap01', ASSET, SCRATCH_DIR, BUCKET)).rejects.toThrow(
      /Failed to download fulfilment source .*: The specified key does not exist\./,
    );
  });
});
