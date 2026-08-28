import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const prerenderManifestUrl = new URL('../.next/prerender-manifest.json', import.meta.url);
const appPathsManifestUrl = new URL('../.next/server/app-paths-manifest.json', import.meta.url);
const buildExists = existsSync(prerenderManifestUrl) && existsSync(appPathsManifestUrl);
const buildRequired = process.env.CATALOG_RUNTIME_BUILD_REQUIRED === '1';

type PrerenderManifest = {
  routes: Record<string, unknown>;
};

type AppPathsManifest = Record<string, string>;

const catalogAppEntries = [
  '/[locale]/page',
  '/[locale]/(collections)/[slug]/page',
  '/[locale]/(collections)/fine-art-prints/page',
  '/[locale]/(collections)/sklep/page',
  '/[locale]/(pdp)/[slug]/[id]/page',
  '/[locale]/koszyk/page',
  '/api/feed/google/route',
  '/api/feed/meta/route',
  '/sitemap.xml/route',
];

const localeSegment = '(?:pl|en|es|de)';
const ceramicSegment =
  '(?:kubki|wazony|wazony-srednie|wazony-duze|talerzyki|talerze-srednie|talerze-duze|duze-michy|miski-falowane)';
const catalogPrerenderPatterns = [
  new RegExp(`^/${localeSegment}$`),
  new RegExp(`^/${localeSegment}/fine-art-prints$`),
  new RegExp(`^/${localeSegment}/sklep$`),
  new RegExp(`^/${localeSegment}/koszyk$`),
  new RegExp(`^/${localeSegment}/${ceramicSegment}$`),
  new RegExp(`^/${localeSegment}/(?:fine-art-prints|${ceramicSegment})/[^/]+$`),
  /^\/api\/feed\/(?:google|meta)$/,
  /^\/sitemap\.xml$/,
];

describe.skipIf(!buildExists && !buildRequired)('catalog runtime route build contract', () => {
  it('keeps every catalog-consuming public route out of immutable prerender output', () => {
    expect(existsSync(prerenderManifestUrl), 'run `npm run build` before this check').toBe(true);
    expect(existsSync(appPathsManifestUrl), 'run `npm run build` before this check').toBe(true);
    if (!buildExists) return;

    const prerenderManifest = JSON.parse(
      readFileSync(prerenderManifestUrl, 'utf8'),
    ) as PrerenderManifest;
    const appPathsManifest = JSON.parse(
      readFileSync(appPathsManifestUrl, 'utf8'),
    ) as AppPathsManifest;

    expect(catalogAppEntries.filter((entry) => !(entry in appPathsManifest))).toEqual([]);

    const prerenderedCatalogRoutes = Object.keys(prerenderManifest.routes)
      .filter((route) => catalogPrerenderPatterns.some((pattern) => pattern.test(route)))
      .sort();

    expect(prerenderedCatalogRoutes).toEqual([]);
  });
});
