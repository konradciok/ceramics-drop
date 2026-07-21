/**
 * Local-only preflight for the print-asset pipeline: prove a prepared revision's
 * tracked config, v2 manifest, and on-disk source/derivative bytes all agree
 * BEFORE upload/verify resolve a bucket or load Supabase.
 *
 * Module-boundary guarantee: this file imports only filesystem, Sharp/image-facts,
 * config, and manifest helpers — never R2 or Supabase. A rejected preflight
 * therefore cannot have made any external call (enforced by a source-scan test).
 */
import path from 'node:path';
import {
  loadManifestV2,
  loadPrepareConfig,
  localDerivativePath,
  type LoadedPrepareConfig,
} from './print-assets-cli';
import { hashFile, readObjectFacts } from './image-facts';
import { parsePrepareManifest, profileKeyFromPx, type PrepareManifest, type PrintLayout } from '../../src/lib/print-assets-prepare';

export interface PreflightInput {
  productId: string;
  revision: string;
  requireLocalDerivatives: boolean;
}

export interface ObjectFacts {
  sha256: string;
  byteSize: number;
  width: number;
  height: number;
}

/** Injectable I/O so the preflight can be exercised against a temp workspace. */
export interface PreflightDeps {
  loadConfig: (productId: string) => LoadedPrepareConfig;
  loadManifest: (productId: string, revision: string) => PrepareManifest;
  readImageFacts: (absPath: string) => Promise<ObjectFacts>;
  hashFile: (absPath: string) => Promise<string>;
  localDerivativePath: (
    productId: string,
    revision: string,
    profileKey: string,
    sha256: string,
    format: string,
  ) => string;
}

const defaultDeps: PreflightDeps = {
  loadConfig: (productId) => loadPrepareConfig(productId),
  loadManifest: (productId, revision) => loadManifestV2(productId, revision),
  readImageFacts: readObjectFacts,
  hashFile,
  localDerivativePath: (productId, revision, profileKey, sha256, format) =>
    localDerivativePath(productId, revision, profileKey, sha256, format),
};

const LAYOUT_KEYS: (keyof PrintLayout)[] = [
  'sideMargin',
  'topMargin',
  'bottomMargin',
  'gapAboveSignature',
  'signatureZoneHeight',
  'artworkMaxWidth',
  'artworkMaxHeight',
];

function layoutsEqual(a: PrintLayout, b: PrintLayout): boolean {
  return LAYOUT_KEYS.every((key) => a[key] === b[key]);
}

/**
 * Fail closed unless the tracked config, the schema-v2 manifest, and the current
 * on-disk source (and — when requested — every local derivative) all agree.
 * Returns the loaded config + manifest for the caller to upload/verify.
 */
export async function preflightPreparedRevision(
  input: PreflightInput,
  deps: PreflightDeps = defaultDeps,
): Promise<{ config: LoadedPrepareConfig; manifest: PrepareManifest }> {
  const { productId, revision, requireLocalDerivatives } = input;
  const config = deps.loadConfig(productId);
  const manifest = deps.loadManifest(productId, revision);

  // 2. Config provenance: the raw config bytes must be the ones prepare recorded.
  if (config.sha256 !== manifest.configSha256) {
    throw new Error(
      `Config ${path.basename(config.configPath)} sha256 ${config.sha256.slice(0, 12)}… does not match ` +
        `manifest.configSha256 ${manifest.configSha256.slice(0, 12)}… — re-run print-assets:prepare.`,
    );
  }

  // 3. Config ⇄ manifest agreement on paths, background, layout, format, signature presence.
  if (config.artwork.manifestPath !== manifest.artwork.path) {
    throw new Error(`Config artwork path "${config.artwork.manifestPath}" does not match manifest "${manifest.artwork.path}".`);
  }
  if ((config.signature != null) !== (manifest.signature != null)) {
    throw new Error('Config signature presence does not match the manifest.');
  }
  if (config.signature && manifest.signature && config.signature.manifestPath !== manifest.signature.path) {
    throw new Error(
      `Config signature path "${config.signature.manifestPath}" does not match manifest "${manifest.signature.path}".`,
    );
  }
  if (config.value.background !== manifest.background) {
    throw new Error(`Config background "${config.value.background}" does not match manifest "${manifest.background}".`);
  }
  if (!layoutsEqual(config.value.layout, manifest.layout)) {
    throw new Error('Config layout does not match the manifest layout — re-run print-assets:prepare.');
  }
  if (manifest.derivatives.some((d) => d.format !== config.value.format)) {
    throw new Error(`Manifest contains a derivative whose format is not the configured ${config.value.format}.`);
  }

  // 4. Current artwork/signature bytes must be the ones prepare hashed.
  const artworkFacts = await deps.readImageFacts(config.artwork.absolutePath);
  if (artworkFacts.sha256 !== manifest.artwork.sha256) {
    throw new Error(
      `Artwork sha256 mismatch: on-disk ${artworkFacts.sha256.slice(0, 12)}… vs manifest ` +
        `${manifest.artwork.sha256.slice(0, 12)}… — the artwork master changed since prepare.`,
    );
  }
  if (artworkFacts.width !== manifest.artwork.width || artworkFacts.height !== manifest.artwork.height) {
    throw new Error(
      `Artwork dimensions mismatch: on-disk ${artworkFacts.width}x${artworkFacts.height} vs manifest ` +
        `${manifest.artwork.width}x${manifest.artwork.height}.`,
    );
  }
  if (manifest.signature) {
    if (!config.signature) throw new Error('Manifest declares a signature but the config has none.');
    const signatureSha = await deps.hashFile(config.signature.absolutePath);
    if (signatureSha !== manifest.signature.sha256) {
      throw new Error(
        `Signature sha256 mismatch: on-disk ${signatureSha.slice(0, 12)}… vs manifest ` +
          `${manifest.signature.sha256.slice(0, 12)}… — the signature changed since prepare.`,
      );
    }
  }

  // 5. Semantic manifest validation (idempotent with loadManifestV2; independent of the injected loader).
  parsePrepareManifest(manifest);

  // 6. Optionally prove every local derivative is byte-for-byte the recorded one.
  if (requireLocalDerivatives) {
    for (const derivative of manifest.derivatives) {
      const profileKey = profileKeyFromPx(derivative.width, derivative.height);
      const file = deps.localDerivativePath(productId, revision, profileKey, derivative.sha256, derivative.format);
      const facts = await deps.readImageFacts(file);
      if (facts.sha256 !== derivative.sha256) {
        throw new Error(
          `Local derivative ${profileKey} sha256 mismatch: on-disk ${facts.sha256.slice(0, 12)}… vs manifest ` +
            `${derivative.sha256.slice(0, 12)}… — the manifest and its output files are from different runs.`,
        );
      }
      if (facts.byteSize !== derivative.byteSize) {
        throw new Error(
          `Local derivative ${profileKey} byte size mismatch: on-disk ${facts.byteSize} vs manifest ${derivative.byteSize}.`,
        );
      }
      if (facts.width !== derivative.width || facts.height !== derivative.height) {
        throw new Error(
          `Local derivative ${profileKey} dimensions mismatch: on-disk ${facts.width}x${facts.height} vs manifest ` +
            `${derivative.width}x${derivative.height}.`,
        );
      }
    }
  }

  return { config, manifest };
}
