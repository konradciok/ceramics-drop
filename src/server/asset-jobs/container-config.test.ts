import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { CONTAINER_PORT } from './container-protocol';

/**
 * Static guards for the Cloudflare Container wiring (Priority 8 / Phase 3).
 *
 * NOTHING about a deployed Container's behaviour can be verified without a real
 * Cloudflare account, so what IS verifiable is the wiring: that the config, the
 * image, the exported Durable Object class and the code constants all agree
 * with each other, and that the Sharp boundary is not breached. Every
 * assertion here is a real failure mode we would otherwise only discover at
 * `wrangler deploy` time (or, worse, at runtime).
 */

const root = (rel: string) => new URL(`../../../${rel}`, import.meta.url);
const read = (rel: string) => readFileSync(root(rel), 'utf8');

/**
 * Minimal JSONC → JSON. A naive comment-strip would corrupt `//` inside string
 * values, so this scans character by character and only strips comments found
 * outside a string literal.
 */
function parseJsonc<T>(source: string): T {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    out += ch;
  }
  return JSON.parse(out) as T;
}

type ContainerEntry = {
  class_name: string;
  name?: string;
  image: string;
  image_build_context?: string;
  instance_type?: string;
  max_instances?: number;
};
type WranglerConfig = {
  containers?: ContainerEntry[];
  durable_objects?: { bindings: { name: string; class_name: string }[] };
  migrations?: { tag: string; new_sqlite_classes?: string[]; new_classes?: string[] }[];
  env?: Record<string, Omit<WranglerConfig, 'env'>>;
};

const wrangler = parseJsonc<WranglerConfig>(read('wrangler.jsonc'));
const rootPkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
const containerPkg = JSON.parse(read('container/package.json')) as { dependencies: Record<string, string> };
const dockerfile = read('container/Dockerfile');
const workerSource = read('worker.ts');

describe('wrangler container binding', () => {
  const entry = wrangler.containers?.[0];

  it('declares exactly one container', () => {
    expect(wrangler.containers).toHaveLength(1);
  });

  it('is a standard-3 instance capped at one instance (master plan §S3: 8 GiB, one job at a time)', () => {
    expect(entry?.instance_type).toBe('standard-3');
    expect(entry?.max_instances).toBe(1);
  });

  it('builds the image from container/Dockerfile with the REPO ROOT as build context', () => {
    // The image runs this repo's own src/lib + src/server sources, so the
    // context cannot default to the Dockerfile's own directory.
    expect(entry?.image).toBe('./container/Dockerfile');
    expect(entry?.image_build_context).toBe('.');
  });

  // A container APPLICATION name is ACCOUNT-scoped, not per-Worker: wrangler's
  // deploy path looks an existing application up by name and throws when it
  // finds one bound to a different Durable Object namespace. Two environments
  // sharing one hardcoded name therefore hard-fail whichever deploys second —
  // exactly the "deploy to preview first" sequence this change recommends.
  //
  // (It is also NOT the same namespace as PRINT_ASSET_PROCESSOR_NAME, which is a
  // Durable Object INSTANCE id passed to getByName(). An earlier version of this
  // file asserted the two were equal; they are unrelated, and wrangler's derived
  // default makes them unequal anyway.)
  it('production and preview do not share a container application name', () => {
    const prod = wrangler.containers?.[0].name;
    const preview = wrangler.env?.preview?.containers?.[0].name;
    if (prod === undefined && preview === undefined) return; // both derived — distinct by construction
    expect(prod, 'if one environment names its container application, both must').toBeDefined();
    expect(preview, 'if one environment names its container application, both must').toBeDefined();
    expect(prod).not.toBe(preview);
  });

  it('omits `name` entirely so wrangler derives a per-environment default', () => {
    // `${workerName}-${class_name}`, and workerName already carries the env
    // suffix for a named environment. Documented here so a future "tidy-up"
    // that adds a shared name back is caught by the test above too.
    expect(wrangler.containers?.[0].name).toBeUndefined();
    expect(wrangler.env?.preview?.containers?.[0].name).toBeUndefined();
  });
});

describe('wrangler config schema (validated against the PINNED wrangler version)', () => {
  // This is the one piece of the Container wiring that can be checked against
  // an authority rather than against my reading of the docs: wrangler ships its
  // own JSON schema, so the key names and the instance-type name are verified
  // against the exact wrangler this repo installs. If a wrangler bump renames
  // or drops any of them, this fails here instead of at deploy time.
  const schema = JSON.parse(read('node_modules/wrangler/config-schema.json')) as {
    definitions: Record<string, { properties?: Record<string, unknown>; additionalProperties?: boolean }>;
  };
  const containerApp = schema.definitions.ContainerApp;

  it('every key used in the container entry exists in wrangler\'s own ContainerApp schema', () => {
    expect(containerApp, 'wrangler no longer defines ContainerApp').toBeTruthy();
    expect(containerApp.additionalProperties).toBe(false);
    const allowed = Object.keys(containerApp.properties ?? {});
    for (const key of Object.keys(wrangler.containers![0])) {
      expect(allowed, `wrangler's ContainerApp has no "${key}"`).toContain(key);
    }
  });

  it('"standard-3" is an instance type this wrangler accepts', () => {
    const instanceType = JSON.stringify((containerApp.properties ?? {}).instance_type);
    expect(instanceType).toContain('"standard-3"');
  });

  it('`containers` is declared on RawEnvironment — i.e. it is not inherited, so preview must repeat it', () => {
    expect(Object.keys(schema.definitions.RawEnvironment.properties ?? {})).toContain('containers');
  });
});

describe('wrangler durable-object wiring (a container is backed by a DO)', () => {
  it('binds PRINT_ASSET_PROCESSOR to the container class', () => {
    expect(wrangler.durable_objects?.bindings).toEqual([
      { name: 'PRINT_ASSET_PROCESSOR', class_name: 'PrintAssetProcessor' },
    ]);
    expect(wrangler.containers?.[0].class_name).toBe('PrintAssetProcessor');
  });

  it('registers the class with the SQLite storage backend (containers require new_sqlite_classes, not new_classes)', () => {
    const classes = (wrangler.migrations ?? []).flatMap((m) => m.new_sqlite_classes ?? []);
    expect(classes).toContain('PrintAssetProcessor');
    for (const migration of wrangler.migrations ?? []) {
      expect(migration.new_classes ?? []).not.toContain('PrintAssetProcessor');
    }
  });

  it('exports the class from worker.ts — without this the binding cannot resolve at deploy time', () => {
    expect(workerSource).toMatch(/export \{ PrintAssetProcessor \} from '\.\/src\/server\/asset-jobs\/container'/);
  });
});

describe('preview environment', () => {
  const preview = wrangler.env?.preview;

  it('repeats containers + durable_objects (both are NON-inheritable wrangler keys)', () => {
    expect(preview?.containers?.[0]).toMatchObject({
      class_name: 'PrintAssetProcessor',
      instance_type: 'standard-3',
      max_instances: 1,
    });
    expect(preview?.durable_objects?.bindings).toEqual([
      { name: 'PRINT_ASSET_PROCESSOR', class_name: 'PrintAssetProcessor' },
    ]);
  });

  it('does not redeclare migrations (that key IS inherited — a second copy would be a second history)', () => {
    expect(preview?.migrations).toBeUndefined();
  });
});

describe('container image', () => {
  it('pins linux/amd64, the only architecture Cloudflare Containers run', () => {
    expect(dockerfile).toMatch(/^FROM --platform=linux\/amd64 /m);
  });

  it('exposes and serves the port the protocol module addresses', () => {
    expect(dockerfile).toMatch(new RegExp(`^EXPOSE ${CONTAINER_PORT}$`, 'm'));
    expect(dockerfile).toMatch(new RegExp(`^ENV PORT=${CONTAINER_PORT}$`, 'm'));
  });

  it('copies the two source trees its entry point imports, and not the Next.js app', () => {
    expect(dockerfile).toMatch(/^COPY src\/lib \.\/src\/lib$/m);
    expect(dockerfile).toMatch(/^COPY src\/server \.\/src\/server$/m);
    expect(dockerfile).not.toMatch(/^COPY src\/app/m);
  });

  it.each(['sharp', 'tsx', 'zod'])(
    'pins %s to the SAME range as the root package.json — the image runs the repo source against it',
    (dep) => {
      const rootRange = rootPkg.dependencies[dep] ?? rootPkg.devDependencies[dep];
      expect(rootRange, `${dep} must exist in the root package.json`).toBeTruthy();
      expect(containerPkg.dependencies[dep]).toBe(rootRange);
    },
  );

  it('installs nothing beyond those three (the image must not drag in the Next.js app)', () => {
    expect(Object.keys(containerPkg.dependencies).sort()).toEqual(['sharp', 'tsx', 'zod']);
  });
});

describe('Sharp boundary (TRANSITIVE — walks the whole first-party import graph)', () => {
  const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

  /**
   * Resolve one import specifier to a repo-relative `.ts` path, or null for a
   * bare package (which is checked by name instead) or an unresolvable path.
   * Handles the two forms this codebase uses: the `@/…` alias (→ `src/…`) and
   * relative paths. Both `x.ts` and `x/index.ts` are tried.
   */
  function resolveSpecifier(fromRel: string, specifier: string): string | null {
    let base: string;
    if (specifier.startsWith('@/')) base = path.join('src', specifier.slice(2));
    else if (specifier.startsWith('.')) base = path.posix.join(path.posix.dirname(fromRel), specifier);
    else return null; // bare package — matched by name, not resolved
    const normalized = base.split(path.sep).join('/').replace(/\.(ts|tsx|js)$/, '');
    for (const candidate of [`${normalized}.ts`, `${normalized}/index.ts`]) {
      if (existsSync(path.join(ROOT, candidate))) return candidate;
    }
    return null;
  }

  /**
   * Every first-party module reachable from `entry`, plus every bare package
   * specifier seen anywhere in that graph. VALUE edges only: `import type` /
   * `export type` are erased by the bundler and can never drag a native addon
   * into the Workers isolate.
   *
   * BOTH `import … from` and `export … from` are followed. A re-export is a
   * real bundler edge — `src/server/asset-jobs/container.ts`'s
   * `export { PRINT_ASSET_PROCESSOR_NAME } from './container-names';` pulls
   * that module in exactly like an import would — so a walker that only
   * followed `import` would silently under-report the graph it claims to cover
   * and could pass vacuously on a barrel-shaped tree.
   */
  function importGraph(entry: string): { modules: Set<string>; packages: Set<string>; edges: Map<string, string> } {
    const modules = new Set<string>();
    const packages = new Set<string>();
    const edges = new Map<string, string>(); // module → the module that imported it
    const queue = [entry];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (modules.has(current)) continue;
      modules.add(current);
      const source = read(current);
      // Three alternatives: (1) `import/export … from '…'` (named/namespace/
      // re-export — has a `clause` to type-check), (2) a bare side-effect
      // import `import '…'` (no clause, no binding), (3) a literal dynamic
      // `import('…')` (also no clause). A regex that only matched (1) missed
      // (2) and (3) entirely — either form can drag `sharp` or another
      // Sharp-reaching module into the Worker bundle without this walker
      // noticing, since esbuild bundles a statically-analyzable `import()`
      // just like a static import.
      const EDGE_RE =
        /^\s*(?:import|export)\s+([^;]*?)\s*from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm;
      for (const match of source.matchAll(EDGE_RE)) {
        const [, clause, fromSpec, sideEffectSpec, dynamicSpec] = match;
        const specifier = fromSpec ?? sideEffectSpec ?? dynamicSpec;
        if (specifier === undefined) continue; // defensive; one of the three alternatives always captures
        // `import type … from` / `export type … from` — erased by the bundler.
        // Only alternative (1) ever has a clause to check; (2)/(3) have none.
        if (clause !== undefined && /^type\b/.test(clause.trim())) continue;
        const resolved = resolveSpecifier(current, specifier);
        if (resolved === null) {
          packages.add(specifier);
          if (!edges.has(specifier)) edges.set(specifier, current);
          continue;
        }
        if (!edges.has(resolved)) edges.set(resolved, current);
        queue.push(resolved);
      }
    }
    return { modules, packages, edges };
  }

  const FORBIDDEN_MODULES = ['src/server/print-assets/derivatives.ts', 'src/server/print-assets/container-handler.ts'];
  const FORBIDDEN_PACKAGES = ['sharp'];

  // The whole point of the container is that the Workers isolate never touches
  // Sharp. These modules are bundled into worker.ts; ONE import of a
  // Sharp-reaching module — direct or six hops down through `@/lib/*` — breaks
  // the deployment at runtime, not at build. A direct-import regex would miss
  // the indirect route entirely, so this walks the graph.
  //
  // The first two entries are the REAL deployed-bundle roots — `worker.ts` is
  // the Worker entry point wrangler bundles, and `src/server/cms-api/entrypoint.ts`
  // roots the whole CmsApi handler tree it mounts. Guarding only the
  // asset-jobs/* modules below would leave every one of those handlers free to
  // pull Sharp in from the side; anything bundled at all is reachable from one
  // of these two.
  it.each([
    'worker.ts',
    'src/server/cms-api/entrypoint.ts',
    'src/server/asset-jobs/process-job.ts',
    'src/server/asset-jobs/container-render.ts',
    'src/server/asset-jobs/container-protocol.ts',
    'src/server/asset-jobs/profiles.ts',
    'src/server/asset-jobs/container.ts',
  ])('nothing reachable from %s reaches Sharp, at any depth', (rel) => {
    const { modules, packages, edges } = importGraph(rel);
    for (const forbidden of FORBIDDEN_MODULES) {
      expect(
        modules.has(forbidden),
        `${rel} reaches ${forbidden} (via ${edges.get(forbidden) ?? '?'}) — Sharp cannot run in the Workers V8 isolate`,
      ).toBe(false);
    }
    for (const forbidden of FORBIDDEN_PACKAGES) {
      expect(
        packages.has(forbidden),
        `${rel} reaches the "${forbidden}" package (via ${edges.get(forbidden) ?? '?'}) — it is a native Node addon`,
      ).toBe(false);
    }
  });

  it('the walker actually detects a transitive reach (guard against a vacuous pass)', () => {
    // container/server.ts → src/server/print-assets/container-handler.ts → sharp.
    // If this stops failing the way it should, the walker above is broken and
    // its green results mean nothing.
    const { modules, packages } = importGraph('container/server.ts');
    expect(modules.has('src/server/print-assets/container-handler.ts')).toBe(true);
    expect(modules.has('src/server/print-assets/derivatives.ts')).toBe(true); // one hop deeper
    expect(packages.has('sharp')).toBe(true);
  });

  it('the walker follows `export … from` re-exports, not just `import … from`', () => {
    // container.ts reaches container-names.ts ONLY through
    // `export { PRINT_ASSET_PROCESSOR_NAME } from './container-names';`. If
    // this regresses, every barrel/re-export hop above goes unwalked and the
    // green results there are worth less than they look.
    expect(read('src/server/asset-jobs/container.ts')).toMatch(
      /^\s*export\s+\{[^}]*\}\s*from\s+'\.\/container-names'/m,
    );
    expect(importGraph('src/server/asset-jobs/container.ts').modules).toContain(
      'src/server/asset-jobs/container-names.ts',
    );
  });

  it('the container entry point is the ONLY place that reaches the Sharp render handler', () => {
    expect(read('container/server.ts')).toContain('src/server/print-assets/container-handler');
  });

  it('detects a bare side-effect import (`import "sharp"`, no bindings) — the form a from-clause-only regex would miss', () => {
    const { packages } = importGraph('src/server/asset-jobs/__fixtures__/sharp-side-effect-import.ts');
    expect(packages.has('sharp')).toBe(true);
  });

  it('detects a literal dynamic import (`import("sharp")`) — esbuild bundles it just like a static import', () => {
    const { packages } = importGraph('src/server/asset-jobs/__fixtures__/sharp-dynamic-import.ts');
    expect(packages.has('sharp')).toBe(true);
  });
});
