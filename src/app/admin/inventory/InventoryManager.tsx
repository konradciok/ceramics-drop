'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

export type InterestEntry = {
  email: string;
  message: string | null;
  consent: boolean;
  createdAt: string;
};

export type InventoryRow = {
  productId: string;
  label: string;
  known: boolean;
  status: 'available' | 'reserved' | 'sold';
  showroom: boolean;
  dropId: string | null;
  reservedUntilLabel: string;
  reservedExpired: boolean;
  orderId: string | null;
  interest: InterestEntry[];
};

export type DropInfo = { id: string; label: string; status: 'active' | 'ended' };

type Msg = { ok: boolean; text: string } | null;

const ALL = '__all__';

export function InventoryManager({ rows, drops }: { rows: InventoryRow[]; drops: DropInfo[] }) {
  const router = useRouter();
  const [dropFilter, setDropFilter] = useState<string>(ALL);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  const visible = useMemo(
    () => (dropFilter === ALL ? rows : rows.filter((r) => r.dropId === dropFilter)),
    [rows, dropFilter],
  );

  const selectedDrop = dropFilter === ALL ? null : drops.find((d) => d.id === dropFilter) ?? null;

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => {
      if (visible.every((r) => prev.has(r.productId))) return new Set();
      return new Set(visible.map((r) => r.productId));
    });
  }

  async function post(path: string, body: unknown) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setMsg({ ok: true, text: data.message || 'Gotowe.' });
      setSelected(new Set());
      router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'Błąd' });
    } finally {
      setBusy(false);
    }
  }

  const setShowroom = (productIds: string[], showroom: boolean) =>
    void post('/api/admin/toggle-showroom', { productIds, showroom });
  const setSold = (productIds: string[], sold: boolean) =>
    void post('/api/admin/set-piece-status', { productIds, sold });
  const endDrop = (dropId: string) => void post('/api/admin/end-drop', { dropId });

  const selectedIds = [...selected];
  const allChecked = visible.length > 0 && visible.every((r) => selected.has(r.productId));

  return (
    <>
      <div className="adm-actions" style={{ flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
        <label className="adm-muted" style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          Drop:
          <select value={dropFilter} onChange={(e) => setDropFilter(e.target.value)} className="adm-select">
            <option value={ALL}>Wszystkie</option>
            {drops.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label} {d.status === 'ended' ? '(zakończony)' : ''}
              </option>
            ))}
          </select>
        </label>

        {selectedDrop && selectedDrop.status === 'active' && (
          <button className="adm-btn danger" disabled={busy} onClick={() => endDrop(selectedDrop.id)}>
            Zakończ drop
          </button>
        )}

        {selectedIds.length > 0 && (
          <>
            <span className="adm-muted">Zaznaczono: {selectedIds.length}</span>
            <button className="adm-btn" disabled={busy} onClick={() => setShowroom(selectedIds, true)}>
              Przenieś do showroomu
            </button>
            <button className="adm-btn" disabled={busy} onClick={() => setShowroom(selectedIds, false)}>
              Usuń z showroomu
            </button>
            <button className="adm-btn" disabled={busy} onClick={() => setSold(selectedIds, true)}>
              Oznacz jako sprzedane
            </button>
            <button className="adm-btn" disabled={busy} onClick={() => setSold(selectedIds, false)}>
              Przywróć dostępność
            </button>
          </>
        )}
      </div>

      {msg && <p className={`adm-action-msg ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</p>}

      <div className="adm-tablewrap">
        <table className="adm-table adm-table--stack">
          <thead>
            <tr>
              <th>
                <input type="checkbox" checked={allChecked} onChange={toggleAll} aria-label="Zaznacz wszystkie" />
              </th>
              <th>Praca</th>
              <th>ID</th>
              <th>Status</th>
              <th>Showroom</th>
              <th>Zainteresowani</th>
              <th>Akcje</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.productId}>
                <td data-label="">
                  <input
                    type="checkbox"
                    checked={selected.has(r.productId)}
                    onChange={() => toggleOne(r.productId)}
                    aria-label={`Zaznacz ${r.productId}`}
                  />
                </td>
                <td data-label="Praca">
                  {r.label}
                  {!r.known && <span className="adm-muted"> (wycofany)</span>}
                  {r.dropId && <span className="adm-muted"> · {r.dropId}</span>}
                </td>
                <td className="adm-mono" data-label="ID">{r.productId}</td>
                <td data-label="Status">
                  <span className={`adm-pill ${r.status}`}>{r.status}</span>
                  {r.status === 'reserved' && r.reservedUntilLabel !== '—' && (
                    <span className="adm-muted"> · do {r.reservedUntilLabel}</span>
                  )}
                  {r.reservedExpired && <span className="adm-text-danger"> · wygasła</span>}
                </td>
                <td data-label="Showroom">
                  {r.showroom ? <span className="adm-pill showroom">showroom</span> : <span className="adm-muted">—</span>}
                </td>
                <td data-label="Zainteresowani">
                  {r.interest.length > 0 ? (
                    <button
                      className="adm-linkbtn"
                      onClick={() => setExpanded(expanded === r.productId ? null : r.productId)}
                    >
                      {r.interest.length}
                    </button>
                  ) : (
                    <span className="adm-muted">0</span>
                  )}
                  {expanded === r.productId && (
                    <ul className="adm-interest-list">
                      {r.interest.map((it, i) => (
                        <li key={i}>
                          <a href={`mailto:${it.email}`} className="adm-mono">{it.email}</a>
                          {it.consent && <span className="adm-muted"> · zgoda</span>}
                          <span className="adm-muted"> · {it.createdAt}</span>
                          {it.message && <div className="adm-interest-msg">{it.message}</div>}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td data-label="Akcje">
                  {r.orderId ? (
                    <Link className="adm-mono" href={`/admin/orders/${r.orderId}`}>zamówienie</Link>
                  ) : null}
                  <button
                    className="adm-btn"
                    disabled={busy}
                    onClick={() => setShowroom([r.productId], !r.showroom)}
                    style={{ marginLeft: r.orderId ? 8 : 0 }}
                  >
                    {r.showroom ? 'Usuń z showroomu' : 'Do showroomu'}
                  </button>
                  {r.status === 'available' && (
                    <button
                      className="adm-btn"
                      disabled={busy}
                      onClick={() => setSold([r.productId], true)}
                      style={{ marginLeft: 8 }}
                    >
                      Oznacz jako sprzedane
                    </button>
                  )}
                  {r.status === 'sold' && !r.orderId && (
                    <button
                      className="adm-btn"
                      disabled={busy}
                      onClick={() => setSold([r.productId], false)}
                      style={{ marginLeft: 8 }}
                    >
                      Przywróć dostępność
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
