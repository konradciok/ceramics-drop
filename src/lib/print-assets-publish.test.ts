import { describe, it, expect } from 'vitest';
import {
  buildStagedRows,
  decideUploadAction,
  partitionStagedRows,
  compareRemoteToManifest,
  buildPublishAssignments,
  diffVariantCoverage,
  type StagedAssetRow,
} from './print-assets-publish';
import type { ManifestDerivative, PrepareManifest } from './print-assets-prepare';

// Module-scope regexes (avoid re-compiling inside each assertion).
const CONTENT_TYPE_REJECTED_RE = /content_type does not accept/;
const REFUSING_OVERWRITE_RE = /Refusing to overwrite/;
const SHA256_MISMATCH_RE = /sha256 mismatch/;
const BYTE_SIZE_MISMATCH_RE = /byte size mismatch/;
const DIMENSION_MISMATCH_RE = /dimension mismatch/;
const NO_READY_ROW_RE = /No ready print_fulfilment_assets row/;
const NO_DERIVATIVE_RE = /no\s+derivative for that profile/;

/** A minimal two-profile manifest: two derivatives, three variants (one shared). */
function manifest(overrides: Partial<PrepareManifest> = {}): PrepareManifest {
  const derivatives: ManifestDerivative[] = [
    {
      profileKey: '3600x4800',
      width: 3600,
      height: 4800,
      format: 'jpg',
      contentType: 'image/jpeg',
      sha256: 'a'.repeat(64),
      byteSize: 1000,
      r2Key: 'prints/fap01/rev1/3600x4800-' + 'a'.repeat(64) + '.jpg',
      artworkBoxPx: { x: 0, y: 0, width: 3600, height: 4800 },
      signatureBoxPx: null,
    },
    {
      profileKey: '4800x7200',
      width: 4800,
      height: 7200,
      format: 'png',
      contentType: 'image/png',
      sha256: 'b'.repeat(64),
      byteSize: 2000,
      r2Key: 'prints/fap01/rev1/4800x7200-' + 'b'.repeat(64) + '.png',
      artworkBoxPx: { x: 0, y: 0, width: 4800, height: 7200 },
      signatureBoxPx: null,
    },
  ];
  return {
    product: 'fap01',
    revision: 'rev1',
    sourceSha256: 'c'.repeat(64),
    sourceWidth: 9000,
    sourceHeight: 13000,
    signatureSha256: null,
    layout: {
      rendererVersion: '2.0.0',
      background: '#E8E0D7',
      artworkSha256: 'c'.repeat(64),
      signatureSha256: null,
      layout: { sideMargin: 0.1, topMargin: 0.1, bottomMargin: 0.1, gapAboveSignature: 0.05, signatureZoneHeight: 0.05 },
    },
    derivatives,
    assignments: [
      { variantKey: 'small-unframed', profileKey: '3600x4800' },
      { variantKey: 'small-framed', profileKey: '3600x4800' },
      { variantKey: 'large-unframed', profileKey: '4800x7200' },
    ],
    ...overrides,
  };
}

describe('buildStagedRows', () => {
  it('projects one staged row per derivative with matching content columns', () => {
    const rows = buildStagedRows(manifest());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual<StagedAssetRow>({
      product_id: 'fap01',
      revision: 'rev1',
      profile_key: '3600x4800',
      r2_key: 'prints/fap01/rev1/3600x4800-' + 'a'.repeat(64) + '.jpg',
      sha256: 'a'.repeat(64),
      content_type: 'image/jpeg',
      width_px: 3600,
      height_px: 4800,
      byte_size: 1000,
      status: 'staged',
    });
    expect(rows[1].content_type).toBe('image/png');
    expect(rows.every((r) => r.status === 'staged')).toBe(true);
  });

  it('rejects a derivative with a content-type the DB check constraint forbids', () => {
    const m = manifest();
    (m.derivatives[0] as ManifestDerivative).contentType = 'image/webp';
    expect(() => buildStagedRows(m)).toThrow(CONTENT_TYPE_REJECTED_RE);
  });
});

describe('decideUploadAction', () => {
  const derivative = { sha256: 'a'.repeat(64), r2Key: 'prints/fap01/rev1/3600x4800-x.jpg' };

  it('uploads when nothing exists at the key', () => {
    expect(decideUploadAction(derivative, null)).toBe('put');
  });

  it('skips when the remote object is byte-identical', () => {
    expect(decideUploadAction(derivative, { sha256: 'a'.repeat(64) })).toBe('skip');
  });

  it('aborts when a different object already occupies the immutable key', () => {
    expect(() => decideUploadAction(derivative, { sha256: 'f'.repeat(64) })).toThrow(REFUSING_OVERWRITE_RE);
  });
});

describe('partitionStagedRows', () => {
  const rows = buildStagedRows(manifest());

  it('inserts every row when the DB has none', () => {
    const p = partitionStagedRows(rows, new Map());
    expect(p.toInsert).toHaveLength(2);
    expect(p.alreadyStaged).toEqual([]);
    expect(p.conflicts).toEqual([]);
  });

  it('skips rows already staged with matching bytes (idempotent re-run)', () => {
    const existing = new Map([[rows[0].r2_key, { sha256: rows[0].sha256 }]]);
    const p = partitionStagedRows(rows, existing);
    expect(p.toInsert).toHaveLength(1);
    expect(p.toInsert[0].r2_key).toBe(rows[1].r2_key);
    expect(p.alreadyStaged).toEqual([rows[0].r2_key]);
    expect(p.conflicts).toEqual([]);
  });

  it('flags a same-key/different-hash row as a conflict', () => {
    const existing = new Map([[rows[0].r2_key, { sha256: 'f'.repeat(64) }]]);
    const p = partitionStagedRows(rows, existing);
    expect(p.conflicts).toEqual([rows[0].r2_key]);
    expect(p.toInsert).toHaveLength(1);
  });
});

describe('compareRemoteToManifest', () => {
  const [derivative] = manifest().derivatives;

  it('returns no errors when the remote object matches the manifest', () => {
    const errors = compareRemoteToManifest(derivative, {
      sha256: derivative.sha256,
      byteSize: derivative.byteSize,
      width: derivative.width,
      height: derivative.height,
    });
    expect(errors).toEqual([]);
  });

  it('reports sha256, byte-size and dimension mismatches distinctly', () => {
    const errors = compareRemoteToManifest(derivative, {
      sha256: 'f'.repeat(64),
      byteSize: 999,
      width: 100,
      height: 200,
    });
    expect(errors).toHaveLength(3);
    expect(errors[0]).toMatch(SHA256_MISMATCH_RE);
    expect(errors[1]).toMatch(BYTE_SIZE_MISMATCH_RE);
    expect(errors[2]).toMatch(DIMENSION_MISMATCH_RE);
  });
});

describe('buildPublishAssignments', () => {
  const m = manifest();
  const assetIdByR2Key = new Map([
    [m.derivatives[0].r2Key, '11111111-1111-1111-1111-111111111111'],
    [m.derivatives[1].r2Key, '22222222-2222-2222-2222-222222222222'],
  ]);

  it('maps every variant to its profile derivative asset id', () => {
    const assignments = buildPublishAssignments(m, assetIdByR2Key);
    expect(assignments).toEqual([
      { variant_key: 'small-unframed', asset_id: '11111111-1111-1111-1111-111111111111' },
      { variant_key: 'small-framed', asset_id: '11111111-1111-1111-1111-111111111111' },
      { variant_key: 'large-unframed', asset_id: '22222222-2222-2222-2222-222222222222' },
    ]);
  });

  it('fails closed when a profile derivative has no ready DB row', () => {
    const partial = new Map([[m.derivatives[0].r2Key, '11111111-1111-1111-1111-111111111111']]);
    expect(() => buildPublishAssignments(m, partial)).toThrow(NO_READY_ROW_RE);
  });

  it('fails closed when an assignment references a profile with no derivative', () => {
    const broken = manifest({
      assignments: [{ variantKey: 'ghost', profileKey: '9999x9999' }],
    });
    expect(() => buildPublishAssignments(broken, assetIdByR2Key)).toThrow(NO_DERIVATIVE_RE);
  });
});

describe('diffVariantCoverage', () => {
  it('reports no drift when active variants match the manifest exactly', () => {
    const diff = diffVariantCoverage(['a', 'b'], ['b', 'a']);
    expect(diff).toEqual({ missing: [], extra: [] });
  });

  it('flags an active variant added since prepare as missing', () => {
    const diff = diffVariantCoverage(['a', 'b', 'c'], ['a', 'b']);
    expect(diff).toEqual({ missing: ['c'], extra: [] });
  });

  it('flags a manifest variant no longer active as extra', () => {
    const diff = diffVariantCoverage(['a'], ['a', 'b']);
    expect(diff).toEqual({ missing: [], extra: ['b'] });
  });
});
