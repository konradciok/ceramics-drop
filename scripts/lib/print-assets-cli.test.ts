import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { getArg, hasFlag, revisionDir, ROOT } from './print-assets-cli';

const ORIGINAL_ARGV = process.argv;

/** Run `fn` with `process.argv` set to `[node, script, ...args]`, always restoring the original argv after. */
function withArgv<T>(args: string[], fn: () => T): T {
  process.argv = [ORIGINAL_ARGV[0], ORIGINAL_ARGV[1], ...args];
  try {
    return fn();
  } finally {
    process.argv = ORIGINAL_ARGV;
  }
}

describe('getArg', () => {
  it('reads the `--flag value` form', () => {
    withArgv(['--product', 'fap01'], () => {
      expect(getArg('product')).toBe('fap01');
    });
  });

  it('reads the `--flag=value` form, including a value that itself starts with --', () => {
    withArgv(['--product=--fap01'], () => {
      expect(getArg('product')).toBe('--fap01');
    });
  });

  it('returns undefined when the flag is absent', () => {
    withArgv(['--revision', 'r1'], () => {
      expect(getArg('product')).toBeUndefined();
    });
  });

  it('throws when the flag has no following token', () => {
    withArgv(['--product'], () => {
      expect(() => getArg('product')).toThrow(/Missing value for --product/);
    });
  });

  it("throws rather than swallow the next flag as this one's value", () => {
    withArgv(['--product', '--revision', 'r1'], () => {
      expect(() => getArg('product')).toThrow(/Missing value for --product/);
    });
  });
});

describe('hasFlag', () => {
  it('detects a bare flag', () => {
    withArgv(['--dry-run'], () => {
      expect(hasFlag('dry-run')).toBe(true);
    });
  });

  it('is false when the flag is absent', () => {
    withArgv(['--product', 'fap01'], () => {
      expect(hasFlag('dry-run')).toBe(false);
    });
  });
});

describe('revisionDir', () => {
  it('joins valid product/revision segments under design/print-assets', () => {
    const dir = revisionDir('fap01', '2026-07-11-r1');
    expect(dir).toBe(path.join(ROOT, 'design', 'print-assets', 'fap01', '2026-07-11-r1'));
  });

  it.each([
    ['../etc', 'r1'],
    ['fap01', '../../etc'],
    ['fap01', 'r1/../../etc'],
    ['fap01', '..'],
    ['', 'r1'],
    ['fap01', ''],
    ['fap01/x', 'r1'],
    ['fap01', 'r1\\x'],
  ])('rejects a traversal/invalid segment (product=%j, revision=%j)', (product, revision) => {
    expect(() => revisionDir(product, revision)).toThrow();
  });
});
