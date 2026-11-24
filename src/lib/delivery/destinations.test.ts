import { describe, it, expect } from 'vitest';
import { CHECKOUT_DESTINATION, DESTINATIONS, DESTINATION_COUNTRIES, destinationFor, isDestinationCountry } from './destinations';

describe('destination registry', () => {
  it('covers the ten owner-approved countries, Spain in its own price zone', () => {
    expect([...DESTINATION_COUNTRIES].sort()).toEqual(['AT', 'BE', 'DE', 'ES', 'FR', 'IT', 'LU', 'NL', 'PL', 'PT']);
    expect(DESTINATIONS.ES.zone).toBe('es');
    expect(DESTINATIONS.ES.transitDays).toBe(4);
    for (const c of DESTINATION_COUNTRIES.filter((c) => c !== 'ES')) expect(DESTINATIONS[c].zone).toBe('eu');
    for (const c of DESTINATION_COUNTRIES) expect(DESTINATIONS[c].country).toBe(c);
  });

  it('enables nothing before the Spain cutover and has no unverified shipping option', () => {
    for (const c of DESTINATION_COUNTRIES) {
      expect(DESTINATIONS[c].enabled).toBe(false);
      expect(DESTINATIONS[c].sendcloudShippingOption).toBeNull();
    }
  });

  it('looks countries up strictly', () => {
    expect(isDestinationCountry('ES')).toBe(true);
    expect(isDestinationCountry('es')).toBe(false);
    expect(isDestinationCountry('GB')).toBe(false);
    expect(destinationFor('PT')?.zone).toBe('eu');
    expect(destinationFor('IC')).toBeNull();
    expect(destinationFor(null)).toBeNull();
  });

  it('keeps today’s checkout on Poland through ShipX', () => {
    expect(CHECKOUT_DESTINATION).toEqual({ country: 'PL', channel: 'inpost_shipx' });
  });
});
