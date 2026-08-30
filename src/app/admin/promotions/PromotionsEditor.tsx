'use client';

/* ============================================================
   PromotionsEditor — operator management of promo codes. A table of existing
   promotions (status, utilization stats from the redemption ledger + orders
   join) with per-row activate/deactivate and inline edit, plus a "Nowa
   promocja" create form. Pricing-editor idiom: postJson helper, per-field
   adm-field-error from the server zod parse, shared toast stack,
   router.refresh() after every successful mutation. `code` is immutable after
   creation — the edit form renders it disabled and never sends it.
   ============================================================ */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useToast } from '@/components/admin/Toast';
import type { PromoWithStats } from '@/lib/admin/promotions';
import { datetimeLocalToIso, isoToDatetimeLocal, majorToMinor } from './promo-form';

type FieldErrors = Record<string, string>;

const ERROR_MAP: Record<string, string> = {
  validation_failed: 'Popraw dane w formularzu.',
  invalid_json: 'Nieprawidłowe żądanie.',
  invalid_code: 'Kod musi mieć 3–32 znaki: litery, cyfry, „-” lub „_”.',
  code_exists: 'Taki kod już istnieje.',
  code_immutable: 'Kodu nie można zmienić po utworzeniu.',
  newsletter_welcome_taken: 'Inna aktywna promocja jest już oznaczona jako powitalna newslettera.',
  not_found: 'Nie znaleziono promocji.',
  promo_write_failed: 'Zapis nie powiódł się. Spróbuj ponownie lub sprawdź logi serwera.',
};

const APPLIES_LABEL: Record<string, string> = {
  all: 'Wszystko',
  ceramics: 'Ceramika',
  prints: 'Printy',
};

async function sendJson(path: string, method: 'POST' | 'PATCH', body: unknown) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; fields?: FieldErrors };
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`) as Error & { fields?: FieldErrors };
    err.fields = data.fields;
    throw err;
  }
  return data;
}

const CUR_SUFFIX = { pln: 'zł', eur: '€', gbp: '£' } as const;

/** "14 zł · 10 € " — only currencies with a non-zero amount; '—' when all zero. */
function fmtPerCurrency(minor: { pln: number; eur: number; gbp: number }): string {
  const parts = (Object.keys(CUR_SUFFIX) as Array<keyof typeof CUR_SUFFIX>)
    .filter((c) => minor[c] !== 0)
    .map((c) => `${(minor[c] / 100).toLocaleString('pl-PL')} ${CUR_SUFFIX[c]}`);
  return parts.length > 0 ? parts.join(' · ') : '—';
}

function valueLabel(p: PromoWithStats): string {
  if (p.kind === 'percent') return `${p.percent}%`;
  return fmtPerCurrency({
    pln: p.amount_pln ?? 0,
    eur: p.amount_eur ?? 0,
    gbp: p.amount_gbp ?? 0,
  });
}

function statusLabel(p: PromoWithStats): { label: string; cls: string } {
  if (p.expires_at && Date.parse(p.expires_at) <= Date.now()) {
    return { label: 'Wygasła', cls: 'adm-pill expired' };
  }
  return p.active
    ? { label: 'Aktywna', cls: 'adm-pill promo-active' }
    : { label: 'Nieaktywna', cls: 'adm-pill promo-inactive' };
}

function windowLabel(p: PromoWithStats): string {
  const f = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString('pl-PL', { dateStyle: 'short', timeStyle: 'short' }) : '…';
  if (!p.starts_at && !p.expires_at) return 'bez ograniczeń';
  return `${f(p.starts_at)} → ${f(p.expires_at)}`;
}

// ── Shared create/edit form ──────────────────────────────────────────────────

type FormState = {
  code: string;
  kind: 'percent' | 'fixed';
  percent: string;
  amountPln: string; // major units in the UI
  amountEur: string;
  amountGbp: string;
  appliesTo: 'all' | 'ceramics' | 'prints';
  startsAt: string; // datetime-local value
  expiresAt: string;
  maxRedemptions: string;
  newsletterWelcome: boolean;
  campaign: string;
};

const EMPTY_FORM: FormState = {
  code: '',
  kind: 'percent',
  percent: '',
  amountPln: '',
  amountEur: '',
  amountGbp: '',
  appliesTo: 'all',
  startsAt: '',
  expiresAt: '',
  maxRedemptions: '',
  newsletterWelcome: false,
  campaign: '',
};

function fromPromo(p: PromoWithStats): FormState {
  return {
    code: p.code,
    kind: p.kind,
    percent: p.percent != null ? String(p.percent) : '',
    amountPln: p.amount_pln != null ? String(p.amount_pln / 100) : '',
    amountEur: p.amount_eur != null ? String(p.amount_eur / 100) : '',
    amountGbp: p.amount_gbp != null ? String(p.amount_gbp / 100) : '',
    appliesTo: p.applies_to,
    startsAt: isoToDatetimeLocal(p.starts_at),
    expiresAt: isoToDatetimeLocal(p.expires_at),
    maxRedemptions: p.max_redemptions != null ? String(p.max_redemptions) : '',
    newsletterWelcome: p.newsletter_welcome,
    campaign: p.campaign ?? '',
  };
}

/** API body from form state. `includeCode: false` for PATCH (immutable). */
function toBody(f: FormState, includeCode: boolean): Record<string, unknown> {
  return {
    ...(includeCode ? { code: f.code } : {}),
    kind: f.kind,
    percent: f.kind === 'percent' && f.percent.trim() !== '' ? Number(f.percent) : null,
    amount_pln: f.kind === 'fixed' ? majorToMinor(f.amountPln) : null,
    amount_eur: f.kind === 'fixed' ? majorToMinor(f.amountEur) : null,
    amount_gbp: f.kind === 'fixed' ? majorToMinor(f.amountGbp) : null,
    applies_to: f.appliesTo,
    starts_at: datetimeLocalToIso(f.startsAt),
    expires_at: datetimeLocalToIso(f.expiresAt),
    max_redemptions: f.maxRedemptions.trim() !== '' ? Number(f.maxRedemptions) : null,
    newsletter_welcome: f.newsletterWelcome,
    campaign: f.campaign.trim() !== '' ? f.campaign.trim() : null,
  };
}

function PromoForm({
  initial,
  codeLocked,
  busy,
  errors,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: FormState;
  codeLocked: boolean;
  busy: boolean;
  errors: FieldErrors;
  submitLabel: string;
  onSubmit: (form: FormState) => void;
  onCancel?: () => void;
}) {
  const [form, setForm] = useState(initial);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const fieldError = (key: string) =>
    errors[key] ? <span className="adm-field-error">{errors[key]}</span> : null;

  return (
    <div className="adm-editor">
      <div className="adm-promo-grid">
        <label className="adm-note-label">
          Kod (3–32 znaki, bez spacji)
          <input
            value={form.code}
            onChange={(e) => set('code', e.target.value.toUpperCase())}
            disabled={codeLocked}
            placeholder="WELCOME10"
            data-testid="promo-admin-code"
          />
          {codeLocked && <span className="adm-muted">Kod jest stały po utworzeniu.</span>}
          {fieldError('code')}
        </label>
        <label className="adm-note-label">
          Rodzaj
          <select value={form.kind} onChange={(e) => set('kind', e.target.value as FormState['kind'])}>
            <option value="percent">Procentowy</option>
            <option value="fixed">Kwotowy</option>
          </select>
        </label>
        {form.kind === 'percent' ? (
          <label className="adm-note-label">
            Procent (1–100)
            <input
              type="number"
              min={1}
              max={100}
              value={form.percent}
              onChange={(e) => set('percent', e.target.value)}
            />
            {fieldError('percent')}
          </label>
        ) : (
          <>
            <label className="adm-note-label">
              Kwota PLN (zł)
              <input type="number" min={0} value={form.amountPln} onChange={(e) => set('amountPln', e.target.value)} />
              {fieldError('amount_pln')}
            </label>
            <label className="adm-note-label">
              Kwota EUR (€)
              <input type="number" min={0} value={form.amountEur} onChange={(e) => set('amountEur', e.target.value)} />
              {fieldError('amount_eur')}
            </label>
            <label className="adm-note-label">
              Kwota GBP (£)
              <input type="number" min={0} value={form.amountGbp} onChange={(e) => set('amountGbp', e.target.value)} />
              {fieldError('amount_gbp')}
            </label>
          </>
        )}
        <label className="adm-note-label">
          Dotyczy
          <select
            value={form.appliesTo}
            onChange={(e) => set('appliesTo', e.target.value as FormState['appliesTo'])}
          >
            <option value="all">Wszystkiego</option>
            <option value="ceramics">Tylko ceramiki</option>
            <option value="prints">Tylko printów</option>
          </select>
        </label>
        <label className="adm-note-label">
          Obowiązuje od (opcjonalnie)
          <input type="datetime-local" value={form.startsAt} onChange={(e) => set('startsAt', e.target.value)} />
          {fieldError('starts_at')}
        </label>
        <label className="adm-note-label">
          Obowiązuje do (opcjonalnie)
          <input type="datetime-local" value={form.expiresAt} onChange={(e) => set('expiresAt', e.target.value)} />
          {fieldError('expires_at')}
        </label>
        <label className="adm-note-label">
          Limit użyć (opcjonalnie)
          <input
            type="number"
            min={1}
            value={form.maxRedemptions}
            onChange={(e) => set('maxRedemptions', e.target.value)}
          />
          {fieldError('max_redemptions')}
        </label>
        <label className="adm-note-label">
          Kampania (etykieta, opcjonalnie)
          <input value={form.campaign} onChange={(e) => set('campaign', e.target.value)} maxLength={120} />
          {fieldError('campaign')}
        </label>
        <label className="adm-note-label adm-promo-check">
          <input
            type="checkbox"
            checked={form.newsletterWelcome}
            onChange={(e) => set('newsletterWelcome', e.target.checked)}
          />
          Kod powitalny newslettera (maks. jedna aktywna promocja)
          {fieldError('newsletter_welcome')}
        </label>
      </div>
      <div className="adm-actions">
        <button className="adm-btn" disabled={busy} onClick={() => onSubmit(form)} data-testid="promo-admin-submit">
          {busy ? 'Zapisywanie…' : submitLabel}
        </button>
        {onCancel && (
          <button className="adm-btn" disabled={busy} onClick={onCancel}>
            Anuluj
          </button>
        )}
      </div>
    </div>
  );
}

// ── Main editor ──────────────────────────────────────────────────────────────

export function PromotionsEditor({ promotions }: { promotions: PromoWithStats[] }) {
  const router = useRouter();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});

  async function run(action: () => Promise<unknown>, successMsg: string) {
    setBusy(true);
    setErrors({});
    try {
      await action();
      toast.notify(true, successMsg);
      setCreating(false);
      setEditingId(null);
      router.refresh();
    } catch (err) {
      const e = err as Error & { fields?: FieldErrors };
      setErrors(e.fields ?? {});
      toast.notify(false, ERROR_MAP[e.message] ?? e.message);
    } finally {
      setBusy(false);
    }
  }

  const create = (form: FormState) =>
    run(() => sendJson('/api/admin/promotions', 'POST', toBody(form, true)), 'Promocja utworzona.');
  const update = (id: string) => (form: FormState) =>
    run(() => sendJson(`/api/admin/promotions/${id}`, 'PATCH', toBody(form, false)), 'Promocja zapisana.');
  const toggle = (p: PromoWithStats) =>
    run(
      () => sendJson(`/api/admin/promotions/${p.id}`, 'PATCH', { active: !p.active }),
      p.active ? 'Promocja dezaktywowana.' : 'Promocja aktywowana.',
    );

  return (
    <>
      <div className="adm-actions" style={{ marginBottom: 16 }}>
        {!creating && (
          <button className="adm-btn" onClick={() => { setCreating(true); setEditingId(null); setErrors({}); }} data-testid="promo-admin-new">
            Nowa promocja
          </button>
        )}
      </div>
      {creating && (
        <PromoForm
          initial={EMPTY_FORM}
          codeLocked={false}
          busy={busy}
          errors={errors}
          submitLabel="Utwórz promocję"
          onSubmit={create}
          onCancel={() => { setCreating(false); setErrors({}); }}
        />
      )}

      <div className="adm-tablewrap">
        <table className="adm-table">
          <thead>
            <tr>
              <th>Kod</th>
              <th>Wartość</th>
              <th>Dotyczy</th>
              <th>Okres</th>
              <th>Status</th>
              <th>Użycia</th>
              <th>Udzielony rabat</th>
              <th>Przychód</th>
              <th>Ostatnie użycie</th>
              <th>Akcje</th>
            </tr>
          </thead>
          <tbody>
            {promotions.length === 0 && (
              <tr>
                <td colSpan={10} className="adm-muted">
                  Brak promocji — utwórz pierwszą przyciskiem powyżej.
                </td>
              </tr>
            )}
            {promotions.map((p) => {
              const status = statusLabel(p);
              return (
                <tr key={p.id} data-testid={`promo-row-${p.code}`}>
                  <td>
                    <strong>{p.code}</strong>
                    {p.newsletter_welcome && <span className="adm-pill promo-newsletter">newsletter</span>}
                    {p.campaign && <div className="adm-muted">{p.campaign}</div>}
                  </td>
                  <td>{valueLabel(p)}</td>
                  <td>{APPLIES_LABEL[p.applies_to]}</td>
                  <td>{windowLabel(p)}</td>
                  <td>
                    <span className={status.cls}>{status.label}</span>
                  </td>
                  <td className="adm-num">
                    {p.stats.redeemed}
                    {p.max_redemptions != null ? ` / ${p.max_redemptions}` : ''}
                    {p.stats.pending > 0 && <span className="adm-muted"> (+{p.stats.pending} w toku)</span>}
                  </td>
                  <td className="adm-num">{fmtPerCurrency(p.stats.discount_given_minor)}</td>
                  <td className="adm-num">{fmtPerCurrency(p.stats.revenue_minor)}</td>
                  <td>
                    {p.stats.last_redeemed_at
                      ? new Date(p.stats.last_redeemed_at).toLocaleString('pl-PL', { dateStyle: 'short', timeStyle: 'short' })
                      : '—'}
                  </td>
                  <td>
                    <div className="adm-actions">
                      <button className="adm-btn" disabled={busy} onClick={() => toggle(p)}>
                        {p.active ? 'Dezaktywuj' : 'Aktywuj'}
                      </button>
                      <button
                        className="adm-btn"
                        disabled={busy}
                        onClick={() => { setEditingId(editingId === p.id ? null : p.id); setCreating(false); setErrors({}); }}
                      >
                        Edytuj
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editingId && (() => {
        const p = promotions.find((x) => x.id === editingId);
        if (!p) return null;
        return (
          <PromoForm
            key={p.id}
            initial={fromPromo(p)}
            codeLocked
            busy={busy}
            errors={errors}
            submitLabel="Zapisz zmiany"
            onSubmit={update(p.id)}
            onCancel={() => { setEditingId(null); setErrors({}); }}
          />
        );
      })()}
    </>
  );
}
