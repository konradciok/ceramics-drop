import { describe, it, expect } from 'vitest';
import { releaseTargetStatus } from './piece-release';

describe('releaseTargetStatus', () => {
  it('normal order (no private_sale_id) → pieces relist as available', () => {
    expect(releaseTargetStatus({ private_sale_id: null })).toBe('available');
  });

  it('private-sale order → pieces return to/stay sold (never relisted publicly)', () => {
    expect(releaseTargetStatus({ private_sale_id: 'ps_123' })).toBe('sold');
  });

  it('missing private_sale_id field → treated as a normal order', () => {
    expect(releaseTargetStatus({})).toBe('available');
  });

  it('undefined private_sale_id → available', () => {
    expect(releaseTargetStatus({ private_sale_id: undefined })).toBe('available');
  });
});
