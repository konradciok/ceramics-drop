import { describe, it, expect, vi } from 'vitest';
import * as Sentry from '@sentry/nextjs';
import { sendPurchaseConversions, sendRefundConversion, type ConversionOrder, type RefundOrder } from './conversions';
import { registryProductById } from '../products';
import { toAnalyticsItem } from '../analytics';

vi.mock('@sentry/nextjs', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

const baseOrder = (over: Partial<ConversionOrder> = {}): ConversionOrder => ({
  payment_intent_id: 'pi_1',
  status: 'paid',
  subtotal: 30000, // grosze
  shipping: 1800,
  total: 31800,
  currency: 'pln',
  email: 'buyer@example.com',
  receiver_first_name: 'Anna',
  receiver_last_name: 'Nowak',
  receiver_phone: '600123456',
  shipping_address: { street: 'X', building_number: '1', city: 'Kraków', post_code: '30-001', country_code: 'PL' },
  marketing: {
    consent: 'granted', fbp: 'fb.1.1.A', fbc: null, ga_client_id: '111.222',
    ga_session_id: '999', ip: '1.2.3.4', user_agent: 'UA',
    event_source_url: 'https://anna-ciok.studio/koszyk/return', captured_at: '2026-06-09T00:00:00Z',
  },
  items: [{ product_id: 'k01', unit_price: 9000 }],
  ...over,
});

function deps(over = {}) {
  return {
    loadOrder: vi.fn().mockResolvedValue(baseOrder()),
    metaConfig: { pixelId: 'PIX', accessToken: 'TOK' },
    ga4Config: { measurementId: 'G-X', apiSecret: 'S' },
    sendMeta: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    sendGa4: vi.fn().mockResolvedValue({ ok: true, status: 204 }),
    appVersion: '0.10.0',
    appGitSha: '8ae90a5',
    ...over,
  };
}

describe('sendPurchaseConversions', () => {
  it('does nothing when consent is not granted', async () => {
    const d = deps({ loadOrder: vi.fn().mockResolvedValue(baseOrder({ marketing: { ...baseOrder().marketing!, consent: 'denied' } })) });
    await sendPurchaseConversions('pi_1', d);
    expect(d.sendMeta).not.toHaveBeenCalled();
    expect(d.sendGa4).not.toHaveBeenCalled();
  });

  it('does nothing when the order or marketing context is missing', async () => {
    const d = deps({ loadOrder: vi.fn().mockResolvedValue(null) });
    await sendPurchaseConversions('pi_1', d);
    expect(d.sendMeta).not.toHaveBeenCalled();
  });

  it('does nothing when order status is not paid', async () => {
    const d = deps({ loadOrder: vi.fn().mockResolvedValue(baseOrder({ status: 'failed' })) });
    await sendPurchaseConversions('pi_1', d);
    expect(d.sendMeta).not.toHaveBeenCalled();
    expect(d.sendGa4).not.toHaveBeenCalled();
  });

  it('sends Meta (value=total/100) and GA4 (value=subtotal/100) with the dedup id', async () => {
    const d = deps();
    await sendPurchaseConversions('pi_1', d);
    const metaInput = d.sendMeta.mock.calls[0][1];
    expect(metaInput.eventId).toBe('purchase-pi_1');
    expect(metaInput.value).toBe(318);          // total grosze → PLN
    expect(metaInput.userData.em).toBeDefined(); // hashed email present
    expect(metaInput.userData.em[0]).toMatch(/^[0-9a-f]{64}$/);
    const ga4Input = d.sendGa4.mock.calls[0][1];
    expect(ga4Input.transactionId).toBe('pi_1');
    expect(ga4Input.value).toBe(300);            // subtotal grosze → PLN
    expect(ga4Input.shipping).toBe(18);
    expect(ga4Input.appVersion).toBe('0.10.0');
    expect(ga4Input.appGitSha).toBe('8ae90a5');
  });

  it('mirrors the client item_variant on the ceramic GA4 item (N-4 symmetry)', async () => {
    const d = deps();
    await sendPurchaseConversions('pi_1', d);
    const ga4Input = d.sendGa4.mock.calls[0][1];
    const ceramicItem = ga4Input.items.find((i: { item_id: string }) => i.item_id === 'k01');
    // Server item_variant must equal what the client builder produces for the same piece.
    const expected = toAnalyticsItem(registryProductById('k01')!);
    expect(ceramicItem.item_variant).toBe(expected.item_variant);
    expect(ceramicItem.item_variant).toMatch(/^Nº \d+$/);
  });

  it('labels a print line item with its design name + variant (GA4) and keeps value/contents correct', async () => {
    const d = deps({
      loadOrder: vi.fn().mockResolvedValue(
        baseOrder({
          // Totals consistent with the two items below: 9000 + 35000 + 1800 shipping.
          subtotal: 44000,
          shipping: 1800,
          total: 45800,
          items: [
            { product_id: 'k01', unit_price: 9000 },
            { product_id: 'fap005', unit_price: 35000, variant: { size: '50x70', framed: true, mount: false, frameColour: 'black', prodigiSku: 'GLOBAL-CFP-20X28' } },
          ],
        }),
      ),
    });
    await sendPurchaseConversions('pi_1', d);

    const ga4Input = d.sendGa4.mock.calls[0][1];
    const printItem = ga4Input.items.find((i: { item_id: string }) => i.item_id === 'fap005');
    expect(printItem).toMatchObject({
      item_id: 'fap005',
      item_name: 'Print Nº 14',
      item_category: 'fine-art-prints',
      item_variant: '50×70 cm · frame black',
      price: 350,
    });
    expect(ga4Input.value).toBe(440);  // subtotal grosze → PLN

    // Meta contents still include the print line (item-level revenue not dropped).
    const metaInput = d.sendMeta.mock.calls[0][1];
    expect(metaInput.value).toBe(458); // total grosze → PLN
    expect(metaInput.numItems).toBe(2);
    expect(metaInput.contents.map((c: { id: string }) => c.id)).toContain('fap005');
  });

  it('uses order_items.unit_price for Meta contents item_price (not catalogue price)', async () => {
    const d = deps();
    await sendPurchaseConversions('pi_1', d);
    const metaInput = d.sendMeta.mock.calls[0][1];
    // unit_price = 9000 grosze → 90 PLN
    expect(metaInput.contents[0].item_price).toBe(90);
  });

  it('derives eventTimeSecs from marketing.captured_at, not webhook receive time', async () => {
    const d = deps();
    await sendPurchaseConversions('pi_1', d);
    const metaInput = d.sendMeta.mock.calls[0][1];
    // captured_at: '2026-06-09T00:00:00Z' → 1749427200
    expect(metaInput.eventTimeSecs).toBe(Math.floor(new Date('2026-06-09T00:00:00Z').getTime() / 1000));
  });

  it('swallows a Meta failure and still attempts GA4', async () => {
    const d = deps({ sendMeta: vi.fn().mockRejectedValue(new Error('graph 500')) });
    await expect(sendPurchaseConversions('pi_1', d)).resolves.toBeUndefined();
    expect(d.sendGa4).toHaveBeenCalled();
  });

  it('logs and captures to Sentry when Meta returns a non-ok HTTP response, still calls GA4', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(Sentry.captureMessage).mockClear();
    const errorBody = '{"error":{"message":"Invalid OAuth access token","type":"OAuthException","code":190,"error_subcode":460,"fbtrace_id":"AbCdEf111"}}';
    const d = deps({
      sendMeta: vi.fn().mockResolvedValue({ ok: false, status: 400, errorBody }),
    });
    await sendPurchaseConversions('pi_1', d);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('meta capi purchase http error'),
      'pi_1',
      400,
      errorBody,
    );
    // Fingerprinted on the *parsed*, stable error fields (type/code/subcode) — not the
    // raw body (which carries a unique-per-request fbtrace_id) and not payment_intent_id
    // — so every failing order groups into one Sentry issue instead of one per order.
    // response_body is still kept in `extra` (full context) for manual debugging.
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('meta capi purchase http error 400 (OAuthException)'),
      expect.objectContaining({
        level: 'error',
        fingerprint: ['meta-capi-purchase-http-error', '400', 'OAuthException', '190', '460'],
        extra: expect.objectContaining({
          payment_intent_id: 'pi_1',
          status: 400,
          response_body: errorBody,
          meta_error_type: 'OAuthException',
          meta_error_code: 190,
          meta_error_subcode: 460,
        }),
      }),
    );
    expect(d.sendGa4).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('groups two Meta failures with different fbtrace_id into the same Sentry fingerprint', async () => {
    vi.mocked(Sentry.captureMessage).mockClear();
    const bodyFor = (fbtraceId: string) =>
      `{"error":{"message":"Invalid OAuth access token","type":"OAuthException","code":190,"error_subcode":460,"fbtrace_id":"${fbtraceId}"}}`;

    const d1 = deps({ sendMeta: vi.fn().mockResolvedValue({ ok: false, status: 400, errorBody: bodyFor('trace-one') }) });
    await sendPurchaseConversions('pi_1', d1);
    const d2 = deps({ sendMeta: vi.fn().mockResolvedValue({ ok: false, status: 400, errorBody: bodyFor('trace-two') }) });
    await sendPurchaseConversions('pi_2', d2);

    const [, firstOptions] = vi.mocked(Sentry.captureMessage).mock.calls[0];
    const [, secondOptions] = vi.mocked(Sentry.captureMessage).mock.calls[1];
    expect((firstOptions as { fingerprint: string[] }).fingerprint).toEqual(
      (secondOptions as { fingerprint: string[] }).fingerprint,
    );
  });

  it('logs and captures to Sentry when GA4 MP returns a non-ok HTTP response (not a skip)', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(Sentry.captureMessage).mockClear();
    const d = deps({
      sendGa4: vi.fn().mockResolvedValue({ ok: false, status: 403, errorBody: '{"error":"forbidden"}' }),
    });
    await sendPurchaseConversions('pi_1', d);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('ga4 mp purchase http error'),
      'pi_1',
      403,
      '{"error":"forbidden"}',
    );
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('ga4 mp purchase http error 403'),
      expect.objectContaining({
        level: 'error',
        fingerprint: ['ga4-mp-purchase-http-error', '403', '{"error":"forbidden"}'],
        extra: expect.objectContaining({ payment_intent_id: 'pi_1', status: 403, response_body: '{"error":"forbidden"}' }),
      }),
    );
    consoleSpy.mockRestore();
  });

  it('warns and captures to Sentry when GA4 MP is skipped (consent granted, no clientId)', async () => {
    vi.mocked(Sentry.captureMessage).mockClear();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = deps({ sendGa4: vi.fn().mockResolvedValue({ ok: false, skipped: true }) });

    await sendPurchaseConversions('pi_1', d);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('ga4 mp purchase skipped'),
      'pi_1',
    );
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('ga4 mp purchase skipped'),
      {
        level: 'warning',
        extra: { payment_intent_id: 'pi_1', channel: 'ga4_mp', reason: 'no_client_id' },
      },
    );
    warnSpy.mockRestore();
  });

  it('does not capture a skip warning when GA4 MP succeeds', async () => {
    vi.mocked(Sentry.captureMessage).mockClear();
    const d = deps({ sendGa4: vi.fn().mockResolvedValue({ ok: true, status: 204 }) });

    await sendPurchaseConversions('pi_1', d);

    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('skips Meta when only ga4Config is provided', async () => {
    const d = deps({ metaConfig: undefined });
    await sendPurchaseConversions('pi_1', d);
    expect(d.sendMeta).not.toHaveBeenCalled();
    expect(d.sendGa4).toHaveBeenCalled();
  });

  it('skips GA4 when only metaConfig is provided', async () => {
    const d = deps({ ga4Config: undefined });
    await sendPurchaseConversions('pi_1', d);
    expect(d.sendMeta).toHaveBeenCalled();
    expect(d.sendGa4).not.toHaveBeenCalled();
  });
});

describe('sendRefundConversion', () => {
  const baseRefundOrder = (over: Partial<RefundOrder> = {}): RefundOrder => ({
    payment_intent_id: 'pi_1',
    subtotal: 30000,
    shipping: 1800,
    currency: 'pln',
    marketing: {
      consent: 'granted', fbp: null, fbc: null, ga_client_id: '111.222', ga_session_id: '999',
      ip: null, user_agent: null, event_source_url: null, captured_at: '2026-06-09T00:00:00Z',
    },
    ...over,
  });

  it('sends a GA4 refund event mirroring the purchase value/shipping', async () => {
    const sendGa4RefundMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    await sendRefundConversion(baseRefundOrder(), {
      ga4Config: { measurementId: 'G-X', apiSecret: 'S' },
      sendGa4Refund: sendGa4RefundMock,
    });
    expect(sendGa4RefundMock).toHaveBeenCalledWith(
      { measurementId: 'G-X', apiSecret: 'S' },
      { clientId: '111.222', sessionId: '999', transactionId: 'pi_1', value: 300, shipping: 18, currency: 'PLN' },
    );
  });

  it('does nothing when consent is not granted', async () => {
    const sendGa4RefundMock = vi.fn();
    const denied = baseRefundOrder();
    await sendRefundConversion({ ...denied, marketing: { ...denied.marketing!, consent: 'denied' } }, {
      ga4Config: { measurementId: 'G-X', apiSecret: 'S' },
      sendGa4Refund: sendGa4RefundMock,
    });
    expect(sendGa4RefundMock).not.toHaveBeenCalled();
  });

  it('does nothing when GA4 is not configured', async () => {
    const sendGa4RefundMock = vi.fn();
    await sendRefundConversion(baseRefundOrder(), { sendGa4Refund: sendGa4RefundMock });
    expect(sendGa4RefundMock).not.toHaveBeenCalled();
  });

  it('never throws, even on malformed persisted order data (best-effort boundary)', async () => {
    const sendGa4RefundMock = vi.fn();
    // Runtime-only malformation the type system can't rule out (a DB row with
    // a null currency, say) — must be caught, not propagate to releaseSale.
    const malformed = { ...baseRefundOrder(), currency: null } as unknown as RefundOrder;

    await expect(
      sendRefundConversion(malformed, { ga4Config: { measurementId: 'G-X', apiSecret: 'S' }, sendGa4Refund: sendGa4RefundMock }),
    ).resolves.toBeUndefined();
    expect(sendGa4RefundMock).not.toHaveBeenCalled();
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it('warns without a Sentry message when GA4 skips for a missing clientId', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(Sentry.captureMessage).mockClear();
    const sendGa4RefundMock = vi.fn().mockResolvedValue({ ok: false, skipped: true });
    await sendRefundConversion(baseRefundOrder(), {
      ga4Config: { measurementId: 'G-X', apiSecret: 'S' },
      sendGa4Refund: sendGa4RefundMock,
    });
    expect(consoleSpy).toHaveBeenCalledWith(
      'ga4 mp refund skipped (consent granted, no clientId) for',
      'pi_1',
    );
    // A skip is an attribution gap, not an error — unlike the purchase path it
    // reverses nothing that was ever sent, so it stays out of Sentry.
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('reports a non-ok GA4 response to Sentry, fingerprinted on status + body', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(Sentry.captureMessage).mockClear();
    const sendGa4RefundMock = vi.fn().mockResolvedValue({ ok: false, status: 500, errorBody: 'oops' });
    await sendRefundConversion(baseRefundOrder(), {
      ga4Config: { measurementId: 'G-X', apiSecret: 'S' },
      sendGa4Refund: sendGa4RefundMock,
    });
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'ga4 mp refund http error 500',
      expect.objectContaining({
        level: 'error',
        fingerprint: ['ga4-mp-refund-http-error', '500', 'oops'],
        extra: expect.objectContaining({ payment_intent_id: 'pi_1', status: 500, response_body: 'oops' }),
      }),
    );
    consoleSpy.mockRestore();
  });
});
