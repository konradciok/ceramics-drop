const GRAPH_API_VERSION = 'v21.0';

export type MetaUserData = {
  em?: string[]; ph?: string[]; fn?: string[]; ln?: string[];
  ct?: string[]; zp?: string[]; country?: string[];
  client_ip_address?: string | null;
  client_user_agent?: string | null;
  fbp?: string | null;
  fbc?: string | null;
};

export type MetaContent = { id: string; quantity: number; item_price: number };

export type MetaPurchaseInput = {
  eventId: string;
  eventTimeSecs: number;
  eventSourceUrl: string | null;
  userData: MetaUserData;
  value: number;       // major units (PLN)
  currency: string;    // 'PLN'
  contentIds: string[];
  contents: MetaContent[];
  numItems: number;
  orderId: string;
};

export type MetaCapiConfig = {
  pixelId: string;
  accessToken: string;
  testEventCode?: string;
};

/** Drop null/undefined keys so Meta doesn't reject empty identifiers. */
function pruneUserData(u: MetaUserData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(u)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

export function buildMetaPurchasePayload(input: MetaPurchaseInput) {
  return {
    data: [
      {
        event_name: 'Purchase',
        event_time: input.eventTimeSecs,
        event_id: input.eventId,
        action_source: 'website',
        ...(input.eventSourceUrl ? { event_source_url: input.eventSourceUrl } : {}),
        user_data: pruneUserData(input.userData),
        custom_data: {
          currency: input.currency,
          value: input.value,
          content_type: 'product',
          content_ids: input.contentIds,
          contents: input.contents,
          num_items: input.numItems,
          order_id: input.orderId,
        },
      },
    ],
  };
}

export async function sendMetaPurchase(
  config: MetaCapiConfig,
  input: MetaPurchaseInput,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number }> {
  const url =
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${config.pixelId}/events` +
    `?access_token=${encodeURIComponent(config.accessToken)}`;
  const body = {
    ...buildMetaPurchasePayload(input),
    ...(config.testEventCode ? { test_event_code: config.testEventCode } : {}),
  };
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status };
}
