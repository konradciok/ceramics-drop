import { describe, it, expect } from 'vitest';
import { classifyR2GetFailure, resolveBucketName } from './r2';

describe('classifyR2GetFailure', () => {
  it('treats R2 NoSuchKey / not-found messages as a definitively absent object', () => {
    expect(classifyR2GetFailure('The specified key does not exist.')).toBe('absent');
    expect(classifyR2GetFailure('Object not found')).toBe('absent');
    expect(classifyR2GetFailure('NoSuchKey: the object was not found')).toBe('absent');
    expect(classifyR2GetFailure('HTTP 404')).toBe('absent');
    expect(classifyR2GetFailure('R2 error 10007')).toBe('absent');
  });

  it('treats auth / network / throttling faults as errors (upload must fail closed, not put)', () => {
    expect(classifyR2GetFailure('Authentication error [code: 10000]')).toBe('error');
    expect(classifyR2GetFailure('fetch failed: ECONNRESET')).toBe('error');
    expect(classifyR2GetFailure('You need to login first')).toBe('error');
    expect(classifyR2GetFailure('exit null')).toBe('error');
  });
});

describe('resolveBucketName', () => {
  it('defaults to the wrangler.jsonc binding bucket name', () => {
    expect(resolveBucketName({})).toBe('anna-ciok-print-assets');
  });

  it('honours a PRINT_ASSETS_BUCKET override from the merged env stack (e.g. .dev.vars)', () => {
    expect(resolveBucketName({ PRINT_ASSETS_BUCKET: 'anna-ciok-print-assets-staging' })).toBe(
      'anna-ciok-print-assets-staging',
    );
  });
});
