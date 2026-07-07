// Prodigi API v4.0 types — plain TypeScript, no Zod.

export interface ProdigiOrderItem {
  sku: string;
  copies: number;
  sizing: 'fillPrintArea';
  attributes: Record<string, string>;
  assets: Array<{ printArea: 'default'; url: string }>;
  recipientCost?: { amount: string; currency: string };
}

export interface ProdigiRecipient {
  name: string;
  email?: string;
  phoneNumber?: string;
  address: {
    line1: string;
    line2?: string;
    postalOrZipCode: string;
    countryCode: string;
    townOrCity: string;
    stateOrCounty?: string;
  };
}

export interface ProdigiOrderRequest {
  shippingMethod: string;
  idempotencyKey: string;
  callbackUrl?: string;
  merchantReference?: string;
  recipient: ProdigiRecipient;
  items: ProdigiOrderItem[];
  metadata?: Record<string, string>;
}

export interface ProdigiOrderResponse {
  outcome: 'Created' | 'AlreadyExists' | string;
  order: {
    id: string;
    merchantReference?: string;
    status: { stage: string };
    items: Array<{ id: string; sku: string; status: { detail: string } }>;
  };
  traceParent?: string;
}

/** GET /orders/{id}/actions — availability of order actions. */
export interface ProdigiOrderActionsResponse {
  outcome: string;
  cancel?: { isAvailable: 'Yes' | 'No' | string };
}

/** POST /orders/{id}/actions/cancel — outcome is 'Cancelled' on success. */
export interface ProdigiCancelResponse {
  outcome: 'Cancelled' | 'FailedToCancel' | 'ActionNotAvailable' | string;
  order?: ProdigiOrderResponse['order'];
}

export interface ProdigiProductResponse {
  product: {
    sku: string;
    variants: Array<{
      printAreaSizes: { default: { horizontalResolution: number; verticalResolution: number } };
    }>;
    attributes: Array<{ name: string; values: string[] }>;
  };
}

export interface FulfilmentJobMessage {
  orderId: string;
  jobId: string;
}
