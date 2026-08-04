import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  parseScriptArgs,
  PRINT_ASSET_ARG_SPECS,
  revisionDir,
  ROOT,
  loadPrepareConfig,
  loadManifestV2,
  loadPublishManifest,
  tryLoadManifestV2,
  isFullBleedConfig,
} from './print-assets-cli';
import {
  buildManifest,
  distinctProfiles,
  resolvePlacement,
  type BuildManifestInput,
  type PrintLayout,
} from '../../src/lib/print-assets-prepare';

describe('parseScriptArgs', () => {
  const prepareSpec = PRINT_ASSET_ARG_SPECS.prepare;

  it('parses --flag value and --flag=value strings plus boolean flags', () => {
    expect(parseScriptArgs(prepareSpec, ['--product', 'fap01', '--revision=r1', '--dry-run'])).toMatchObject({
      product: 'fap01',
      revision: 'r1',
      'dry-run': true,
    });
  });

  it('rejects the removed --source override as an unknown option', () => {
    expect(() => parseScriptArgs(prepareSpec, ['--source', '/tmp/master.jpg'])).toThrow(/Unknown option.*source/i);
  });

  it('rejects an unrecognised flag (typo)', () => {
    expect(() => parseScriptArgs(prepareSpec, ['--dryrun'])).toThrow(/Unknown option/i);
  });

  it('rejects a bare positional argument', () => {
    expect(() => parseScriptArgs(prepareSpec, ['fap01'])).toThrow();
  });

  it('rejects a string option with no value', () => {
    expect(() => parseScriptArgs(prepareSpec, ['--product'])).toThrow();
  });

  it('rejects =value on a boolean option', () => {
    expect(() => parseScriptArgs(prepareSpec, ['--dry-run=false'])).toThrow();
  });

  it('rejects the negated --no-dry-run form', () => {
    expect(() => parseScriptArgs(prepareSpec, ['--no-dry-run'])).toThrow();
  });

  it('rejects an empty --env-file value', () => {
    expect(() => parseScriptArgs(prepareSpec, ['--env-file='])).toThrow(/non-empty/i);
  });

  it('rejects a bare --env-file with no value (parses as boolean true, not a TypeError)', () => {
    expect(() => parseScriptArgs(prepareSpec, ['--product', 'fap01', '--env-file'])).toThrow(
      /requires a value/i,
    );
  });

  it('rejects --env-file supplied more than once', () => {
    expect(() => parseScriptArgs(prepareSpec, ['--env-file', 'a', '--env-file', 'b'])).toThrow(/once/i);
  });

  it('rejects a spec that declares the same name as both string and boolean', () => {
    expect(() => parseScriptArgs({ strings: ['product', 'force'], booleans: ['force'] }, [])).toThrow(
      /both string and boolean/i,
    );
  });

  it('rejects a spec that redeclares the reserved env-file option', () => {
    expect(() => parseScriptArgs({ booleans: ['env-file'] }, [])).toThrow(/reserved/i);
  });
});

describe('revisionDir', () => {
  it('joins valid product/revision segments under design/print-assets', () => {
    expect(revisionDir('fap01', '2026-07-11-r1')).toBe(path.join(ROOT, 'design', 'print-assets', 'fap01', '2026-07-11-r1'));
  });

  it.each([
    ['../etc', 'r1'],
    ['fap01', '../../etc'],
    ['fap01', 'r1/../../etc'],
    ['fap01', '..'],
    ['', 'r1'],
    ['fap01', ''],
    ['fap01/x', 'r1'],
    ['fap01', 'r1\\x'],
  ])('rejects a traversal/invalid segment (product=%j, revision=%j)', (product, revision) => {
    expect(() => revisionDir(product, revision)).toThrow();
  });
});

// ── Config + manifest loaders (temp-root injected) ─────────────────────────────

const LAYOUT: PrintLayout = {
  sideMargin: 0.1,
  topMargin: 0.1,
  bottomMargin: 0.1,
  gapAboveSignature: 0.05,
  signatureZoneHeight: 0.05,
};

/** A self-consistent, current-renderer schema-v2 manifest object as plain JSON. */
function v2ManifestObject(product: string, revision: string): Record<string, unknown> {
  const profiles = distinctProfiles([
    { variantKey: 'v-small', w: 1000, h: 1000 },
    { variantKey: 'v-large', w: 1400, h: 2000 },
  ]);
  const inputs: BuildManifestInput = {
    product,
    revision,
    configSha256: 'f'.repeat(64),
    background: '#E8E0D7',
    layout: LAYOUT,
    artworkManifestPath: `design/print-assets/${product}/artwork.png`,
    artworkSha256: 'a'.repeat(64),
    artworkWidth: 1600,
    artworkHeight: 1600,
    signatureManifestPath: `design/print-assets/${product}/signature.svg`,
    signatureSha256: 'd'.repeat(64),
    profiles,
    derivativeMeta: {
      '1000x1000': {
        sha256: 'b'.repeat(64),
        byteSize: 111,
        format: 'jpg',
        placement: resolvePlacement(LAYOUT, { w: 1000, h: 1000 }, { w: 1600, h: 1600 }, true),
      },
      '1400x2000': {
        sha256: 'c'.repeat(64),
        byteSize: 222,
        format: 'jpg',
        placement: resolvePlacement(LAYOUT, { w: 1400, h: 2000 }, { w: 1600, h: 1600 }, true),
      },
    },
  };
  return JSON.parse(JSON.stringify(buildManifest(inputs)));
}

function legacyManifestObject(product: string, revision: string): Record<string, unknown> {
  return {
    product,
    revision,
    sourceSha256: 'c'.repeat(64),
    sourceWidth: 8400,
    sourceHeight: 12000,
    derivatives: [
      {
        profileKey: '1000x1000',
        width: 1000,
        height: 1000,
        format: 'jpg',
        contentType: 'image/jpeg',
        sha256: 'b'.repeat(64),
        byteSize: 111,
        r2Key: `prints/${product}/${revision}/1000x1000-${'b'.repeat(64)}.jpg`,
      },
    ],
    assignments: [{ variantKey: 'v-small', profileKey: '1000x1000' }],
  };
}

describe('config + manifest loaders', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'print-assets-cli-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeConfig(product: string, config: unknown): void {
    const dir = path.join(root, 'config', 'print-assets');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${product}.json`), JSON.stringify(config, null, 2));
  }

  function writeManifest(product: string, revision: string, contents: unknown): void {
    const dir = path.join(root, 'design', 'print-assets', product, revision);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2),
    );
  }

  const VALID_CONFIG = {
    product: 'fap01',
    artwork: 'design/print-assets/fap01/artwork.png',
    background: '#E8E0D7',
    format: 'jpg',
    layout: LAYOUT,
    signature: { svg: 'design/print-assets/fap01/signature.svg' },
  };

  describe('loadPrepareConfig', () => {
    it('loads a config, hashes its raw bytes, and resolves artwork/signature paths', () => {
      writeConfig('fap01', VALID_CONFIG);
      const loaded = loadPrepareConfig('fap01', root);
      if (isFullBleedConfig(loaded)) throw new Error('expected a poster config in this test');
      expect(loaded.value.product).toBe('fap01');
      expect(loaded.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(loaded.artwork.manifestPath).toBe('design/print-assets/fap01/artwork.png');
      expect(loaded.artwork.absolutePath).toBe(path.join(root, 'design', 'print-assets', 'fap01', 'artwork.png'));
      expect(loaded.signature?.manifestPath).toBe('design/print-assets/fap01/signature.svg');
    });

    it('rejects an artwork path that escapes the product directory', () => {
      writeConfig('fap01', { ...VALID_CONFIG, artwork: 'design/print-assets/fap02/artwork.png' });
      expect(() => loadPrepareConfig('fap01', root)).toThrow(/outside|under design/i);
    });

    it('rejects a structurally invalid config', () => {
      writeConfig('fap01', { product: 'fap01', background: 'linen', format: 'webp', layout: {} });
      expect(() => loadPrepareConfig('fap01', root)).toThrow(/invalid|background|format/i);
    });
  });

  describe('loadManifestV2', () => {
    it('loads a current-renderer schema-v2 manifest', () => {
      writeManifest('fap01', 'r2', v2ManifestObject('fap01', 'r2'));
      expect(loadManifestV2('fap01', 'r2', root).schemaVersion).toBe(2);
    });

    it('rejects a v2 manifest at a non-current renderer, naming the requirement', () => {
      const obj = v2ManifestObject('fap01', 'r2');
      obj.rendererVersion = '1.0.0';
      writeManifest('fap01', 'r2', obj);
      expect(() => loadManifestV2('fap01', 'r2', root)).toThrow(/renderer/i);
    });

    it('throws on invalid JSON, naming the manifest path', () => {
      writeManifest('fap01', 'r2', '{ not json');
      expect(() => loadManifestV2('fap01', 'r2', root)).toThrow(/Invalid JSON.*manifest|manifest.*Invalid JSON/i);
    });

    it('rejects a legacy manifest (upload/verify require v2)', () => {
      writeManifest('fap01', 'r1', legacyManifestObject('fap01', 'r1'));
      expect(() => loadManifestV2('fap01', 'r1', root)).toThrow(/schemaVersion.*2/i);
    });

    it('throws when the manifest is missing', () => {
      expect(() => loadManifestV2('fap01', 'nope', root)).toThrow(/No manifest/i);
    });
  });

  describe('tryLoadManifestV2', () => {
    it('returns the parsed manifest for a valid v2 manifest', () => {
      writeManifest('fap01', 'r2', v2ManifestObject('fap01', 'r2'));
      expect(tryLoadManifestV2('fap01', 'r2', root)?.schemaVersion).toBe(2);
    });

    it('returns null for a recognized legacy manifest (gallery falls back to R2)', () => {
      writeManifest('fap01', 'r1', legacyManifestObject('fap01', 'r1'));
      expect(tryLoadManifestV2('fap01', 'r1', root)).toBeNull();
    });

    it('returns null when the manifest is missing', () => {
      expect(tryLoadManifestV2('fap01', 'nope', root)).toBeNull();
    });

    it('throws on malformed schema-v2 data (never silently falls back)', () => {
      writeManifest('fap01', 'r2', { schemaVersion: 2, product: 'fap01' });
      expect(() => tryLoadManifestV2('fap01', 'r2', root)).toThrow();
    });

    it('throws on an unknown schema version', () => {
      writeManifest('fap01', 'r3', { schemaVersion: 3, product: 'fap01', revision: 'r3' });
      expect(() => tryLoadManifestV2('fap01', 'r3', root)).toThrow(/schema/i);
    });

    it('throws on invalid JSON before any fallback', () => {
      writeManifest('fap01', 'r2', 'not-json');
      expect(() => tryLoadManifestV2('fap01', 'r2', root)).toThrow(/Invalid JSON/i);
    });
  });

  describe('loadPublishManifest', () => {
    it('accepts a legacy manifest for rollback', () => {
      writeManifest('fap01', 'r1', legacyManifestObject('fap01', 'r1'));
      expect(loadPublishManifest('fap01', 'r1', root)).toMatchObject({ product: 'fap01', revision: 'r1' });
    });

    it('accepts a v2 manifest too', () => {
      writeManifest('fap01', 'r2', v2ManifestObject('fap01', 'r2'));
      expect(loadPublishManifest('fap01', 'r2', root)).toMatchObject({ product: 'fap01', revision: 'r2' });
    });
  });
});
