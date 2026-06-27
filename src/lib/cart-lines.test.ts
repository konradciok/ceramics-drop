import { describe, it, expect } from 'vitest';
import { resolveCartLines } from './cart-lines';

describe('resolveCartLines', () => {
  it('resolves a mixed cart preserving order', () => {
    const lines = resolveCartLines(['k01', 'print:fap01:50x70:true:false:black']);
    expect(lines.map((l) => l.kind)).toEqual(['ceramic', 'print']);
    expect(lines[0]).toMatchObject({ kind: 'ceramic', id: 'k01' });
    expect(lines[1]).toMatchObject({
      kind: 'print',
      id: 'print:fap01:50x70:true:false:black',
      sel: { size: '50x70', framed: true, mount: false, frameColour: 'black' },
    });
    if (lines[1].kind === 'print') expect(lines[1].design.id).toBe('fap01');
  });

  it('keeps two distinct variants of the same design as separate lines', () => {
    const lines = resolveCartLines(['print:fap01:30x40:false:false:none', 'print:fap01:50x70:false:false:none']);
    expect(lines).toHaveLength(2);
  });

  it('dedupes identical entries', () => {
    expect(resolveCartLines(['k01', 'k01'])).toHaveLength(1);
    expect(resolveCartLines(['print:fap01:50x70:true:false:black', 'print:fap01:50x70:true:false:black'])).toHaveLength(1);
  });

  it('drops unknown ids, malformed tokens, and unavailable/unpublished prints', () => {
    expect(resolveCartLines(['nope'])).toHaveLength(0);
    expect(resolveCartLines(['print:fap01:50x70:false'])).toHaveLength(0); // malformed (too few parts)
    expect(resolveCartLines(['print:nope:50x70:false:false:none'])).toHaveLength(0); // unknown design
    expect(resolveCartLines(['print:fap03:50x70:false:false:none'])).toHaveLength(0); // unpublished
    expect(resolveCartLines(['print:fap02:50x70:true:true:black'])).toHaveLength(0); // mount unavailable for fap02
  });
});
