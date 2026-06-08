import { describe, it, expect } from 'vitest';
import pl from '../../../../messages/pl.json';
import { SHIPPING_PLN } from '@/lib/pricing';

describe('dostawa-i-zwroty copy matches checkout', () => {
  it('mentions Paczkomat with the charged price', () => {
    const joined = JSON.stringify(pl.shipping);
    expect(joined.toLowerCase()).toContain('paczkomat');
    expect(joined).toContain(String(SHIPPING_PLN.paczkomat)); // "15"
  });
});
