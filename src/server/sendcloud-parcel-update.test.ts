import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  emailLabelToStudio: vi.fn(),
  emailShippingConfirmationToCustomer: vi.fn(),
}));
vi.mock('@/lib/email', () => mocks);

import { applySendcloudParcelUpdate } from './sendcloud-parcel-update';
import type { SendcloudParcelUpdate } from '@/lib/carriers/sendcloud/webhook';

const ORDER_ID = '0b6f7c1e-1111-4222-8333-444455556666';

type Row = Record<string, unknown>;

/**
 * Minimal PostgREST stand-in over one mutable `orders` row: select().eq().maybeSingle(),
 * and awaited update(patch).eq()/.is()[.select()] that applies only when every
 * filter matches the current row (so claims behave like the real NULL→timestamp CAS).
 */
function fakeSupabase(initial: Row | null) {
  const row: Row | null = initial ? { ...initial } : null;
  const updates: Row[] = [];
  const from = vi.fn(() => {
    let patch: Row | null = null;
    const filters: Array<[string, string, unknown]> = [];
    const matches = () =>
      !!row &&
      filters.every(([op, col, v]) => (op === 'is' ? row[col] === v || (v === null && row[col] == null) : row[col] === v));
    const builder: Record<string, unknown> = {
      select: vi.fn(() => builder),
      update: vi.fn((p: Row) => {
        patch = p;
        return builder;
      }),
      eq: vi.fn((col: string, v: unknown) => {
        filters.push(['eq', col, v]);
        return builder;
      }),
      is: vi.fn((col: string, v: unknown) => {
        filters.push(['is', col, v]);
        return builder;
      }),
      maybeSingle: vi.fn(async () => ({ data: matches() ? { ...row } : null, error: null })),
      then: (resolve: (v: unknown) => void) => {
        const hit = matches();
        if (hit && patch) {
          Object.assign(row!, patch);
          updates.push(patch);
        }
        resolve({ data: hit ? [{ id: row!.id }] : [], error: null });
      },
    };
    return builder;
  });
  return { client: { from } as never, row: () => row, updates };
}

const baseOrder: Row = {
  id: ORDER_ID,
  shipping_channel: 'sendcloud',
  inpost_shipment_id: 'shp-1',
  inpost_tracking_number: 'ESTRK1',
  inpost_target_point: 'ES009299',
  delivery_point: { id: '10544', code: 'ES009299', name: 'Locker Mercado' },
  tracking_url: null,
  delivery_status: 'confirmed',
  delivery_method: 'paczkomat',
  receiver_first_name: 'Ana',
  receiver_last_name: 'García',
  email: 'ana@example.com',
  locale: 'es',
  inpost_label_emailed_at: null,
  customer_notified_at: null,
};

const update = (status: SendcloudParcelUpdate['status'], extra: Partial<SendcloudParcelUpdate> = {}): SendcloudParcelUpdate => ({
  orderId: ORDER_ID,
  trackingNumber: 'ESTRK1',
  trackingUrl: 'https://tracking.sendcloud.sc/forward?code=ESTRK1',
  status,
  ...extra,
});

describe('applySendcloudParcelUpdate', () => {
  const getLabelPdf = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    getLabelPdf.mockResolvedValue(new ArrayBuffer(4));
    mocks.emailLabelToStudio.mockResolvedValue(undefined);
    mocks.emailShippingConfirmationToCustomer.mockResolvedValue(undefined);
  });

  it('on Ready to send: stores the tracking URL, emails the label and the customer once', async () => {
    const db = fakeSupabase(baseOrder);
    const outcome = await applySendcloudParcelUpdate({ supabase: db.client, getLabelPdf }, update({ id: 1000, message: 'Ready to send' }));

    expect(outcome).toBe('applied');
    expect(db.row()!.tracking_url).toBe('https://tracking.sendcloud.sc/forward?code=ESTRK1');
    expect(getLabelPdf).toHaveBeenCalledWith('shp-1');
    expect(mocks.emailLabelToStudio).toHaveBeenCalledWith(
      expect.objectContaining({ order: expect.objectContaining({ id: ORDER_ID, inpost_target_point: 'ES009299', inpost_tracking_number: 'ESTRK1' }) }),
    );
    expect(mocks.emailShippingConfirmationToCustomer).toHaveBeenCalledWith(
      expect.objectContaining({
        locale: 'es',
        order: expect.objectContaining({ email: 'ana@example.com', tracking_url: 'https://tracking.sendcloud.sc/forward?code=ESTRK1' }),
      }),
    );
    expect(db.row()!.inpost_label_emailed_at).toEqual(expect.any(String));
    expect(db.row()!.customer_notified_at).toEqual(expect.any(String));

    // A redelivery sends nothing again.
    vi.clearAllMocks();
    await applySendcloudParcelUpdate({ supabase: db.client, getLabelPdf }, update({ id: 1000, message: 'Ready to send' }));
    expect(mocks.emailLabelToStudio).not.toHaveBeenCalled();
    expect(mocks.emailShippingConfirmationToCustomer).not.toHaveBeenCalled();
  });

  it('moves the status forward and never back', async () => {
    const db = fakeSupabase({ ...baseOrder, inpost_label_emailed_at: 't', customer_notified_at: 't' });
    await applySendcloudParcelUpdate({ supabase: db.client, getLabelPdf }, update({ message: 'Awaiting customer pickup' }));
    expect(db.row()!.delivery_status).toBe('ready_to_pickup');

    await applySendcloudParcelUpdate({ supabase: db.client, getLabelPdf }, update({ message: 'Parcel en route' }));
    expect(db.row()!.delivery_status).toBe('ready_to_pickup');
  });

  it('ignores a superseded shipment (different tracking number)', async () => {
    const db = fakeSupabase(baseOrder);
    const outcome = await applySendcloudParcelUpdate(
      { supabase: db.client, getLabelPdf },
      update({ id: 2000, message: 'Cancelled' }, { trackingNumber: 'OLDTRK' }),
    );
    expect(outcome).toBe('superseded_shipment');
    expect(db.updates).toEqual([]);
  });

  it('ignores orders that do not ship through Sendcloud', async () => {
    const db = fakeSupabase({ ...baseOrder, shipping_channel: 'inpost_shipx' });
    await expect(
      applySendcloudParcelUpdate({ supabase: db.client, getLabelPdf }, update({ message: 'Delivered' })),
    ).resolves.toBe('not_sendcloud_order');
  });

  it('leaves an unknown status alone', async () => {
    const db = fakeSupabase({ ...baseOrder, inpost_label_emailed_at: 't', customer_notified_at: 't', tracking_url: 'https://tracking.sendcloud.sc/forward?code=ESTRK1' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      applySendcloudParcelUpdate({ supabase: db.client, getLabelPdf }, update({ id: 99999, message: 'Something new' })),
    ).resolves.toBe('unchanged');
    expect(db.row()!.delivery_status).toBe('confirmed');
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('releases the label claim and throws when the email fails', async () => {
    const db = fakeSupabase(baseOrder);
    mocks.emailLabelToStudio.mockRejectedValue(new Error('resend down'));

    await expect(
      applySendcloudParcelUpdate({ supabase: db.client, getLabelPdf }, update({ id: 1000, message: 'Ready to send' })),
    ).rejects.toThrow('resend down');
    expect(db.row()!.inpost_label_emailed_at).toBeNull();
    expect(mocks.emailShippingConfirmationToCustomer).not.toHaveBeenCalled();
  });

  it('does not email the label once the parcel is past Ready to send', async () => {
    const db = fakeSupabase({ ...baseOrder, delivery_status: 'taken_by_courier' });
    await applySendcloudParcelUpdate({ supabase: db.client, getLabelPdf }, update({ message: 'Parcel en route' }));
    expect(mocks.emailLabelToStudio).not.toHaveBeenCalled();
    // The customer still gets their tracking email.
    expect(mocks.emailShippingConfirmationToCustomer).toHaveBeenCalledOnce();
  });
});
