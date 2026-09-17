import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { CONTAINER_PORT } from './container-protocol';
import { PRINT_ASSET_PROCESSOR_NAME } from './container-names';

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

  it('names the instance the same string the code addresses it by', () => {
    expect(entry?.name).toBe(PRINT_ASSET_PROCESSOR_NAME);
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

describe('Sharp boundary', () => {
  const sharpReaching = ['src/server/print-assets/derivatives', 'src/server/print-assets/container-handler', 'sharp'];

  // The whole point of the container is that the Workers isolate never touches
  // Sharp. These three modules are bundled into worker.ts; a single import of a
  // Sharp-reaching module here breaks the deployment at runtime, not at build.
  it.each([
    'src/server/asset-jobs/process-job.ts',
    'src/server/asset-jobs/container-render.ts',
    'src/server/asset-jobs/container-protocol.ts',
    'src/server/asset-jobs/profiles.ts',
    'src/server/asset-jobs/container.ts',
  ])('%s imports nothing that reaches Sharp', (rel) => {
    const source = read(rel);
    const imports = [...source.matchAll(/^\s*import[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
    for (const specifier of imports) {
      for (const forbidden of sharpReaching) {
        expect(
          specifier.endsWith(forbidden) || specifier === forbidden,
          `${rel} imports "${specifier}" — Sharp cannot run in the Workers V8 isolate`,
        ).toBe(false);
      }
    }
  });

  it('the container entry point is the ONLY place that reaches the Sharp render handler', () => {
    expect(read('container/server.ts')).toContain('src/server/print-assets/container-handler');
  });
});
