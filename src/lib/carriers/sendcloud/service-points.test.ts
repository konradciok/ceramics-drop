import { describe, it, expect } from 'vitest';
import { checkServicePoint, type SendcloudServicePoint } from './service-points';

const POINT: SendcloudServicePoint = {
  id: 10544,
  name: 'Locker Mercado',
  carrier: { code: 'inpost_es' },
  carrier_service_point_id: 'ES009299',
  general_shop_type: 'locker',
  address: { street: 'Calle Mayor', house_number: '1', postal_code: '28013', city: 'Madrid', country_code: 'ES' },
  is_expired: false,
};
const LANE = { country: 'ES', carrier: 'inpost_es' };

describe('checkServicePoint', () => {
  it('keeps what Sendcloud says about a valid point', () => {
    expect(checkServicePoint(POINT, LANE)).toEqual({
      ok: true,
      point: {
        id: '10544',
        code: 'ES009299',
        carrier: 'inpost_es',
        name: 'Locker Mercado',
        street: 'Calle Mayor',
        house_number: '1',
        post_code: '28013',
        city: 'Madrid',
        country: 'ES',
      },
    });
  });

  it('refuses an unknown point', () => {
    expect(checkServicePoint(null, LANE)).toEqual({ ok: false, reason: 'not_found' });
  });

  it("refuses another carrier's point (the picker runs on the buyer's device)", () => {
    expect(checkServicePoint({ ...POINT, carrier: { code: 'correos' } }, LANE)).toEqual({ ok: false, reason: 'wrong_carrier' });
    expect(checkServicePoint({ ...POINT, carrier: null }, LANE)).toEqual({ ok: false, reason: 'wrong_carrier' });
  });

  it('refuses a point outside the chosen country (the price is per zone)', () => {
    const portugal = { ...POINT, address: { ...POINT.address, country_code: 'PT' } };
    expect(checkServicePoint(portugal, LANE)).toEqual({ ok: false, reason: 'wrong_country' });
  });

  it('refuses a stale point', () => {
    expect(checkServicePoint({ ...POINT, is_expired: true }, LANE)).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses a point without the address a shipment needs', () => {
    expect(checkServicePoint({ ...POINT, address: { ...POINT.address, city: ' ' } }, LANE)).toEqual({ ok: false, reason: 'incomplete' });
  });

  it('normalises the country code', () => {
    const lower = { ...POINT, address: { ...POINT.address, country_code: 'es' } };
    expect(checkServicePoint(lower, LANE)).toMatchObject({ ok: true, point: { country: 'ES' } });
  });
});
