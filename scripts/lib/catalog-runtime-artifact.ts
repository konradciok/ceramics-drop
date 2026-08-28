import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export type CatalogRuntimeArtifact = 'next' | 'opennext';

type ManifestSet = {
  appPaths: Record<string, string>;
  prerender: {
    routes: Record<string, unknown>;
    dynamicRoutes: Record<string, unknown>;
  };
  buildId: string;
};

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
const catalogPrerenderTemplates = new Set([
  '/[locale]',
  '/[locale]/[slug]',
  '/[locale]/fine-art-prints',
  '/[locale]/sklep',
  '/[locale]/[slug]/[id]',
  '/[locale]/koszyk',
]);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function artifactBase(repositoryRoot: string, artifact: CatalogRuntimeArtifact): string {
  return artifact === 'next'
    ? join(repositoryRoot, '.next')
    : join(repositoryRoot, '.open-next', 'server-functions', 'default', '.next');
}

function readRequired(path: string, artifactLabel: string, fileLabel: string): string {
  if (!existsSync(path)) {
    throw new Error(`Missing required ${artifactLabel} ${fileLabel}: ${path}`);
  }
  return readFileSync(path, 'utf8');
}

function readManifestSet(
  repositoryRoot: string,
  artifact: CatalogRuntimeArtifact,
): ManifestSet {
  const label = artifact === 'next' ? 'Next' : 'OpenNext';
  const base = artifactBase(repositoryRoot, artifact);
  const prerenderText = readRequired(
    join(base, 'prerender-manifest.json'),
    label,
    'prerender manifest',
  );
  const appPathsText = readRequired(
    join(base, 'server', 'app-paths-manifest.json'),
    label,
    'app-paths manifest',
  );
  const buildId = readRequired(join(base, 'BUILD_ID'), label, 'build ID').trim();
  const prerenderValue: unknown = JSON.parse(prerenderText);
  const appPathsValue: unknown = JSON.parse(appPathsText);

  if (!isRecord(prerenderValue) || !isRecord(prerenderValue.routes)) {
    throw new Error(`Invalid ${label} prerender manifest: routes must be an object`);
  }
  if (!isRecord(prerenderValue.dynamicRoutes)) {
    throw new Error(`Invalid ${label} prerender manifest: dynamicRoutes must be an object`);
  }
  if (!isRecord(appPathsValue)) {
    throw new Error(`Invalid ${label} app-paths manifest: expected an object`);
  }

  return {
    appPaths: appPathsValue as Record<string, string>,
    prerender: {
      routes: prerenderValue.routes,
      dynamicRoutes: prerenderValue.dynamicRoutes,
    },
    buildId,
  };
}

function verifyManifestSet(manifests: ManifestSet, artifact: CatalogRuntimeArtifact): void {
  const label = artifact === 'next' ? 'Next' : 'OpenNext';
  const missingEntries = catalogAppEntries.filter((entry) => !(entry in manifests.appPaths));
  if (missingEntries.length > 0) {
    throw new Error(`${label} app-paths manifest misses catalog entries: ${missingEntries.join(', ')}`);
  }

  const prerenderedCatalogRoutes = [
    ...Object.keys(manifests.prerender.routes),
    ...Object.keys(manifests.prerender.dynamicRoutes),
  ]
    .filter(
      (route) =>
        catalogPrerenderTemplates.has(route) ||
        catalogPrerenderPatterns.some((pattern) => pattern.test(route)),
    )
    .sort();
  if (prerenderedCatalogRoutes.length > 0) {
    throw new Error(
      `${label} artifact prerenders catalog routes: ${prerenderedCatalogRoutes.join(', ')}`,
    );
  }
}

export function verifyCatalogRuntimeArtifact(options: {
  repositoryRoot: string;
  artifact: CatalogRuntimeArtifact;
}): void {
  const manifests = readManifestSet(options.repositoryRoot, options.artifact);
  verifyManifestSet(manifests, options.artifact);

  if (options.artifact === 'opennext') {
    const nextManifests = readManifestSet(options.repositoryRoot, 'next');
    if (!isDeepStrictEqual(manifests.prerender, nextManifests.prerender)) {
      throw new Error('OpenNext prerender manifest does not match the current Next artifact');
    }
    if (!isDeepStrictEqual(manifests.appPaths, nextManifests.appPaths)) {
      throw new Error('OpenNext app-paths manifest does not match the current Next artifact');
    }
    if (manifests.buildId !== nextManifests.buildId) {
      throw new Error('OpenNext build ID does not match the current Next artifact');
    }
  }
}
