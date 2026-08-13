import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProdigiError, prodigiClient } from './client';
import type {
  ProdigiOrderRequest,
  ProdigiQuoteRequest,
  ProdigiRecipient,
  ProdigiSpineRequest,
} from './types';

const sandboxEnv = {
  PRODIGI_ENV: 'sandbox',
  PRODIGI_API_KEY_SANDBOX: 'sandbox-secret',
  PRODIGI_API_KEY_LIVE: 'live-secret',
} as CloudflareEnv;

const liveEnv = { ...sandboxEnv, PRODIGI_ENV: 'live' } as CloudflareEnv;

const recipient: ProdigiRecipient = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  address: {
    line1: '1 Analytical Engine Way',
    postalOrZipCode: 'SW1A 1AA',
    countryCode: 'GB',
    townOrCity: 'London',
  },
};

function jsonResponse(body: unknown = { outcome: 'Ok' }, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

function lastRequest(): [string, RequestInit] {
  const [url, init] = vi.mocked(fetch).mock.lastCall as [string, RequestInit];
  return [url, init];
}

describe('prodigiClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => jsonResponse()));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts an order with the sandbox URL, API key and complete JSON body', async () => {
    const payload: ProdigiOrderRequest = {
      shippingMethod: 'Budget',
      idempotencyKey: 'idem-1',
      merchantReference: 'merchant-1',
      recipient,
      items: [{
        sku: 'GLOBAL-FAP-12X16',
        copies: 1,
        sizing: 'fillPrintArea',
        attributes: {},
        assets: [{ printArea: 'default', url: 'https://example.com/art.jpg' }],
      }],
    };

    await prodigiClient(sandboxEnv).postOrder(payload);

    expect(lastRequest()).toEqual([
      'https://api.sandbox.prodigi.com/v4.0/orders',
      {
        method: 'POST',
        headers: { 'X-API-Key': 'sandbox-secret', 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    ]);
  });

  it('uses the live host and live key only when the supplied environment is live', async () => {
    await prodigiClient(liveEnv).getProduct('SKU/with space');

    expect(lastRequest()).toEqual([
      'https://api.prodigi.com/v4.0/products/SKU%2Fwith%20space',
      {
        method: 'GET',
        headers: { 'X-API-Key': 'live-secret', 'Content-Type': 'application/json' },
        body: undefined,
      },
    ]);
  });

  it('gets an order and its available actions', async () => {
    const client = prodigiClient(sandboxEnv);
    await client.getOrder('ord 123');
    expect(lastRequest()[0]).toBe('https://api.sandbox.prodigi.com/v4.0/orders/ord%20123');
    expect(lastRequest()[1].method).toBe('GET');

    await client.getOrderActions('ord 123');
    expect(lastRequest()[0]).toBe('https://api.sandbox.prodigi.com/v4.0/orders/ord%20123/actions');
    expect(lastRequest()[1].method).toBe('GET');
  });

  it('lists orders with scalar filters and repeated array query parameters', async () => {
    await prodigiClient(sandboxEnv).listOrders({
      top: 25,
      skip: 0,
      createdFrom: '2026-01-01T00:00:00+00:00',
      createdTo: '2026-02-01T00:00:00Z',
      status: 'Complete & shipped',
      orderIds: ['ord-1', 'ord/2'],
      merchantReferences: ['ref one', 'ref&two'],
    });

    const [url, init] = lastRequest();
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/v4.0/orders');
    expect(parsed.searchParams.get('top')).toBe('25');
    expect(parsed.searchParams.get('skip')).toBe('0');
    expect(parsed.searchParams.get('createdFrom')).toBe('2026-01-01T00:00:00+00:00');
    expect(parsed.searchParams.get('createdTo')).toBe('2026-02-01T00:00:00Z');
    expect(parsed.searchParams.get('status')).toBe('Complete & shipped');
    expect(parsed.searchParams.getAll('orderIds')).toEqual(['ord-1', 'ord/2']);
    expect(parsed.searchParams.getAll('merchantReferences')).toEqual(['ref one', 'ref&two']);
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });

  it('omits the query marker when no list filters are provided', async () => {
    await prodigiClient(sandboxEnv).listOrders();
    expect(lastRequest()[0]).toBe('https://api.sandbox.prodigi.com/v4.0/orders');
  });

  it('posts quote and photobook-spine bodies unchanged', async () => {
    const quote: ProdigiQuoteRequest = {
      shippingMethod: 'Budget',
      currencyCode: 'PLN',
      destinationCountryCode: 'PL',
      items: [{
        sku: 'GLOBAL-FAP-12X16',
        copies: 2,
        attributes: { color: 'black' },
        assets: [{ printArea: 'default' }],
      }],
    };
    const spine: ProdigiSpineRequest = {
      sku: 'GLOBAL-PHB-A4',
      destinationCountryCode: 'US',
      state: 'CA',
      numberOfPages: 48,
    };
    const client = prodigiClient(sandboxEnv);

    await client.postQuote(quote);
    expect(lastRequest()[0]).toBe('https://api.sandbox.prodigi.com/v4.0/quotes');
    expect(lastRequest()[1]).toMatchObject({ method: 'POST', body: JSON.stringify(quote) });

    const spineResponse = {
      success: true,
      message: 'Spine calculated successfully',
      spineInfo: { widthMm: 12.4 },
    };
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(spineResponse));
    await expect(client.postSpine(spine)).resolves.toEqual(spineResponse);
    expect(lastRequest()[0]).toBe('https://api.sandbox.prodigi.com/v4.0/products/spine');
    expect(lastRequest()[1]).toMatchObject({ method: 'POST', body: JSON.stringify(spine) });
  });

  it('posts cancel and all update actions with the documented body shapes', async () => {
    const client = prodigiClient(sandboxEnv);

    await client.cancelOrder('ord-1');
    expect(lastRequest()[0]).toBe('https://api.sandbox.prodigi.com/v4.0/orders/ord-1/actions/cancel');
    expect(lastRequest()[1]).toMatchObject({ method: 'POST', body: undefined });

    await client.updateShippingMethod('ord-1', 'Express');
    expect(lastRequest()[0]).toBe(
      'https://api.sandbox.prodigi.com/v4.0/orders/ord-1/actions/updateShippingMethod',
    );
    expect(lastRequest()[1].body).toBe(JSON.stringify({ shippingMethod: 'Express' }));

    await client.updateRecipient('ord-1', recipient);
    expect(lastRequest()[0]).toBe(
      'https://api.sandbox.prodigi.com/v4.0/orders/ord-1/actions/updateRecipient',
    );
    expect(lastRequest()[1].body).toBe(JSON.stringify(recipient));

    const metadata = { source: 'cli', nested: { batch: 4 }, flags: ['manual', 'reviewed'] };
    await client.updateMetadata('ord-1', { metadata });
    expect(lastRequest()[0]).toBe(
      'https://api.sandbox.prodigi.com/v4.0/orders/ord-1/actions/updateMetadata',
    );
    expect(lastRequest()[1].body).toBe(JSON.stringify({ metadata }));
  });

  it('returns a successful HTTP response even when its Prodigi outcome describes issues', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ outcome: 'PartiallyUpdated' }));
    await expect(prodigiClient(sandboxEnv).updateMetadata('ord-1', { metadata: {} }))
      .resolves.toEqual({ outcome: 'PartiallyUpdated' });
  });

  it.each([
    [400, false],
    [404, false],
    [409, false],
    [429, true],
    [500, true],
    [503, true],
  ])('maps HTTP %i to a ProdigiError (retryable=%s)', async (status, retryable) => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(
      { outcome: 'Failed', detail: 'bad request' },
      { status },
    ));

    const error = await prodigiClient(sandboxEnv).getOrder('ord-1').catch((caught) => caught);
    expect(error).toBeInstanceOf(ProdigiError);
    expect(error).toMatchObject({
      status,
      retryable,
      body: { outcome: 'Failed', detail: 'bad request' },
    });
  });

  it('preserves a non-JSON HTTP error body in the message and exposes a null body', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('upstream unavailable', { status: 502 }));

    await expect(prodigiClient(sandboxEnv).getProduct('sku')).rejects.toMatchObject({
      status: 502,
      retryable: true,
      body: null,
      message: 'Prodigi 502: upstream unavailable',
    });
  });

  it('maps thrown fetch failures to retryable network errors', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('connection reset'));

    await expect(prodigiClient(sandboxEnv).getProduct('sku')).rejects.toMatchObject({
      status: null,
      retryable: true,
      body: null,
      message: 'Network error: TypeError: connection reset',
    });
  });
});

describe('PRODIGI_API_BASE_URL override (rehearsal failure injection)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => jsonResponse()));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('redirects sandbox traffic to the override URL when set off-production', async () => {
    const env = { ...sandboxEnv, PRODIGI_API_BASE_URL: 'https://injected.example.com/v4.0/' } as CloudflareEnv;
    await prodigiClient(env).getOrder('ord-1');
    expect(lastRequest()[0]).toBe('https://injected.example.com/v4.0/orders/ord-1');
  });

  it('ignores the override entirely in live mode — production traffic cannot be redirected', async () => {
    const env = { ...liveEnv, PRODIGI_API_BASE_URL: 'https://injected.example.com/v4.0' } as CloudflareEnv;
    await prodigiClient(env).getOrder('ord-1');
    expect(lastRequest()[0]).toBe('https://api.prodigi.com/v4.0/orders/ord-1');
  });

  it('leaves behaviour unchanged when the override is unset or blank', async () => {
    await prodigiClient(sandboxEnv).getOrder('ord-1');
    expect(lastRequest()[0]).toBe('https://api.sandbox.prodigi.com/v4.0/orders/ord-1');

    const blankEnv = { ...sandboxEnv, PRODIGI_API_BASE_URL: '   ' } as CloudflareEnv;
    await prodigiClient(blankEnv).getOrder('ord-1');
    expect(lastRequest()[0]).toBe('https://api.sandbox.prodigi.com/v4.0/orders/ord-1');
  });
});

describe('ProdigiError', () => {
  it('is an Error subclass with a stable name', () => {
    const error = new ProdigiError('x', 400, false);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ProdigiError');
  });
});
