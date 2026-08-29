import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyCatalogRuntimeArtifact } from './lib/catalog-runtime-artifact';

const requiredAppPaths = [
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

const catalogDynamicRouteTemplates = [
  '/[locale]',
  '/[locale]/[slug]',
  '/[locale]/fine-art-prints',
  '/[locale]/sklep',
  '/[locale]/[slug]/[id]',
  '/[locale]/koszyk',
];

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'catalog-runtime-artifact-'));
  roots.push(root);
  return root;
}

function write(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, 'utf8');
}

function appPaths(): Record<string, string> {
  return Object.fromEntries(requiredAppPaths.map((entry) => [entry, `server${entry}.js`]));
}

function prerenderManifest(
  routes: Record<string, unknown> = { '/robots.txt': {} },
  dynamicRoutes: unknown = {},
): Record<string, unknown> {
  return { version: 4, routes, dynamicRoutes, notFoundRoutes: [] };
}

function artifactBase(root: string, artifact: 'next' | 'opennext'): string {
  return artifact === 'next'
    ? join(root, '.next')
    : join(root, '.open-next', 'server-functions', 'default', '.next');
}

function writeArtifact(
  root: string,
  artifact: 'next' | 'opennext',
  options: {
    appPaths?: Record<string, string>;
    prerender?: Record<string, unknown>;
    buildId?: string;
  } = {},
): void {
  const base = artifactBase(root, artifact);
  write(
    join(base, 'prerender-manifest.json'),
    JSON.stringify(options.prerender ?? prerenderManifest()),
  );
  write(
    join(base, 'server', 'app-paths-manifest.json'),
    JSON.stringify(options.appPaths ?? appPaths()),
  );
  write(join(base, 'BUILD_ID'), options.buildId ?? 'matching-build-id');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('catalog runtime artifact verifier', () => {
  it.each([
    ['prerender-manifest.json', 'prerender manifest'],
    [join('server', 'app-paths-manifest.json'), 'app-paths manifest'],
  ])('fails closed when the Next %s is missing', (relativePath, label) => {
    const root = tempRoot();
    writeArtifact(root, 'next');
    unlinkSync(join(artifactBase(root, 'next'), relativePath));

    expect(() => verifyCatalogRuntimeArtifact({ repositoryRoot: root, artifact: 'next' })).toThrow(
      new RegExp(`Missing required Next ${label}`),
    );
  });

  it.each([
    ['prerender-manifest.json', 'prerender manifest'],
    [join('server', 'app-paths-manifest.json'), 'app-paths manifest'],
  ])('fails closed when the copied OpenNext %s is missing', (relativePath, label) => {
    const root = tempRoot();
    writeArtifact(root, 'next');
    writeArtifact(root, 'opennext');
    unlinkSync(join(artifactBase(root, 'opennext'), relativePath));

    expect(() =>
      verifyCatalogRuntimeArtifact({ repositoryRoot: root, artifact: 'opennext' }),
    ).toThrow(new RegExp(`Missing required OpenNext ${label}`));
  });

  it.each([
    ['missing', undefined],
    ['non-object', []],
  ])('rejects a %s dynamicRoutes value', (_case, dynamicRoutes) => {
    const root = tempRoot();
    const prerender = prerenderManifest();
    if (dynamicRoutes === undefined) {
      delete prerender.dynamicRoutes;
    } else {
      prerender.dynamicRoutes = dynamicRoutes;
    }
    writeArtifact(root, 'next', { prerender });

    expect(() => verifyCatalogRuntimeArtifact({ repositoryRoot: root, artifact: 'next' })).toThrow(
      /Invalid Next prerender manifest: dynamicRoutes must be an object/,
    );
  });

  describe.each(['next', 'opennext'] as const)('%s template dynamic routes', (artifact) => {
    it.each(catalogDynamicRouteTemplates)('rejects catalog template %s', (template) => {
      const root = tempRoot();
      const unsafePrerender = prerenderManifest(
        { '/robots.txt': {} },
        { [template]: { fallback: null } },
      );

      writeArtifact(root, 'next', { prerender: unsafePrerender });
      if (artifact === 'opennext') {
        writeArtifact(root, 'opennext', { prerender: unsafePrerender });
      }

      const label = artifact === 'next' ? 'Next' : 'OpenNext';
      expect(() => verifyCatalogRuntimeArtifact({ repositoryRoot: root, artifact })).toThrow(
        `${label} artifact prerenders catalog routes: ${template}`,
      );
    });

    it('allows unrelated template routes', () => {
      const root = tempRoot();
      const unrelatedPrerender = prerenderManifest(
        { '/robots.txt': {} },
        {
          '/[locale]/gallery': { fallback: null },
          '/[locale]/konto/zamowienia/[id]': { fallback: null },
          '/admin/orders/[id]': { fallback: null },
          '/api/auth/[provider]': { fallback: null },
        },
      );

      writeArtifact(root, 'next', { prerender: unrelatedPrerender });
      if (artifact === 'opennext') {
        writeArtifact(root, 'opennext', { prerender: unrelatedPrerender });
      }

      expect(() =>
        verifyCatalogRuntimeArtifact({ repositoryRoot: root, artifact }),
      ).not.toThrow();
    });
  });

  it('rejects a catalog prerender in the Next artifact', () => {
    const root = tempRoot();
    writeArtifact(root, 'next', {
      prerender: prerenderManifest({ '/sitemap.xml': { initialRevalidateSeconds: false } }),
    });

    expect(() => verifyCatalogRuntimeArtifact({ repositoryRoot: root, artifact: 'next' })).toThrow(
      /Next artifact prerenders catalog routes: \/sitemap\.xml/,
    );
  });

  it.each([
    '/',
    '/fine-art-prints',
    '/sklep',
    '/koszyk',
    '/kubki',
    '/fine-art-prints/fap01',
    '/kubki/k01',
  ])('rejects unprefixed Polish catalog route %s', (route) => {
    const root = tempRoot();
    writeArtifact(root, 'next', {
      prerender: prerenderManifest({ [route]: { initialRevalidateSeconds: false } }),
    });

    expect(() => verifyCatalogRuntimeArtifact({ repositoryRoot: root, artifact: 'next' })).toThrow(
      `Next artifact prerenders catalog routes: ${route}`,
    );
  });

  it('rejects a catalog prerender in the final copied OpenNext artifact', () => {
    const root = tempRoot();
    writeArtifact(root, 'next');
    writeArtifact(root, 'opennext', {
      prerender: prerenderManifest({ '/pl': { initialRevalidateSeconds: false } }),
    });

    expect(() =>
      verifyCatalogRuntimeArtifact({ repositoryRoot: root, artifact: 'opennext' }),
    ).toThrow(/OpenNext artifact prerenders catalog routes: \/pl/);
  });

  it('rejects an OpenNext copy that does not match the current Next artifact', () => {
    const root = tempRoot();
    writeArtifact(root, 'next');
    writeArtifact(root, 'opennext', {
      prerender: prerenderManifest({ '/robots.txt': {}, '/pl/gallery': {} }),
    });

    expect(() =>
      verifyCatalogRuntimeArtifact({ repositoryRoot: root, artifact: 'opennext' }),
    ).toThrow(/OpenNext prerender manifest does not match the current Next artifact/);
  });

  it('accepts matching runtime-only Next and copied OpenNext artifacts', () => {
    const root = tempRoot();
    writeArtifact(root, 'next');
    writeArtifact(root, 'opennext');

    expect(() => verifyCatalogRuntimeArtifact({ repositoryRoot: root, artifact: 'next' })).not.toThrow();
    expect(() =>
      verifyCatalogRuntimeArtifact({ repositoryRoot: root, artifact: 'opennext' }),
    ).not.toThrow();
  });
});
