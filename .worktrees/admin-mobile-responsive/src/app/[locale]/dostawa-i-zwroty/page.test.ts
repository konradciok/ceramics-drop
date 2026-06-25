import { describe, it, expect } from 'vitest';
import pl from '../../../../messages/pl.json';
import { SHIPPING_PLN } from '@/lib/pricing';

describe('dostawa-i-zwroty copy matches checkout', () => {
  it('mentions Paczkomat with the charged price', () => {
    expect(JSON.stringify(pl.shipping).toLowerCase()).toContain('paczkomat');
    // Assert the price in the specific copy fields, not just any "15" anywhere.
    expect(pl.shipping.s1Li1).toContain(`od ${SHIPPING_PLN.paczkomat} zł`);
    expect(pl.shipping.s1P).toContain(`(od ${SHIPPING_PLN.paczkomat} zł)`);
  });
});
