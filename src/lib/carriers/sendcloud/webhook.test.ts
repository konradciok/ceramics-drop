import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { parseSendcloudWebhook, verifySendcloudSignature } from './webhook';

const ORDER_ID = '0b6f7c1e-1111-4222-8333-444455556666';

describe('verifySendcloudSignature', () => {
  const body = JSON.stringify({ action: 'parcel_status_changed', parcel: { id: 1 } });
  const key = 'webhook-signature-key-123';
  const signature = createHmac('sha256', key).update(body).digest('hex');

  it('accepts the hex HMAC-SHA256 of the raw body', async () => {
    await expect(verifySendcloudSignature(body, signature, key)).resolves.toBe(true);
    await expect(verifySendcloudSignature(body, ` ${signature.toUpperCase()} `, key)).resolves.toBe(true);
  });

  it('rejects a wrong key, a tampered body, or a missing header/key', async () => {
    await expect(verifySendcloudSignature(body, signature, 'other-key')).resolves.toBe(false);
    await expect(verifySendcloudSignature(`${body} `, signature, key)).resolves.toBe(false);
    await expect(verifySendcloudSignature(body, null, key)).resolves.toBe(false);
    await expect(verifySendcloudSignature(body, signature, undefined)).resolves.toBe(false);
  });
});

describe('parseSendcloudWebhook', () => {
  const payload = (parcel: Record<string, unknown>, action = 'parcel_status_changed') => ({
    action,
    timestamp: 1764000000,
    parcel,
  });

  it('reads our order id, tracking and status', () => {
    expect(
      parseSendcloudWebhook(
        payload({
          id: 77,
          order_number: ORDER_ID.toUpperCase(),
          tracking_number: 'ESTRK1',
          tracking_url: 'https://tracking.sendcloud.sc/forward?code=ESTRK1',
          status: { id: 1000, message: 'Ready to send' },
        }),
      ),
    ).toEqual({
      orderId: ORDER_ID,
      trackingNumber: 'ESTRK1',
      trackingUrl: 'https://tracking.sendcloud.sc/forward?code=ESTRK1',
      status: { id: 1000, code: null, message: 'Ready to send' },
    });
  });

  it('ignores other actions and parcels that are not ours', () => {
    expect(parseSendcloudWebhook(payload({ order_number: ORDER_ID }, 'integration_updated'))).toBeNull();
    expect(parseSendcloudWebhook(payload({ order_number: '1234567890' }))).toBeNull();
    expect(parseSendcloudWebhook({ action: 'parcel_status_changed' })).toBeNull();
    expect(parseSendcloudWebhook(null)).toBeNull();
  });
});
