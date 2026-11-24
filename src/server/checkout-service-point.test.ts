import { beforeEach, describe, it, expect, vi } from 'vitest';
import * as Sentry from '@sentry/nextjs';
import { verifyCheckoutServicePoint } from './checkout-service-point';
import { SendcloudApiError, SendcloudConfigError } from '@/lib/carriers/sendcloud/errors';
import type { SendcloudClient } from '@/lib/carriers/sendcloud/client';

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@opennextjs/cloudflare', () => ({ getCloudflareContext: () => ({ env: {} }) }));

const SPAIN = { country: 'ES' as const, sendcloudCarrier: 'inpost_es' as const };
const POINT = {
  id: 10544,
  name: 'Locker Mercado',
  carrier: { code: 'inpost_es' },
  carrier_service_point_id: 'ES009299',
  address: { street: 'Calle Mayor', house_number: '1', postal_code: '28013', city: 'Madrid', country_code: 'ES' },
  is_expired: false,
};

const clientReturning = (
  impl: SendcloudClient['getServicePoint'],
  available: SendcloudClient['checkServicePointAvailability'] = async () => true,
) => ({ getServicePoint: vi.fn(impl), checkServicePointAvailability: vi.fn(available) }) as unknown as SendcloudClient;

describe('verifyCheckoutServicePoint', () => {
  beforeEach(() => vi.mocked(Sentry.captureException).mockClear());

  it('returns the point as Sendcloud describes it', async () => {
    const client = clientReturning(async () => POINT);
    await expect(verifyCheckoutServicePoint('10544', SPAIN, client)).resolves.toMatchObject({
      ok: true,
      point: { id: '10544', code: 'ES009299', country: 'ES' },
    });
    expect(client.getServicePoint).toHaveBeenCalledWith('10544');
    expect(client.checkServicePointAvailability).toHaveBeenCalledWith('10544');
  });

  it('refuses a point Sendcloud reports unavailable right now, though not expired', async () => {
    const client = clientReturning(async () => POINT, async () => false);
    await expect(verifyCheckoutServicePoint('10544', SPAIN, client)).resolves.toEqual({ ok: false, reason: 'not_available' });
  });

  it('refuses a point the availability check does not know', async () => {
    const client = clientReturning(async () => POINT, async () => null);
    await expect(verifyCheckoutServicePoint('10544', SPAIN, client)).resolves.toEqual({ ok: false, reason: 'not_found' });
  });

  it('reports a failed availability check as unavailable', async () => {
    vi.mocked(Sentry.captureException).mockClear();
    const client = clientReturning(async () => POINT, async () => {
      throw new SendcloudApiError('POST', '/service-points/10544/check-availability', 502, '');
    });
    await expect(verifyCheckoutServicePoint('10544', SPAIN, client)).resolves.toEqual({ ok: false, reason: 'unavailable' });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it("refuses a point in another country than the buyer's", async () => {
    const client = clientReturning(async () => ({ ...POINT, address: { ...POINT.address, country_code: 'PT' } }));
    await expect(verifyCheckoutServicePoint('10544', SPAIN, client)).resolves.toEqual({ ok: false, reason: 'wrong_country' });
  });

  it('treats a 4xx about the id as an unknown point', async () => {
    const client = clientReturning(async () => {
      throw new SendcloudApiError('GET', '/service-points/x', 400, '{}');
    });
    await expect(verifyCheckoutServicePoint('1', SPAIN, client)).resolves.toEqual({ ok: false, reason: 'not_found' });
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it.each([
    ['an outage', new SendcloudApiError('GET', '/service-points/1', 503, '')],
    ['throttling', new SendcloudApiError('GET', '/service-points/1', 429, '')],
    ['bad credentials', new SendcloudApiError('GET', '/service-points/1', 401, '')],
    ['a timeout', new DOMException('aborted', 'AbortError')],
  ])('reports %s as unavailable and alerts', async (_label, error) => {
    vi.mocked(Sentry.captureException).mockClear();
    const client = clientReturning(async () => {
      throw error;
    });
    await expect(verifyCheckoutServicePoint('1', SPAIN, client)).resolves.toEqual({ ok: false, reason: 'unavailable' });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('is unavailable when Sendcloud is not configured', async () => {
    vi.mocked(Sentry.captureException).mockClear();
    await expect(verifyCheckoutServicePoint('1', SPAIN)).resolves.toEqual({ ok: false, reason: 'unavailable' });
    expect(vi.mocked(Sentry.captureException).mock.calls[0][0]).toBeInstanceOf(SendcloudConfigError);
  });
});
