import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import sharp from 'sharp';
import { preflightPreparedRevision, type PreflightDeps } from './print-assets-preflight';
import { loadPrepareConfig, loadManifestV2 } from './print-assets-cli';
import { hashFile, readObjectFacts } from './image-facts';
import {
  buildManifest,
  buildFullBleedManifest,
  distinctProfiles,
  resolvePlacement,
  COMPOSE_RENDERER_VERSION,
  type BuildFullBleedManifestInput,
  type BuildManifestInput,
  type PrintLayout,
} from '../../src/lib/print-assets-prepare';

const LAYOUT: PrintLayout = {
  sideMargin: 0.1,
  topMargin: 0.1,
  bottomMargin: 0.1,
  gapAboveSignature: 0.05,
  signatureZoneHeight: 0.05,
};
const PROFILES = [
  { variantKey: 'v-small', w: 100, h: 120 },
  { variantKey: 'v-large', w: 140, h: 100 },
];
const DECLARED_ARTWORK = { width: 400, height: 400 };
const SIGNATURE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="20"><rect width="100" height="20" fill="#0000ff"/></svg>';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

interface Scenario {
  input: { productId: string; revision: string; requireLocalDerivatives: boolean };
  deps: PreflightDeps;
}

interface SetupOpts {
  requireLocalDerivatives?: boolean;
  tamperArtworkSha?: boolean;
  tamperSignatureSha?: boolean;
  tamperDerivativeBytes?: boolean;
  wrongArtworkFileDims?: boolean;
}

async function jpeg(width: number, height: number, background: string): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background } }).jpeg().toBuffer();
}

async function setup(opts: SetupOpts = {}): Promise<Scenario> {
  const product = 'fap01';
  const revision = 'r2';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'print-assets-preflight-'));
  tempRoots.push(root);

  const productDir = path.join(root, 'design', 'print-assets', product);
  const revDir = path.join(productDir, revision);
  fs.mkdirSync(revDir, { recursive: true });

  // Artwork master (its on-disk dims may deliberately differ from the declared dims).
  const artworkPath = path.join(productDir, 'artwork.png');
  const fileDims = opts.wrongArtworkFileDims
    ? { width: DECLARED_ARTWORK.width - 1, height: DECLARED_ARTWORK.height - 1 }
    : DECLARED_ARTWORK;
  await sharp({ create: { ...fileDims, channels: 3, background: '#E6E0D3' } })
    .png()
    .toFile(artworkPath);
  const artworkSha = await hashFile(artworkPath);

  const signaturePath = path.join(productDir, 'signature.svg');
  fs.writeFileSync(signaturePath, SIGNATURE_SVG);
  const signatureSha = await hashFile(signaturePath);

  // One derivative file per profile, named by its own content hash.
  const profiles = distinctProfiles(PROFILES);
  const derivativeMeta: BuildManifestInput['derivativeMeta'] = {};
  for (const profile of profiles) {
    const buffer = await jpeg(profile.w, profile.h, '#123456');
    const sha256 = (await import('node:crypto')).createHash('sha256').update(buffer).digest('hex');
    const file = path.join(revDir, `${profile.profileKey}-${sha256}.jpg`);
    fs.writeFileSync(file, buffer);
    derivativeMeta[profile.profileKey] = {
      sha256,
      byteSize: buffer.byteLength,
      format: 'jpg',
      placement: resolvePlacement(
        LAYOUT,
        { w: profile.w, h: profile.h },
        { w: DECLARED_ARTWORK.width, h: DECLARED_ARTWORK.height },
        true,
      ),
    };
  }

  // Tracked config file (its raw bytes seed the manifest's configSha256).
  const configDir = path.join(root, 'config', 'print-assets');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, `${product}.json`);
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        product,
        artwork: `design/print-assets/${product}/artwork.png`,
        background: '#E6E0D3',
        format: 'jpg',
        layout: LAYOUT,
        signature: { svg: `design/print-assets/${product}/signature.svg` },
      },
      null,
      2,
    ),
  );
  const configSha256 = await hashFile(configPath);

  const manifest = buildManifest({
    product,
    revision,
    configSha256,
    background: '#E6E0D3',
    layout: LAYOUT,
    artworkManifestPath: `design/print-assets/${product}/artwork.png`,
    artworkSha256: artworkSha,
    artworkWidth: DECLARED_ARTWORK.width,
    artworkHeight: DECLARED_ARTWORK.height,
    signatureManifestPath: `design/print-assets/${product}/signature.svg`,
    signatureSha256: signatureSha,
    profiles,
    derivativeMeta,
  });

  // Apply tampering that keeps the manifest structurally valid (so the loader
  // accepts it) but breaks a local-file cross-check.
  if (opts.tamperArtworkSha) manifest.artwork.sha256 = 'f'.repeat(64);
  if (opts.tamperSignatureSha && manifest.signature) manifest.signature.sha256 = 'f'.repeat(64);

  fs.writeFileSync(path.join(revDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  if (opts.tamperDerivativeBytes) {
    // Overwrite a derivative file's bytes (same dims) — the content-addressed
    // filename still claims the old hash, so a re-hash must mismatch.
    const first = profiles[0];
    const sha = derivativeMeta[first.profileKey].sha256;
    const file = path.join(revDir, `${first.profileKey}-${sha}.jpg`);
    fs.writeFileSync(file, await jpeg(first.w, first.h, '#654321'));
  }

  const deps: PreflightDeps = {
    loadConfig: (p) => loadPrepareConfig(p, root),
    loadManifest: (p, r) => loadManifestV2(p, r, root),
    readImageFacts: readObjectFacts,
    hashFile,
    localDerivativePath: (p, r, profileKey, sha256, format) =>
      path.join(root, 'design', 'print-assets', p, r, `${profileKey}-${sha256}.${format}`),
  };

  return {
    input: { productId: product, revision, requireLocalDerivatives: opts.requireLocalDerivatives ?? true },
    deps,
  };
}

describe('preflightPreparedRevision', () => {
  it('resolves with the config + validated v2 manifest for a consistent revision', async () => {
    const { input, deps } = await setup();
    const result = await preflightPreparedRevision(input, deps);
    expect(result.manifest.schemaVersion).toBe(2);
    expect(result.manifest.rendererVersion).toBe(COMPOSE_RENDERER_VERSION);
    expect(result.config.value.product).toBe('fap01');
  });

  it('rejects when the on-disk artwork hash no longer matches the manifest', async () => {
    const { input, deps } = await setup({ tamperArtworkSha: true });
    await expect(preflightPreparedRevision(input, deps)).rejects.toThrow(/artwork sha256/i);
  });

  it('rejects when the on-disk signature hash no longer matches the manifest', async () => {
    const { input, deps } = await setup({ tamperSignatureSha: true });
    await expect(preflightPreparedRevision(input, deps)).rejects.toThrow(/signature sha256/i);
  });

  it('rejects when a local derivative no longer matches its recorded hash', async () => {
    const { input, deps } = await setup({ tamperDerivativeBytes: true, requireLocalDerivatives: true });
    await expect(preflightPreparedRevision(input, deps)).rejects.toThrow(/local derivative.*sha256/i);
  });

  it('rejects when the on-disk artwork dimensions differ from the manifest', async () => {
    const { input, deps } = await setup({ wrongArtworkFileDims: true });
    await expect(preflightPreparedRevision(input, deps)).rejects.toThrow(/dimensions/i);
  });

  it('does not read local derivatives when requireLocalDerivatives is false', async () => {
    // Tampered derivative bytes would fail a local check, but verify never reads them.
    const { input, deps } = await setup({ tamperDerivativeBytes: true, requireLocalDerivatives: false });
    await expect(preflightPreparedRevision(input, deps)).resolves.toMatchObject({
      manifest: { schemaVersion: 2 },
    });
  });
});

describe('preflightPreparedRevision — fullBleed', () => {
  interface FullBleedSetupOpts {
    tamperSourceSha?: boolean;
    tamperDerivativeBytes?: boolean;
    wrongSourceFileDims?: boolean;
  }

  async function setupFullBleed(opts: FullBleedSetupOpts = {}): Promise<Scenario> {
    const product = 'fap005';
    const revision = 'r1';
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'print-assets-preflight-fb-'));
    tempRoots.push(root);

    // Full-bleed sources live under the shared design/uploads/ pool, not
    // design/print-assets/{productId}/ — a distinct guarded tree (cli.ts).
    const masterDir = path.join(root, 'design', 'uploads', 'master-images-prints', '01');
    fs.mkdirSync(masterDir, { recursive: true });
    const sourcePath = path.join(masterDir, '01__3x4.jpg');
    const onDiskDims = opts.wrongSourceFileDims ? { width: 3599, height: 4799 } : { width: 3600, height: 4800 };
    await sharp({ create: { ...onDiskDims, channels: 3, background: '#123456' } }).jpeg().toFile(sourcePath);
    const sourceSha = await hashFile(sourcePath);

    const revDir = path.join(root, 'design', 'print-assets', product, revision);
    fs.mkdirSync(revDir, { recursive: true });

    const profiles = distinctProfiles([{ variantKey: '30x40:false:false:none', w: 3600, h: 4800 }]);
    const derivativeMeta: BuildFullBleedManifestInput['derivativeMeta'] = {};
    for (const profile of profiles) {
      const buffer = await jpeg(profile.w, profile.h, '#654321');
      const sha256 = (await import('node:crypto')).createHash('sha256').update(buffer).digest('hex');
      const file = path.join(revDir, `${profile.profileKey}-${sha256}.jpg`);
      fs.writeFileSync(file, buffer);
      derivativeMeta[profile.profileKey] = {
        sha256,
        byteSize: buffer.byteLength,
        format: 'jpg',
        source: {
          ratio: '3x4',
          path: 'design/uploads/master-images-prints/01/01__3x4.jpg',
          sha256: sourceSha,
          // Recorded as the DECLARED source dims, independent of what the
          // on-disk file happens to be right now — preflight's job is to
          // catch drift between the two, not to derive one from the other.
          width: 3600,
          height: 4800,
        },
      };
    }

    const configDir = path.join(root, 'config', 'print-assets');
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, `${product}.json`);
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          product,
          mode: 'fullBleed',
          format: 'jpg',
          sources: {
            '3x4': 'design/uploads/master-images-prints/01/01__3x4.jpg',
            '5x7': 'design/uploads/master-images-prints/01/01__5x7.jpg',
            '7x10': 'design/uploads/master-images-prints/01/01__7x10.jpg',
            '2x3': 'design/uploads/master-images-prints/01/01__2x3.jpg',
          },
        },
        null,
        2,
      ),
    );
    const configSha256 = await hashFile(configPath);

    const manifest = buildFullBleedManifest({ product, revision, configSha256, profiles, derivativeMeta });

    if (opts.tamperSourceSha) manifest.derivatives[0].source.sha256 = 'f'.repeat(64);

    fs.writeFileSync(path.join(revDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    if (opts.tamperDerivativeBytes) {
      const first = profiles[0];
      const sha = derivativeMeta[first.profileKey].sha256;
      const file = path.join(revDir, `${first.profileKey}-${sha}.jpg`);
      fs.writeFileSync(file, await jpeg(first.w, first.h, '#000000'));
    }

    const deps: PreflightDeps = {
      loadConfig: (p) => loadPrepareConfig(p, root),
      loadManifest: (p, r) => loadManifestV2(p, r, root),
      readImageFacts: readObjectFacts,
      hashFile,
      localDerivativePath: (p, r, profileKey, sha256, format) =>
        path.join(root, 'design', 'print-assets', p, r, `${profileKey}-${sha256}.${format}`),
    };

    return { input: { productId: product, revision, requireLocalDerivatives: true }, deps };
  }

  it('resolves with the config + validated v2 manifest for a consistent fullBleed revision', async () => {
    const { input, deps } = await setupFullBleed();
    const result = await preflightPreparedRevision(input, deps);
    expect(result.manifest.mode).toBe('fullBleed');
    expect(result.config.value.mode).toBe('fullBleed');
  });

  it('rejects when the manifest-recorded source hash no longer matches the on-disk master', async () => {
    const { input, deps } = await setupFullBleed({ tamperSourceSha: true });
    await expect(preflightPreparedRevision(input, deps)).rejects.toThrow(/source.*"3x4".*sha256/i);
  });

  it('rejects when a local derivative no longer matches its recorded hash', async () => {
    const { input, deps } = await setupFullBleed({ tamperDerivativeBytes: true });
    await expect(preflightPreparedRevision(input, deps)).rejects.toThrow(/local derivative.*sha256/i);
  });

  it('rejects when the on-disk source dimensions differ from the manifest (master changed since prepare)', async () => {
    const { input, deps } = await setupFullBleed({ wrongSourceFileDims: true });
    await expect(preflightPreparedRevision(input, deps)).rejects.toThrow(/source.*"3x4".*dimensions/i);
  });
});

describe('module boundary', () => {
  it('imports no R2 or Supabase helpers (rejected preflights cannot call external services)', () => {
    const source = fs.readFileSync(path.join(__dirname, 'print-assets-preflight.ts'), 'utf8');
    expect(source).not.toMatch(/loadSupabaseClient|from '\.\/r2'|from '\.\/script-env'|@supabase/);
  });
});
