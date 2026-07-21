import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseScriptArgs, PRINT_ASSET_ARG_SPECS, revisionDir, ROOT } from './print-assets-cli';

describe('parseScriptArgs', () => {
  const prepareSpec = PRINT_ASSET_ARG_SPECS.prepare;

  it('parses --flag value and --flag=value strings plus boolean flags', () => {
    expect(parseScriptArgs(prepareSpec, ['--product', 'fap01', '--revision=r1', '--dry-run'])).toMatchObject({
      product: 'fap01',
      revision: 'r1',
      'dry-run': true,
    });
  });

  it('rejects the removed --source override as an unknown option', () => {
    expect(() => parseScriptArgs(prepareSpec, ['--source', '/tmp/master.jpg'])).toThrow(/Unknown option.*source/i);
  });

  it('rejects an unrecognised flag (typo)', () => {
    expect(() => parseScriptArgs(prepareSpec, ['--dryrun'])).toThrow(/Unknown option/i);
  });

  it('rejects a bare positional argument', () => {
    expect(() => parseScriptArgs(prepareSpec, ['fap01'])).toThrow();
  });

  it('rejects a string option with no value', () => {
    expect(() => parseScriptArgs(prepareSpec, ['--product'])).toThrow();
  });

  it('rejects =value on a boolean option', () => {
    expect(() => parseScriptArgs(prepareSpec, ['--dry-run=false'])).toThrow();
  });

  it('rejects the negated --no-dry-run form', () => {
    expect(() => parseScriptArgs(prepareSpec, ['--no-dry-run'])).toThrow();
  });

  it('rejects an empty --env-file value', () => {
    expect(() => parseScriptArgs(prepareSpec, ['--env-file='])).toThrow(/non-empty/i);
  });

  it('rejects --env-file supplied more than once', () => {
    expect(() => parseScriptArgs(prepareSpec, ['--env-file', 'a', '--env-file', 'b'])).toThrow(/once/i);
  });

  it('rejects a spec that declares the same name as both string and boolean', () => {
    expect(() =>
      parseScriptArgs({ strings: ['product', 'force'], booleans: ['force'] }, []),
    ).toThrow(/both string and boolean/i);
  });

  it('rejects a spec that redeclares the reserved env-file option', () => {
    expect(() => parseScriptArgs({ booleans: ['env-file'] }, [])).toThrow(/reserved/i);
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
