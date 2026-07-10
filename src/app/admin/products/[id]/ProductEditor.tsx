'use client';

import { useState } from 'react';
import { useAdminAction } from '@/components/admin/useAdminAction';
import { ConfirmModal } from '@/components/admin/ConfirmModal';
import type { ProductEditorState } from '@/lib/admin/catalog-list';
import type { ProductStatus } from '@/lib/catalog/types';

const STATUS_LABEL: Record<ProductStatus, string> = {
  draft: 'Szkic',
  active: 'Aktywny',
  hidden: 'Ukryty',
  archived: 'Archiwum',
};

const ERROR_MAP: Record<string, string> = {
  slug_taken: 'Ten slug jest już zajęty przez inny produkt.',
  product_not_found: 'Produkt nie istnieje jeszcze w bazie — uruchom catalog:backfill.',
  validation_failed: 'Popraw dane w formularzu.',
};

/**
 * Client editor for one product. Metadata is saved in a single POST; publish
 * status flips via the /publish route. All mutations go through useAdminAction
 * (toast + router.refresh) and only affect the storefront in db mode.
 */
export function ProductEditor({ state }: { state: ProductEditorState }) {
  const { row } = state;
  const isCeramic = row.type === 'ceramic';
  const { run, busy } = useAdminAction();

  const [num, setNum] = useState(row.num);
  const [pricePln, setPricePln] = useState(row.price_pln?.toString() ?? '');
  const [measure, setMeasure] = useState(row.measure ?? '');
  const [seoTitle, setSeoTitle] = useState(row.seo_title ?? '');
  const [seoDesc, setSeoDesc] = useState(row.seo_description ?? '');
  const [slug, setSlug] = useState(row.slug ?? '');
  const [status, setStatus] = useState<ProductStatus>(row.status);
  const [confirmArchive, setConfirmArchive] = useState(false);

  const savePath = `/api/admin/products/${row.id}`;
  const publishPath = `${savePath}/publish`;

  async function saveMeta() {
    const body: Record<string, unknown> = {
      num: num.trim(),
      seo_title: seoTitle,
      seo_description: seoDesc,
      slug,
    };
    if (isCeramic) {
      const n = Number(pricePln);
      if (pricePln.trim() !== '' && Number.isFinite(n)) body.price_pln = Math.trunc(n);
      body.measure = measure;
    }
    await run('save', savePath, { body, successText: 'Zapisano zmiany.', errorMap: ERROR_MAP });
  }

  async function setPublish(next: ProductStatus) {
    const ok = await run(`status:${next}`, publishPath, {
      body: { status: next },
      successText: `Status: ${STATUS_LABEL[next]}.`,
      errorMap: ERROR_MAP,
    });
    if (ok) setStatus(next);
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
                <input type="number" min={0} value={pricePln} onChange={(e) => setPricePln(e.target.value)} />
              </label>
              <label className="adm-note-label">
                Wymiary
                <input value={measure} onChange={(e) => setMeasure(e.target.value)} />
              </label>
            </>
          ) : (
            <p className="adm-muted">Ceny i warianty druków będą edytowane w kolejnym etapie.</p>
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

        <div className="adm-actions">
          <button className="adm-btn" disabled={busy !== null} onClick={saveMeta}>
            {busy === 'save' ? 'Zapisywanie…' : 'Zapisz zmiany'}
          </button>
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
              <button className="adm-btn" disabled={busy !== null} onClick={() => setPublish('active')}>
                Aktywuj
              </button>
            )}
            {status !== 'draft' && (
              <button className="adm-btn" disabled={busy !== null} onClick={() => setPublish('draft')}>
                Do szkicu
              </button>
            )}
            {status !== 'hidden' && (
              <button className="adm-btn" disabled={busy !== null} onClick={() => setPublish('hidden')}>
                Ukryj
              </button>
            )}
            {status !== 'archived' && (
              <button className="adm-btn" disabled={busy !== null} onClick={() => setConfirmArchive(true)}>
                Archiwizuj
              </button>
            )}
          </div>
          <p className="adm-muted">Status wpływa na sklep tylko w trybie CATALOG_SOURCE=db.</p>
        </section>
      </aside>

      <ConfirmModal
        open={confirmArchive}
        title="Archiwizować produkt?"
        message="Produkt zniknie ze sklepu (soft-archive). Zamówienia i historia pozostają nienaruszone."
        confirmLabel="Archiwizuj"
        danger
        busy={busy !== null}
        onConfirm={() => {
          setConfirmArchive(false);
          void setPublish('archived');
        }}
        onCancel={() => setConfirmArchive(false)}
      />
    </div>
  );
}
