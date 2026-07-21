import fs from 'node:fs';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseEnvFile, loadLocalEnv } from './script-env';
import { parseScriptArgs } from './print-assets-cli';

const ORIGINAL_ARGV = process.argv;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.argv = ORIGINAL_ARGV;
});

describe('parseEnvFile', () => {
  it('parses KEY=value pairs, stripping quotes and skipping comments/blank lines', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue('# comment\nFOO=bar\nBAZ="quoted"\n\nQUX=\'single\'\n');
    expect(parseEnvFile('/fake/.env')).toEqual({ FOO: 'bar', BAZ: 'quoted', QUX: 'single' });
  });

  it('returns {} when the file does not exist', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    expect(parseEnvFile('/fake/.env')).toEqual({});
  });
});

describe('loadLocalEnv', () => {
  /** `.dev.vars`/`.env.local`/an explicit `--env-file` target keyed by their (relative) path, as script-env.ts reads them. */
  function mockFiles(files: Record<string, string>): void {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => Object.hasOwn(files, String(p)));
    vi.spyOn(fs, 'readFileSync').mockImplementation((p) => files[String(p)] ?? '');
  }

  it('layers .env.local < .dev.vars < --env-file < process.env (later wins)', () => {
    mockFiles({
      '.env.local': 'PRINT_ASSETS_BUCKET=local-bucket\nA=local\n',
      '.dev.vars': 'PRINT_ASSETS_BUCKET=dev-bucket\nB=dev\n',
      'staging.env': 'PRINT_ASSETS_BUCKET=staging-bucket\n',
    });
    process.argv = [ORIGINAL_ARGV[0], ORIGINAL_ARGV[1], '--env-file', 'staging.env'];

    const env = loadLocalEnv();
    expect(env.PRINT_ASSETS_BUCKET).toBe('staging-bucket');
    expect(env.A).toBe('local');
    expect(env.B).toBe('dev');
  });

  it('also accepts the --env-file=<path> form', () => {
    mockFiles({ 'staging.env': 'PRINT_ASSETS_BUCKET=staging-bucket\n' });
    process.argv = [ORIGINAL_ARGV[0], ORIGINAL_ARGV[1], '--env-file=staging.env'];

    expect(loadLocalEnv().PRINT_ASSETS_BUCKET).toBe('staging-bucket');
  });

  it('falls back to .dev.vars when no --env-file is passed (the bug this closes: a staging override must not be ignored)', () => {
    mockFiles({ '.dev.vars': 'PRINT_ASSETS_BUCKET=dev-bucket\n' });
    process.argv = [ORIGINAL_ARGV[0], ORIGINAL_ARGV[1]];

    expect(loadLocalEnv().PRINT_ASSETS_BUCKET).toBe('dev-bucket');
  });

  it('lets process.env override every file-based source', () => {
    mockFiles({ '.dev.vars': 'PRINT_ASSETS_BUCKET=dev-bucket\n' });
    process.argv = [ORIGINAL_ARGV[0], ORIGINAL_ARGV[1]];
    vi.stubEnv('PRINT_ASSETS_BUCKET', 'env-var-bucket');

    expect(loadLocalEnv().PRINT_ASSETS_BUCKET).toBe('env-var-bucket');
  });

  it('parseScriptArgs and loadLocalEnv resolve the same explicit --env-file, and both reject duplicates', () => {
    mockFiles({ 'staging.env': 'PRINT_ASSETS_BUCKET=staging-bucket\n' });
    process.argv = [ORIGINAL_ARGV[0], ORIGINAL_ARGV[1], '--env-file', 'staging.env'];

    expect(parseScriptArgs({ strings: ['product'] })['env-file']).toBe('staging.env');
    expect(loadLocalEnv().PRINT_ASSETS_BUCKET).toBe('staging-bucket');

    process.argv = [ORIGINAL_ARGV[0], ORIGINAL_ARGV[1], '--env-file', 'a', '--env-file', 'b'];
    expect(() => parseScriptArgs({ strings: ['product'] })).toThrow(/once/i);
    expect(() => loadLocalEnv()).toThrow(/once/i);
  });
});
