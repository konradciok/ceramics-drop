/**
 * Shared CLI plumbing for the Phase 2b print-asset operator scripts
 * (upload / verify / publish): arg parsing and loading the `manifest.json`
 * that Phase 2a's `prepare` wrote.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { PrepareManifest } from '../../src/lib/print-assets-prepare';

export const ROOT = path.resolve(__dirname, '..', '..');

/** `--flag value` or `--flag=value`; mirrors print-assets-prepare.ts. */
export function getArg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === `--${name}`) return argv[i + 1];
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return undefined;
}

export function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

/** Absolute path to a revision's local output directory (gitignored `design/` tree). */
export function revisionDir(productId: string, revision: string): string {
  return path.join(ROOT, 'design', 'print-assets', productId, revision);
}

/**
 * Load + validate the manifest `prepare` wrote for (product, revision). Fails
 * loudly when it is missing (prepare not run) or its embedded product/revision
 * disagree with the requested ones — the manifest is the contract every later
 * phase reads, so a mismatch must never be papered over.
 */
export function loadManifest(productId: string, revision: string): PrepareManifest {
  const manifestPath = path.join(revisionDir(productId, revision), 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `No manifest at ${path.relative(ROOT, manifestPath)}. Run print-assets:prepare for ` +
        `${productId} @ ${revision} first.`,
    );
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as PrepareManifest;
  if (manifest.product !== productId || manifest.revision !== revision) {
    throw new Error(
      `Manifest at ${path.relative(ROOT, manifestPath)} declares ${manifest.product}@${manifest.revision}, ` +
        `expected ${productId}@${revision}.`,
    );
  }
  if (!Array.isArray(manifest.derivatives) || manifest.derivatives.length === 0) {
    throw new Error(`Manifest for ${productId}@${revision} has no derivatives.`);
  }
  return manifest;
}

/** Absolute path to a derivative's local file (as `prepare` named it). */
export function localDerivativePath(
  productId: string,
  revision: string,
  profileKey: string,
  sha256: string,
  format: string,
): string {
  return path.join(revisionDir(productId, revision), `${profileKey}-${sha256}.${format}`);
}
