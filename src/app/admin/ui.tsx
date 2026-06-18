/* LOCAL-ONLY admin presentational helpers (server-safe). */

const DATE_FMT = new Intl.DateTimeFormat('pl-PL', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Europe/Warsaw',
});

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : DATE_FMT.format(d);
}

const DELIVERY_LABEL: Record<string, string> = {
  paczkomat: 'Paczkomat',
  kurier: 'Kurier',
  odbior: 'Odbiór osobisty',
};

export function deliveryLabel(method: string | null | undefined): string {
  if (!method) return '—';
  return DELIVERY_LABEL[method] ?? method;
}

export function StatusPill({ status }: { status: string }) {
  return <span className={`adm-pill ${status}`}>{status}</span>;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** Phone collected at checkout (`orders.receiver_phone`). Empty for odbiór osobisty. */
export function PhoneLink({ phone }: { phone: string | null | undefined }) {
  const p = phone?.trim();
  if (!p) return <span className="adm-muted">—</span>;
  return <a className="adm-mono" href={`tel:${p}`}>{p}</a>;
}

/** E-mail + optional phone for order/customer list rows. */
export function ClientContact({
  email,
  phone,
}: {
  email: string | null | undefined;
  phone: string | null | undefined;
}) {
  const p = phone?.trim();
  return (
    <div className="adm-contact">
      <div>{email ?? <span className="adm-muted">—</span>}</div>
      {p ? <div className="adm-contact-phone"><PhoneLink phone={p} /></div> : null}
    </div>
  );
}
