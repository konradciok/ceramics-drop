import { describe, it, expect } from 'vitest';
import { parseGaClientId, parseGaSessionId } from './context';

describe('parseGaClientId', () => {
  it('extracts the client id from a _ga cookie', () => {
    expect(parseGaClientId('GA1.1.1234567890.1680000000')).toBe('1234567890.1680000000');
  });
  it('returns null for malformed or missing cookies', () => {
    expect(parseGaClientId(null)).toBeNull();
    expect(parseGaClientId('GA1.1')).toBeNull();
  });
});

describe('parseGaSessionId', () => {
  it('extracts the session id from a _ga_<id> cookie', () => {
    expect(parseGaSessionId('GS1.1.1680000300.1.1.1680000600.0.0.0')).toBe('1680000300');
  });
  it('returns null for malformed or missing cookies', () => {
    expect(parseGaSessionId(null)).toBeNull();
    expect(parseGaSessionId('GS1.1')).toBeNull();
  });
});
