import { describe, expect, it } from 'vitest';
import { dropName, dropTier, numRange } from './drop-visibility';

const drops = [
  { id: 'drop-1', status: 'ended' },
  { id: 'drop-2', status: 'active' },
  { id: 'drop-3', status: 'upcoming' },
];

describe('dropTier', () => {
  it.each([
    ['drop-2', 'current'],
    ['drop-1', 'archive'],
    ['drop-3', 'hidden'],
    ['drop-9', 'hidden'],
  ])('%s → %s', (id, tier) => {
    expect(dropTier(id, drops, false, 'drop-1')).toBe(tier);
  });

  it('shows only the fallback drop when the drops table could not be read', () => {
    expect(dropTier('drop-1', [], true, 'drop-1')).toBe('current');
    expect(dropTier('drop-2', [], true, 'drop-1')).toBe('hidden');
  });
});

describe('dropName', () => {
  const messages: Record<string, string> = { 'drops.drop-1': 'Czerwcowy drop' };
  const t = Object.assign((key: string) => messages[key] ?? key, { has: (key: string) => key in messages });

  it('reads the translated drop name', () => {
    expect(dropName(t, 'drop-1')).toBe('Czerwcowy drop');
  });

  it('renders nothing for a drop without copy instead of the raw id', () => {
    expect(dropName(t, 'drop-2')).toBe('');
  });
});

describe('numRange', () => {
  it('spans the lowest to the highest display number', () => {
    expect(numRange(['03', '01', '12'])).toBe('01–12');
  });

  it('collapses a single piece and handles none', () => {
    expect(numRange(['07'])).toBe('07');
    expect(numRange([])).toBe('');
  });
});
