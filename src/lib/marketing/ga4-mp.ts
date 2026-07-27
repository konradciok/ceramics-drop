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
  value: number;     // major units, item subtotal
  shipping: number;  // major units
  currency: string;
  items: Ga4Item[];
  userData?: { sha256_email_address?: string };
  appVersion?: string;
  appGitSha?: string;
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
          ...(input.appVersion ? { app_version: input.appVersion } : {}),
          ...(input.appGitSha ? { app_git_sha: input.appGitSha } : {}),
          engagement_time_msec: 1,
        },
      },
    ],
  };
}

/** The MP collect endpoint, keyed by the config's credentials. Shared by both senders. */
function ga4CollectUrl(config: Ga4Config): string {
  return (
    `https://www.google-analytics.com/mp/collect` +
    `?measurement_id=${encodeURIComponent(config.measurementId)}` +
    `&api_secret=${encodeURIComponent(config.apiSecret)}`
  );
}

export async function sendGa4Purchase(
  config: Ga4Config,
  input: Ga4PurchaseInput,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status?: number; skipped?: boolean; errorBody?: string }> {
  // No GA client id (cookie missing or cleared) — the MP purchase cannot be attributed.
  // Reported as `skipped` so the only caller (conversions.ts) can escalate it to a
  // console.warn + Sentry warning once it knows consent was granted; logging here too
  // would double every skip in the Workers logs.
  if (!input.clientId) return { ok: false, skipped: true };
  const res = await fetchImpl(ga4CollectUrl(config), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(buildGa4PurchasePayload(input)),
    signal: AbortSignal.timeout(8000),
  });
  if (res.ok) return { ok: true, status: res.status };
  // Unlike Meta's Graph API, GA4 MP validation errors don't embed a per-request trace
  // id, so (unlike meta-capi.ts) the raw body is safe to use directly in a fingerprint.
  const errorBody = await res.text().catch(() => undefined);
  return { ok: false, status: res.status, errorBody: errorBody?.slice(0, 2000) };
}

export type Ga4RefundInput = {
  clientId: string | null;
  sessionId?: string | null;
  transactionId: string;
  value: number;     // major units, item subtotal — mirrors Ga4PurchaseInput.value
  shipping: number;  // major units — mirrors Ga4PurchaseInput.shipping
  currency: string;
};

export function buildGa4RefundPayload(input: Ga4RefundInput) {
  return {
    client_id: input.clientId,
    events: [
      {
        name: 'refund',
        params: {
          transaction_id: input.transactionId,
          currency: input.currency,
          value: input.value,
          shipping: input.shipping,
          ...(input.sessionId ? { session_id: input.sessionId } : {}),
          engagement_time_msec: 1,
        },
      },
    ],
  };
}

/** Full-refund reversal of a `purchase`. Same skip/error contract as sendGa4Purchase. */
export async function sendGa4Refund(
  config: Ga4Config,
  input: Ga4RefundInput,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status?: number; skipped?: boolean; errorBody?: string }> {
  if (!input.clientId) return { ok: false, skipped: true };
  const res = await fetchImpl(ga4CollectUrl(config), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(buildGa4RefundPayload(input)),
    signal: AbortSignal.timeout(8000),
  });
  if (res.ok) return { ok: true, status: res.status };
  const errorBody = await res.text().catch(() => undefined);
  return { ok: false, status: res.status, errorBody: errorBody?.slice(0, 2000) };
}
