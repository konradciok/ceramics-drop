import { describe, it, expect } from 'vitest';
import { resolveCartLines } from './cart-lines';

describe('resolveCartLines', () => {
  it('resolves a mixed cart preserving order', () => {
    const lines = resolveCartLines(['k01', 'print:fap01:a3:satin:oak']);
    expect(lines.map((l) => l.kind)).toEqual(['ceramic', 'print']);
    expect(lines[0]).toMatchObject({ kind: 'ceramic', id: 'k01' });
    expect(lines[1]).toMatchObject({
      kind: 'print',
      id: 'print:fap01:a3:satin:oak',
      sel: { size: 'a3', paper: 'satin', frame: 'oak' },
    });
    if (lines[1].kind === 'print') expect(lines[1].design.id).toBe('fap01');
  });

  it('keeps two distinct variants of the same design as separate lines', () => {
    const lines = resolveCartLines(['print:fap01:a4:matte:none', 'print:fap01:a3:matte:none']);
    expect(lines).toHaveLength(2);
  });

  it('dedupes identical entries', () => {
    expect(resolveCartLines(['k01', 'k01'])).toHaveLength(1);
    expect(resolveCartLines(['print:fap01:a3:satin:oak', 'print:fap01:a3:satin:oak'])).toHaveLength(1);
  });

  it('drops unknown ids, malformed tokens, and unavailable/unpublished prints', () => {
    expect(resolveCartLines(['nope'])).toHaveLength(0);
    expect(resolveCartLines(['print:fap01:a3:satin'])).toHaveLength(0); // malformed
    expect(resolveCartLines(['print:nope:a3:satin:oak'])).toHaveLength(0); // unknown design
    expect(resolveCartLines(['print:fap03:a3:satin:oak'])).toHaveLength(0); // unpublished
    expect(resolveCartLines(['print:fap02:a3:satin:black'])).toHaveLength(0); // excluded combo
  });
});
