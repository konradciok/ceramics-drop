export type Ga4Item = {
  item_id: string;
  item_name: string;
  price: number;
  quantity: number;
  item_category: string;
  item_brand: string;
};

export type Ga4PurchaseInput = {
  clientId: string | null;
  sessionId?: string | null;
  transactionId: string;
  value: number;     // major units (PLN), item subtotal
  shipping: number;  // major units (PLN)
  currency: string;
  items: Ga4Item[];
  userData?: { sha256_email_address?: string };
};

export type Ga4Config = { measurementId: string; apiSecret: string };

export function buildGa4PurchasePayload(input: Ga4PurchaseInput) {
  return {
    client_id: input.clientId,
    ...(input.userData ? { user_data: input.userData } : {}),
    events: [
      {
        name: 'purchase',
        params: {
          transaction_id: input.transactionId,
          currency: input.currency,
          value: input.value,
          shipping: input.shipping,
          items: input.items,
          ...(input.sessionId ? { session_id: input.sessionId } : {}),
          engagement_time_msec: 1,
        },
      },
    ],
  };
}

export async function sendGa4Purchase(
  config: Ga4Config,
  input: Ga4PurchaseInput,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status?: number; skipped?: boolean }> {
  if (!input.clientId) return { ok: false, skipped: true };
  const url =
    `https://www.google-analytics.com/mp/collect` +
    `?measurement_id=${encodeURIComponent(config.measurementId)}` +
    `&api_secret=${encodeURIComponent(config.apiSecret)}`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(buildGa4PurchasePayload(input)),
  });
  return { ok: res.ok, status: res.status };
}
