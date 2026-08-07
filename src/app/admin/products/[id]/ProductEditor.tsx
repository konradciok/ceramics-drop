'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useAdminAction } from '@/components/admin/useAdminAction';
import { ConfirmModal } from '@/components/admin/ConfirmModal';
import type { EditorPieceState, ProductEditorState } from '@/lib/admin/catalog-list';
import type { ProductStatus } from '@/lib/catalog/types';
import type { PrintAssetCoverage } from '@/server/print-assets/types';

const STATUS_LABEL: Record<ProductStatus, string> = {
  draft: 'Szkic',
  active: 'Aktywny',
  hidden: 'Ukryty',
  archived: 'Archiwum',
};

const PIECE_STATUS_LABEL: Record<EditorPieceState['status'], string> = {
  available: 'Dostępny',
  reserved: 'Zarezerwowany',
  sold: 'Sprzedany',
};

const ERROR_MAP: Record<string, string> = {
  slug_taken: 'Ten slug jest już zajęty przez inny produkt.',
  product_not_found: 'Produkt nie istnieje jeszcze w bazie — uruchom catalog:backfill.',
  validation_failed: 'Popraw dane w formularzu.',
  print_assets_incomplete: 'Nie można aktywować — brakuje gotowych assetów dla wszystkich wariantów.',
  still_assigned: 'Asset jest nadal przypisany do aktywnego wariantu. Użyj wymuszenia lub opublikuj nową rewizję.',
  already_revoked: 'Asset jest już unieważniony.',
};

/** Initial field values derived from the server row — used as the dirty-check baseline. */
function initialValues(row: ProductEditorState['row']) {
  return {
    num: row.num,
    pricePln: row.price_pln?.toString() ?? '',
    measure: row.measure ?? '',
    seoTitle: row.seo_title ?? '',
    seoDesc: row.seo_description ?? '',
    slug: row.slug ?? '',
  };
}

/**
 * Client editor for one product. Metadata is saved in a single POST; publish
 * status flips via the /publish route. All mutations go through useAdminAction
 * (toast + router.refresh) and only affect the storefront in db mode.
 */
export function ProductEditor({ state }: { state: ProductEditorState }) {
  const { row } = state;
  const isCeramic = row.type === 'ceramic';
  // Before the backfill the DB row doesn't exist, so saves would 404 — lock the
  // mutating controls (the page shows a "run catalog:backfill" banner).
  const locked = state.source === 'registry';
  const { run, busy } = useAdminAction();

  const init = useMemo(() => initialValues(row), [row]);

  const [num, setNum] = useState(init.num);
  const [pricePln, setPricePln] = useState(init.pricePln);
  const [measure, setMeasure] = useState(init.measure);
  const [seoTitle, setSeoTitle] = useState(init.seoTitle);
  const [seoDesc, setSeoDesc] = useState(init.seoDesc);
  const [slug, setSlug] = useState(init.slug);
  const [status, setStatus] = useState<ProductStatus>(row.status);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<{ assetId: string; force: boolean } | null>(null);
  const [confirmStatusDirty, setConfirmStatusDirty] = useState<null | ProductStatus>(null);

  // Baseline for dirty comparison — updated to current field values after a
  // successful save so the dirty flag clears on save.
  const savedValues = useRef(init);

  const dirty = useMemo(() => {
    const sv = savedValues.current;
    return (
      num !== sv.num ||
      pricePln !== sv.pricePln ||
      measure !== sv.measure ||
      seoTitle !== sv.seoTitle ||
      seoDesc !== sv.seoDesc ||
      slug !== sv.slug
    );
  }, [num, pricePln, measure, seoTitle, seoDesc, slug]);

  // Guard hard exits (tab close / reload / URL bar navigation).
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  // Guard soft navigations (App Router <Link> clicks don't trigger beforeunload).
  // Intercept same-origin anchor clicks without modifier keys or target=_blank.
  useEffect(() => {
    if (!dirty) return;
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const anchor = (e.target as HTMLElement | null)?.closest<HTMLAnchorElement>('a[href]');
      if (!anchor) return;
      if (anchor.target === '_blank') return;
      const href = anchor.getAttribute('href');
      if (!href || !href.startsWith('/')) return;
      if (!window.confirm('Masz niezapisane zmiany. Opuścić stronę?')) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [dirty]);

  const savePath = `/api/admin/products/${row.id}`;
  const publishPath = `${savePath}/publish`;
  const printAssetsState = state.printAssets;
  const printCoverage = printAssetsState.status === 'ok' ? printAssetsState.coverage : null;
  const canActivatePrint =
    isCeramic ||
    printAssetsState.status === 'na' ||
    (printAssetsState.status === 'ok' && printAssetsState.coverage.ready);

  async function saveMeta() {
    const body: Record<string, unknown> = {
      num: num.trim(),
      seo_title: seoTitle,
      seo_description: seoDesc,
      slug,
    };
    if (isCeramic) {
      // Send the raw number (no truncation) so the server Zod integer check
      // rejects a decimal/NaN with validation_failed instead of us silently
      // rounding it — the operator sees the error rather than a wrong price.
      if (pricePln.trim() !== '') body.price_pln = Number(pricePln);
      body.measure = measure;
    }
    const ok = await run('save', savePath, { body, successText: 'Zapisano zmiany.', errorMap: ERROR_MAP });
    if (ok) {
      // Update the dirty baseline so the flag clears and subsequent edits are
      // measured against the just-saved values.
      savedValues.current = { num, pricePln, measure, seoTitle, seoDesc, slug };
    }
  }

  async function setPublish(next: ProductStatus) {
    // If there are unsaved metadata edits, confirm before the status transition
    // (router.refresh won't lose the field values, but the operator may believe
    // the click also saved their metadata edits — this prevents that confusion).
    if (dirty) {
      setConfirmStatusDirty(next);
      return;
    }
    await doPublish(next);
  }

  async function doPublish(next: ProductStatus) {
    const ok = await run(`status:${next}`, publishPath, {
      body: { status: next },
      successText: `Status: ${STATUS_LABEL[next]}.`,
      errorMap: ERROR_MAP,
    });
    if (ok) setStatus(next);
  }

  function handleArchive() {
    if (dirty) {
      setConfirmStatusDirty('archived');
      return;
    }
    setConfirmArchive(true);
  }

  return (
    <div className="adm-detail-layout">
      <div className="adm-detail-main">
        <section className="adm-editor">
          <h2 className="adm-h">Podstawowe</h2>
          <label className="adm-note-label">
            Numer wyświetlany
            <input value={num} onChange={(e) => setNum(e.target.value)} />
          </label>
          {isCeramic ? (
            <>
              <label className="adm-note-label">
                Cena (PLN, zł)
                <input type="number" min={0} step={1} value={pricePln} onChange={(e) => setPricePln(e.target.value)} />
              </label>
              <label className="adm-note-label">
                Wymiary
                <input value={measure} onChange={(e) => setMeasure(e.target.value)} />
              </label>
            </>
          ) : (
            <p className="adm-muted">Warianty i ceny druków są w rejestrze kodu; assety fulfilment poniżej.</p>
          )}
        </section>

        <section className="adm-editor">
          <h2 className="adm-h">SEO</h2>
          <label className="adm-note-label">
            Meta title
            <input
              value={seoTitle}
              onChange={(e) => setSeoTitle(e.target.value)}
              placeholder="Domyślnie: nazwa Nº numer"
            />
          </label>
          <label className="adm-note-label">
            Meta description
            <textarea
              value={seoDesc}
              onChange={(e) => setSeoDesc(e.target.value)}
              rows={3}
              placeholder="Domyślnie: opis produktu"
            />
          </label>
          <label className="adm-note-label">
            Slug (SEO/canonical — URL nadal używa id)
            <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="np. kubek-lazur" />
          </label>
        </section>

        {!isCeramic && printAssetsState.status === 'ok' && (
          <PrintAssetCoveragePanel
            coverage={printCoverage!}
            locked={locked}
            busy={busy}
            onRevoke={(assetId, force) => setRevokeTarget({ assetId, force })}
          />
        )}
        {!isCeramic && printAssetsState.status === 'error' && (
          <section className="adm-editor">
            <p className="adm-muted">
              Nie udało się wczytać pokrycia assetów — odśwież stronę lub sprawdź logi serwera.
            </p>
          </section>
        )}

        <div className="adm-actions">
          <button className="adm-btn" disabled={busy !== null || locked} onClick={saveMeta}>
            {busy === 'save' ? 'Zapisywanie…' : 'Zapisz zmiany'}
          </button>
          {dirty && <span className="adm-action-msg">Niezapisane zmiany</span>}
        </div>
      </div>

      <aside className="adm-detail-side">
        <section className="adm-editor">
          <h2 className="adm-h">Publikacja</h2>
          <p>
            Aktualny status: <strong>{STATUS_LABEL[status]}</strong>
          </p>
          <div className="adm-actions">
            {status !== 'active' && (
              <button
                className="adm-btn"
                disabled={busy !== null || locked || (!isCeramic && !canActivatePrint)}
                onClick={() => setPublish('active')}
                title={
                  !isCeramic && !canActivatePrint
                    ? printAssetsState.status === 'error'
                      ? 'Nie udało się zweryfikować gotowości assetów'
                      : `Brakujące warianty: ${printCoverage?.missing.join(', ') ?? ''}`
                    : undefined
                }
              >
                Aktywuj
              </button>
            )}
            {status !== 'draft' && (
              <button className="adm-btn" disabled={busy !== null || locked} onClick={() => setPublish('draft')}>
                Do szkicu
              </button>
            )}
            {status !== 'hidden' && (
              <button className="adm-btn" disabled={busy !== null || locked} onClick={() => setPublish('hidden')}>
                Ukryj
              </button>
            )}
            {status !== 'archived' && (
              <button className="adm-btn" disabled={busy !== null || locked} onClick={handleArchive}>
                Archiwizuj
              </button>
            )}
          </div>
          <p className="adm-muted">Status wpływa na sklep tylko w trybie CATALOG_SOURCE=db.</p>
          {!isCeramic && printAssetsState.status === 'error' && (
            <p className="adm-muted">
              Aktywacja zablokowana — nie udało się zweryfikować gotowości assetów.
            </p>
          )}
          {!isCeramic && printCoverage && !printCoverage.ready && (
            <p className="adm-muted">
              Aktywacja zablokowana — brak gotowych assetów dla:{' '}
              <span className="adm-mono">{printCoverage.missing.join(', ')}</span>. Użyj skryptów{' '}
              <span className="adm-mono">print-assets:*</span>.
            </p>
          )}
        </section>

        {isCeramic && state.pieceState && (
          <PieceStatePanel pieceState={state.pieceState} />
        )}
      </aside>

      <ConfirmModal
        open={confirmStatusDirty !== null}
        title="Masz niezapisane zmiany"
        message="Zmiana statusu nie zapisze edytowanych metadanych. Kontynuować?"
        confirmLabel="Kontynuuj"
        busy={busy !== null}
        onConfirm={() => {
          const next = confirmStatusDirty;
          setConfirmStatusDirty(null);
          if (next === null) return;
          if (next === 'archived') setConfirmArchive(true);
          else void doPublish(next);
        }}
        onCancel={() => setConfirmStatusDirty(null)}
      />

      <ConfirmModal
        open={revokeTarget !== null}
        title={revokeTarget?.force ? 'Wymusić unieważnienie assetu?' : 'Unieważnić asset?'}
        message={
          revokeTarget?.force
            ? 'Asset jest nadal przypisany do aktywnego wariantu. Po unieważnieniu produkt nie będzie możliwy do zakupu do czasu opublikowania nowej rewizji. Zamówienia historyczne przestaną pobierać ten plik (410).'
            : 'Unieważnienie to awaryjny stop — blokuje checkout i pobieranie przez Prodigi. Różni się od emerytury (retire), która zachowuje fulfilment historycznych zamówień.'
        }
        confirmLabel="Unieważnij"
        danger
        busy={busy !== null}
        onConfirm={() => {
          if (!revokeTarget) return;
          const { assetId, force } = revokeTarget;
          setRevokeTarget(null);
          void run(`revoke:${assetId}`, '/api/admin/revoke-print-asset', {
            body: { assetId, force },
            successText: 'Asset unieważniony.',
            errorMap: ERROR_MAP,
          });
        }}
        onCancel={() => setRevokeTarget(null)}
      />

      <ConfirmModal
        open={confirmArchive}
        title="Archiwizować produkt?"
        message="Produkt zniknie ze sklepu (soft-archive). Zamówienia i historia pozostają nienaruszone."
        confirmLabel="Archiwizuj"
        danger
        busy={busy !== null}
        onConfirm={() => {
          setConfirmArchive(false);
          void doPublish('archived');
        }}
        onCancel={() => setConfirmArchive(false)}
      />
    </div>
  );
}

function PieceStatePanel({ pieceState }: { pieceState: EditorPieceState }) {
  const fmtDate = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString('pl-PL') : '—';
  return (
    <section className="adm-editor">
      <h2 className="adm-h">Stan magazynowy</h2>
      <dl className="adm-dl">
        <dt>Status</dt>
        <dd>
          <span className={`adm-pill ${pieceState.status}`}>{PIECE_STATUS_LABEL[pieceState.status]}</span>
          {pieceState.status === 'reserved' && pieceState.reservedExpired && (
            <span className="adm-text-danger"> · wygasła</span>
          )}
        </dd>
        {pieceState.status === 'reserved' && (
          <>
            <dt>Rezerwacja do</dt>
            <dd>{fmtDate(pieceState.reserved_until)}</dd>
          </>
        )}
        {pieceState.order_id && (
          <>
            <dt>Zamówienie</dt>
            <dd>
              <Link className="adm-mono" href={`/admin/orders/${pieceState.order_id}`}>
                {pieceState.order_id.slice(0, 8)}
              </Link>
            </dd>
          </>
        )}
        {pieceState.showroom && (
          <>
            <dt>Showroom</dt>
            <dd>
              <span className="adm-pill showroom">showroom</span>
              {pieceState.showroom_entered_at && (
                <span className="adm-muted"> · od {fmtDate(pieceState.showroom_entered_at)}</span>
              )}
            </dd>
          </>
        )}
      </dl>
      <div className="adm-actions">
        <Link className="adm-btn" href="/admin/inventory">Zarządzaj w Magazynie →</Link>
      </div>
    </section>
  );
}

function PrintAssetCoveragePanel({
  coverage,
  locked,
  busy,
  onRevoke,
}: {
  coverage: PrintAssetCoverage;
  locked: boolean;
  busy: string | null;
  onRevoke: (assetId: string, force: boolean) => void;
}) {
  const uniqueAssets = new Map<
    string,
    NonNullable<PrintAssetCoverage['variants'][number]['asset']>
  >();
  for (const v of coverage.variants) {
    if (v.asset) uniqueAssets.set(v.asset.id, v.asset);
  }

  return (
    <section className="adm-editor">
      <h2 className="adm-h">Assety fulfilment (R2)</h2>
      <p>
        Gotowość:{' '}
        <strong>{coverage.ready ? 'kompletna' : 'niekompletna'}</strong> ·{' '}
        {coverage.totalActiveVariants} aktywnych wariantów
      </p>
      <div className="adm-tablewrap">
        <table className="adm-table adm-table--stack">
          <thead>
            <tr>
              <th>Wariant</th>
              <th>Obszar druku</th>
              <th>Rewizja</th>
              <th>Status</th>
              <th>Zweryfikowano</th>
              <th>Gotowy</th>
            </tr>
          </thead>
          <tbody>
            {coverage.variants.map((v) => (
              <tr key={v.variantKey}>
                <td className="adm-mono">{v.variantKey}</td>
                <td>
                  {v.printAreaWidthPx ?? '—'}×{v.printAreaHeightPx ?? '—'} px
                </td>
                <td>{v.asset?.revision ?? '—'}</td>
                <td>{v.asset?.status ?? 'brak'}</td>
                <td>{v.asset?.verifiedAt ? new Date(v.asset.verifiedAt).toLocaleString('pl-PL') : '—'}</td>
                <td>{v.usable ? 'tak' : 'nie'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {uniqueAssets.size > 0 && (
        <div className="adm-actions">
          {[...uniqueAssets.values()].map((asset) => (
            <button
              key={asset.id}
              className="adm-btn"
              disabled={locked || busy !== null || asset.status === 'revoked'}
              onClick={() =>
                onRevoke(
                  asset.id,
                  coverage.variants.some((v) => v.asset?.id === asset.id && v.usable),
                )
              }
            >
              Unieważnij {asset.revision || asset.id.slice(0, 8)}
            </button>
          ))}
        </div>
      )}
      <p className="adm-muted">
        Przygotowanie i publikacja przez <span className="adm-mono">npm run print-assets:*</span>.
        Unieważnienie (revoke) to awaryjny stop; emerytura (retire) zachowuje fulfilment historycznych zamówień.
      </p>
    </section>
  );
}
