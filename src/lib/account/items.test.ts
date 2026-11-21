import { describe, it, expect } from 'vitest';
import { accountItemLabel } from './items';
import type { AccountOrderItem } from './orders';

// Translate mock for test purposes
function t(key: string): string {
  const messages: Record<string, string> = {
    'product.mug': 'Kubek',
  };
  return messages[key] ?? key;
}

function item(overrides: Partial<AccountOrderItem> = {}): AccountOrderItem {
  return {
    product_id: 'k01',
    variant: null,
    unit_price: 9000,
    ...overrides,
  };
}

describe('accountItemLabel', () => {
  it('resolves ceramic products by product_id and displays category + number', () => {
    const label = accountItemLabel(item({ product_id: 'k01' }), t, 'pl');
    expect(label.key).toBe('k01');
    expect(label.name).toContain('Nº 01');
    expect(label.detail).toBeNull();
  });

  it('displays a print variant with size and frame detail', () => {
    const label = accountItemLabel(
      item({
        product_id: 'fap005',
        variant: { size: '50x70', framed: true, mount: false, frameColour: 'black' },
      }),
      t,
      'pl',
    );
    expect(label.detail).toContain('50×70 cm');
    expect(label.detail).toContain('rama');
  });

  it('names a historical print line from the frozen legacy table', () => {
    const label = accountItemLabel(
      item({
        product_id: 'fap001',
        variant: { kind: 'print', size: '30x40', framed: true, mount: false, frameColour: 'natural' },
      }),
      t,
      'en',
    );
    expect(label.name).toBe('Ostrea 01');
    expect(label.detail).toBe('30×40 cm · frame light brown');
  });

  it('degrades unknown print ids to a localised noun plus the raw product_id', () => {
    const label = accountItemLabel(
      item({ product_id: 'fap999', variant: { size: '50x70', framed: true, mount: false, frameColour: 'black' } }),
      t,
      'pl',
    );
    expect(label.name).toBe('Odbitka fap999');
  });

  it('degrades unknown ceramic ids to the raw product_id', () => {
    const label = accountItemLabel(item({ product_id: 'unknown-piece' }), t, 'pl');
    expect(label.name).toBe('unknown-piece');
    expect(label.detail).toBeNull();
  });
});
