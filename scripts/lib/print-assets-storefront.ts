/**
 * Shared helper for storefront-facing WebP generation (gallery + mockups):
 * emit the canonical + srcset WebP set for public/uploads from a source
 * image — a resolved derivative file path or a composed mockup buffer.
 * Fulfilment-source resolution lives in `print-assets-gallery.ts`
 * (`resolveGallerySource`), which hash-verifies before returning a path.
 */
import path from 'node:path';
import sharp from 'sharp';
import { IMG_WIDTHS } from '../../src/lib/images';

export const CANONICAL_MAX_WIDTH = 1600;
export const WEBP_QUALITY = 80;

export interface WebpOutput {
  filename: string;
  localPath: string;
  r2Key: string;
  publicPath: string;
}

export async function generateWebpSet(
  source: Buffer | string,
  stem: string,
  scratchDir: string,
): Promise<WebpOutput[]> {
  const outputs: WebpOutput[] = [];

  const canonicalName = `${stem}.webp`;
  const canonicalPath = path.join(scratchDir, canonicalName);
  await sharp(source)
    .resize({ width: CANONICAL_MAX_WIDTH, withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY })
    .toFile(canonicalPath);
  outputs.push({
    filename: canonicalName,
    localPath: canonicalPath,
    r2Key: '',
    publicPath: `/uploads/${canonicalName}`,
  });

  for (const w of IMG_WIDTHS) {
    const variantName = `${stem}-${w}w.webp`;
    const variantPath = path.join(scratchDir, variantName);
    await sharp(source)
      .resize({ width: w, withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toFile(variantPath);
    outputs.push({
      filename: variantName,
      localPath: variantPath,
      r2Key: '',
      publicPath: `/uploads/${variantName}`,
    });
  }

  return outputs;
}
