#!/usr/bin/env node
/**
 * reconcile-orders.mjs — backfill missed transactional emails and stuck InPost
 * shipments for a set of production orders.
 *
 * PRODUCTION SAFETY: this script hits REAL services by default (Resend, InPost,
 * Supabase). It MUST be run with --dry-run first to confirm the target set.
 * Every write action requires an explicit flag; the default (no flags) is a
 * no-op preview.
 *
 * DRY-RUN NOTE: --dry-run makes NO writes or sends, but DOES perform read-only
 * Supabase SELECTs and InPost GETs to preview real state. This means
 * --dry-run --buy / --labels still requires INPOST_API_TOKEN (the live
 * shipment offer / status is fetched from InPost to show what would happen).
 *
 * Required env vars (in .dev.vars or --env-file):
 *   SUPABASE_URL                 — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY    — service-role key (all DB writes)
 *   RESEND_API_KEY               — Resend API key (--emails / --studio / --labels)
 *   STUDIO_NOTIFY_EMAIL          — studio inbox address (--studio / --labels)
 *   INPOST_API_URL               — ShipX base URL (--buy / --labels)
 *   INPOST_API_TOKEN             — ShipX Bearer token (--buy / --labels)
 *
 * NOTE: .dev.vars lives in the MAIN repo root (gitignored, not copied into git
 * worktrees). Run this script from the main checkout, or pass --env-file with
 * the absolute path to .dev.vars.
 *
 * Usage:
 *   node scripts/reconcile-orders.mjs [--dry-run] [--emails] [--studio]
 *     [--buy] [--labels] [--verbose] [--allow-nonprod] [--force-studio]
 *     [--env-file <path>] [order-id ...]
 *
 *   No action flag → dry-run preview of all discovered candidates + help.
 *
 * Examples:
 *   node scripts/reconcile-orders.mjs --dry-run --emails --buy --labels
 *   node scripts/reconcile-orders.mjs --emails --buy --labels
 *   node scripts/reconcile-orders.mjs --studio --force-studio
 *   node scripts/reconcile-orders.mjs --emails a015f38e-... 013ea1be-...
 */

import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';

// ── Email constants (mirrors src/lib/email-addresses.ts) ─────────────────────
const EMAIL_CONTACT = 'hej@ciok.art';
const EMAIL_FROM = 'Anna Ciok Studio <sklep@ciok.art>';

// ── Resend template aliases (mirrors src/lib/email-layout.ts) ─────────────────
const TEMPLATE_ALIASES = {
  labelStudio: 'label-to-studio',
  shippingConfirmation: 'shipping-confirmation',
};

// ── Production guard constants ────────────────────────────────────────────────
const EXPECTED_SUPABASE_REF = 'wnlysejenowymjdxlnaq';
const EXPECTED_INPOST_HOST = 'api-shipx-pl.easypack24.net';

// ── InPost / ShipX constants ──────────────────────────────────────────────────
const LABEL_READY_STATUS = 'confirmed';

// ── Studio-email discovery window (2026-06-10 17:00 UTC onwards) ──────────────
const STUDIO_EMAIL_SINCE = '2026-06-10T17:00:00Z';

// ─────────────────────────────────────────────────────────────────────────────
// HTML email helpers (mirrors src/lib/email-layout.ts — inline, no import)
// ─────────────────────────────────────────────────────────────────────────────

const BODY_STYLE =
  'font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:24px;color:#3A2818;';
const MUTED_STYLE =
  'font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:22px;color:rgba(58,40,24,0.75);';
const LABEL_STYLE =
  'font-family:Helvetica,Arial,sans-serif;font-size:11px;line-height:16px;letter-spacing:0.14em;text-transform:uppercase;color:rgba(58,40,24,0.55);';

function emailParagraph(html) {
  return `<p style="margin-top:0;margin-bottom:16px;${BODY_STYLE}">${html}</p>`;
}
function emailMutedParagraph(html) {
  return `<p style="margin-top:0;margin-bottom:16px;${MUTED_STYLE}">${html}</p>`;
}
function emailDetailTable(rows) {
  const cells = rows
    .map(
      (row) => `<tr>
  <td style="padding-top:8px;padding-bottom:8px;padding-right:16px;vertical-align:top;${LABEL_STYLE}">${row.label}</td>
  <td style="padding-top:8px;padding-bottom:8px;vertical-align:top;${BODY_STYLE}">${row.value}</td>
</tr>`,
    )
    .join('');
  return `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:8px;margin-bottom:16px;">${cells}</table>`;
}

function resendTemplateHtml() {
  return `<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>Anna Ciok Ceramics</title>
</head>
<body style="margin:0;padding:0;background-color:#FAF6EC;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#FAF6EC" style="background-color:#FAF6EC;">
    <tr>
      <td align="center" style="padding-top:48px;padding-right:16px;padding-bottom:48px;padding-left:16px;">
        <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">
          <tr>
            <td align="center" style="padding-bottom:24px;">
              <img src="https://anna-ciok.studio/logotype.png" alt="Anna Ciok Ceramics" width="48" height="48" border="0" style="display:block;" />
            </td>
          </tr>
          <tr>
            <td bgcolor="#FAF6EC" style="background-color:#FAF6EC;border-top-width:1px;border-top-style:solid;border-top-color:rgba(58,40,24,0.08);border-right-width:1px;border-right-style:solid;border-right-color:rgba(58,40,24,0.08);border-bottom-width:1px;border-bottom-style:solid;border-bottom-color:rgba(58,40,24,0.08);border-left-width:1px;border-left-style:solid;border-left-color:rgba(58,40,24,0.08);">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="padding-top:40px;padding-right:40px;padding-bottom:40px;padding-left:40px;${BODY_STYLE}">
                    {{{MAIN_CONTENT}}}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding-top:24px;font-family:Helvetica,Arial,sans-serif;font-size:11px;line-height:16px;letter-spacing:0.16em;text-transform:uppercase;color:rgba(58,40,24,0.55);">
              Anna Ciok Ceramics · anna-ciok.studio
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Email HTML builders (mirrors src/lib/email.ts — inline, no import)
// ─────────────────────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatGrosze(grosze, currency) {
  return `${((grosze ?? 0) / 100).toFixed(2)} ${currency.toUpperCase()}`;
}

// I18N_ORDER_CONFIRMATION — mirrors src/lib/email.ts exactly
const I18N_ORDER_CONFIRMATION = {
  pl: {
    subject: 'Zamówienie przyjęte — Anna Ciok Ceramics',
    greeting: (name) => (name ? `Cześć ${name}` : 'Cześć'),
    thankYou: 'Dziękuję za zamówienie! Potwierdzam jego przyjęcie i wkrótce zajmę się pakowaniem.',
    deliveryTitle: 'Informacja o dostawie w lipcu',
    deliveryP1:
      'Wszystkie zamówienia na terenie Polski będą wysyłane za pośrednictwem InPost — kurierem lub do Paczkomatów.',
    deliveryP2:
      'Przyjeżdżamy do Polski 5 lipca. Wszystkie zamówienia złożone wcześniej zostaną wysłane od 10 lipca. Zamówienia składane później będą wysyłane w ciągu 1–3 dni od momentu złożenia zamówienia.',
    deliveryP3: 'Wysyłki będą realizowane od 10 lipca.',
    signOff: 'Do zobaczenia! Anna Ciok Studio',
  },
  en: {
    subject: 'Order confirmed — Anna Ciok Ceramics',
    greeting: (name) => (name ? `Hi ${name}` : 'Hi'),
    thankYou: "Thank you for your order! I've confirmed it and will start packing soon.",
    deliveryTitle: 'July delivery information',
    deliveryP1:
      'All orders in Poland will be shipped via InPost courier or InPost parcel lockers.',
    deliveryP2:
      'We arrive in Poland on 5 July. All orders placed earlier will be shipped from 10 July. Orders placed later will be shipped within 1–3 days after the order is placed.',
    deliveryP3: 'Shipping will take place in July, from 10 July.',
    signOff: 'Talk soon! Anna Ciok Studio',
  },
  es: {
    subject: 'Pedido confirmado — Anna Ciok Ceramics',
    greeting: (name) => (name ? `Hola ${name}` : 'Hola'),
    thankYou: '¡Gracias por tu pedido! Lo he confirmado y pronto empezaré a embalarlo.',
    deliveryTitle: 'Información sobre entregas en julio',
    deliveryP1:
      'Todos los pedidos dentro de Polonia se enviarán a través de InPost, por mensajería o a taquillas Paczkomaty.',
    deliveryP2:
      'Llegamos a Polonia el 5 de julio. Todos los pedidos realizados anteriormente se enviarán a partir del 10 de julio. Los pedidos realizados posteriormente se enviarán en un plazo de 1 a 3 días después de realizar el pedido.',
    deliveryP3: 'Los envíos se realizarán en julio, a partir del 10 de julio.',
    signOff: '¡Hasta pronto! Anna Ciok Studio',
  },
};

function resolveLocale(locale) {
  if (locale === 'pl' || locale === 'en' || locale === 'es') return locale;
  return 'pl';
}

/** Mirrors buildOrderConfirmationEmail — builds MAIN_CONTENT for the customer confirmation email. */
function buildOrderConfirmationMainContent(order, locale) {
  const loc = resolveLocale(locale);
  const t = I18N_ORDER_CONFIRMATION[loc];
  const firstName = order.receiver_first_name ? escapeHtml(order.receiver_first_name) : null;
  const greeting = t.greeting(firstName);

  return [
    emailParagraph(`${greeting},`),
    emailParagraph(t.thankYou),
    emailParagraph(`<strong>${escapeHtml(t.deliveryTitle)}</strong>`),
    emailParagraph(t.deliveryP1),
    emailParagraph(t.deliveryP2),
    emailMutedParagraph(t.deliveryP3),
    emailMutedParagraph(t.signOff),
  ].join('');
}

/** Mirrors buildNewOrderToStudioEmail — builds MAIN_CONTENT for the studio new-order email. */
function buildNewOrderToStudioMainContent(order) {
  const receiver = [order.receiver_first_name, order.receiver_last_name]
    .filter(Boolean)
    .join(' ')
    .trim();
  const customer = [receiver, order.email].filter(Boolean).join(' · ') || '—';
  const methodLabel =
    order.delivery_method === 'paczkomat'
      ? 'Paczkomat'
      : order.delivery_method === 'kurier'
        ? 'Kurier'
        : 'Odbiór osobisty';

  const rows = [
    { label: 'Zamówienie', value: escapeHtml(order.id) },
    { label: 'Klient', value: escapeHtml(customer) },
    { label: 'Dostawa', value: methodLabel },
  ];
  if (order.inpost_target_point) {
    rows.push({ label: 'Paczkomat', value: escapeHtml(order.inpost_target_point) });
  }
  rows.push({ label: 'Pozycje', value: String(order.items.length) });
  rows.push({ label: 'Razem', value: formatGrosze(order.total, order.currency) });

  const itemLines = order.items
    .map((it) => `${escapeHtml(it.product_id)} — ${formatGrosze(it.unit_price, order.currency)}`)
    .join('<br />');

  return [
    emailParagraph('<strong>Nowe opłacone zamówienie.</strong>'),
    emailDetailTable(rows),
    itemLines ? emailMutedParagraph(itemLines) : '',
  ].join('');
}

/** Mirrors buildLabelToStudioEmail — builds MAIN_CONTENT for the studio label email. */
function buildLabelToStudioMainContent(order) {
  const receiver = [order.receiver_first_name, order.receiver_last_name]
    .filter(Boolean)
    .join(' ')
    .trim();
  const methodLabel = order.delivery_method === 'paczkomat' ? 'Paczkomat' : 'Kurier';

  const rows = [
    { label: 'Zamówienie', value: escapeHtml(order.id) },
    { label: 'Odbiorca', value: escapeHtml(receiver || '—') },
    { label: 'Dostawa', value: methodLabel },
  ];
  if (order.inpost_target_point) {
    rows.push({ label: 'Paczkomat', value: escapeHtml(order.inpost_target_point) });
  }
  if (order.inpost_tracking_number) {
    rows.push({ label: 'Numer przesyłki', value: escapeHtml(order.inpost_tracking_number) });
  }

  return [
    emailParagraph('<strong>Nowa etykieta InPost do wydruku.</strong>'),
    emailMutedParagraph('Etykieta A6 jest w załączniku PDF.'),
    emailDetailTable(rows),
  ].join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// pickBuyableOffer (mirrors src/lib/shipx.ts — inline, no import)
// ─────────────────────────────────────────────────────────────────────────────

function pickBuyableOffer(shipment) {
  if (shipment.selected_offer?.id !== undefined && shipment.selected_offer.id !== null) {
    return String(shipment.selected_offer.id);
  }
  const found = (shipment.offers ?? []).find(
    (o) => o.status === 'available' || o.status === 'selected',
  );
  return found !== undefined ? String(found.id) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Env loading (no dotenv dep — parse .dev.vars ourselves)
// ─────────────────────────────────────────────────────────────────────────────

function loadEnvFile(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new Error(`Cannot read env file ${filePath}: ${err.message}`);
  }
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes (single or double)
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI arg parsing
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    dryRun: false,
    emails: false,
    studio: false,
    buy: false,
    labels: false,
    verbose: false,
    allowNonprod: false,
    forceStudio: false,
    envFile: null,
    orderIds: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') { args.dryRun = true; continue; }
    if (a === '--emails') { args.emails = true; continue; }
    if (a === '--studio') { args.studio = true; continue; }
    if (a === '--buy') { args.buy = true; continue; }
    if (a === '--labels') { args.labels = true; continue; }
    if (a === '--verbose') { args.verbose = true; continue; }
    if (a === '--allow-nonprod') { args.allowNonprod = true; continue; }
    if (a === '--force-studio') { args.forceStudio = true; continue; }
    if (a === '--env-file') {
      const val = argv[i + 1];
      if (!val || val.startsWith('--')) {
        console.error('ERROR: --env-file requires a path argument');
        process.exit(1);
      }
      args.envFile = val;
      i++;
      continue;
    }
    if (a.startsWith('--')) {
      console.error(`ERROR: Unknown flag: ${a}`);
      process.exit(1);
    }
    // Positional: order UUID
    if (/^[0-9a-f-]{8,}/i.test(a)) {
      args.orderIds.push(a);
    } else {
      console.error(`ERROR: Unrecognised argument: ${a}`);
      process.exit(1);
    }
  }

  // No action flags → implicit dry-run preview
  const anyAction = args.emails || args.studio || args.buy || args.labels;
  if (!anyAction) {
    args.dryRun = true;
    args.emails = true;
    args.studio = true;
    args.buy = true;
    args.labels = true;
    args.previewOnly = true;
  }

  return args;
}

// ─────────────────────────────────────────────────────────────────────────────
// Output helpers
// ─────────────────────────────────────────────────────────────────────────────

function redactEmail(email, verbose) {
  if (!email) return '(no email)';
  if (verbose) return email;
  const [local, domain] = email.split('@');
  if (!domain) return `${local[0]}***`;
  const domainParts = domain.split('.');
  const tld = domainParts.pop();
  const domainBase = domainParts.join('.');
  return `${local[0]}***@${domainBase[0]}***.${tld}`;
}

let hasErrors = false;

function log(msg) {
  console.log(msg);
}
function warn(msg) {
  console.warn(`⚠  ${msg}`);
}
function err(msg) {
  console.error(`✗  ${msg}`);
  hasErrors = true;
}
function ok(msg) {
  console.log(`✓  ${msg}`);
}
function dryLog(msg) {
  console.log(`[DRY RUN] ${msg}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Resend helpers
// ─────────────────────────────────────────────────────────────────────────────

async function resendPost(body, apiKey) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${detail.slice(0, 300)}`);
  }
  return res;
}

// ─────────────────────────────────────────────────────────────────────────────
// InPost / ShipX helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeInPost(env) {
  const baseUrl = env.INPOST_API_URL.replace(/\/+$/, '');
  const authHeader = `Bearer ${env.INPOST_API_TOKEN}`;

  async function request(reqPath, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let res;
    try {
      res = await fetch(`${baseUrl}${reqPath}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: authHeader,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...(init.headers ?? {}),
        },
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `InPost ${init.method ?? 'GET'} ${reqPath} → HTTP ${res.status}: ${detail.slice(0, 300)}`,
      );
    }
    return res;
  }

  return {
    async getShipment(id) {
      const res = await request(`/v1/shipments/${id}`);
      return res.json();
    },
    async buyShipment(id, offerId) {
      const offer_id =
        typeof offerId === 'string' && /^\d+$/.test(offerId) ? Number(offerId) : offerId;
      const res = await request(`/v1/shipments/${id}/buy`, {
        method: 'POST',
        body: JSON.stringify({ offer_id }),
      });
      return res.json();
    },
    async getLabelPdf(id) {
      const res = await request(`/v1/shipments/${id}/label?type=A6&format=pdf`, {
        headers: { Accept: 'application/pdf' },
      });
      return res.arrayBuffer();
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Polling helpers
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll for buyable offers: up to 6 attempts, 5 s apart. */
async function pollForBuyableOffer(inpost, shipmentId) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const shipment = await inpost.getShipment(shipmentId);
    if (shipment.status === LABEL_READY_STATUS) return { offerId: null, alreadyConfirmed: true, shipment };
    const offerId = pickBuyableOffer(shipment);
    if (offerId !== null) return { offerId, alreadyConfirmed: false, shipment };
    if (attempt < 6) {
      log(`  attempt ${attempt}/6: no buyable offer yet for shipment ${shipmentId}, waiting 5 s…`);
      await sleep(5000);
    }
  }
  return { offerId: null, alreadyConfirmed: false, shipment: null };
}

/** Poll until status === confirmed + tracking_number present; up to 5 attempts, 5 s apart. */
async function pollUntilConfirmed(inpost, shipmentId) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const shipment = await inpost.getShipment(shipmentId);
    if (shipment.status === LABEL_READY_STATUS && shipment.tracking_number) {
      return shipment;
    }
    if (attempt < 5) {
      log(`  attempt ${attempt}/5: shipment ${shipmentId} status=${shipment.status}, waiting 5 s…`);
      await sleep(5000);
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Action handlers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * --emails: resend missed customer order-confirmation emails.
 */
async function runEmails(orders, { dryRun, verbose, env, supabase }) {
  log(`\n── EMAILS (customer order confirmations) ── ${orders.length} candidate(s)\n`);
  for (const order of orders) {
    const tag = `[${order.id.slice(0, 8)}]`;
    if (order.confirmation_email_sent_at) {
      log(`${tag} skip — confirmation_email_sent_at already set (${order.confirmation_email_sent_at})`);
      continue;
    }
    if (!order.email) {
      warn(`${tag} skip — no customer email on record`);
      continue;
    }

    const locale = resolveLocale(order.locale ?? 'pl');
    const t = I18N_ORDER_CONFIRMATION[locale];
    const mainContent = buildOrderConfirmationMainContent(order, locale);

    if (dryRun) {
      dryLog(
        `${tag} WOULD send order-confirmation to ${redactEmail(order.email, verbose)} (locale=${locale}, subject="${t.subject}")`,
      );
      continue;
    }

    try {
      await resendPost(
        {
          from: EMAIL_FROM,
          to: [order.email],
          reply_to: EMAIL_CONTACT,
          subject: t.subject,
          template: {
            id: TEMPLATE_ALIASES.shippingConfirmation,
            variables: { MAIN_CONTENT: mainContent },
          },
        },
        env.RESEND_API_KEY,
      );

      // Stamp the DB
      const { error: dbErr } = await supabase
        .from('orders')
        .update({ confirmation_email_sent_at: new Date().toISOString() })
        .eq('id', order.id);
      if (dbErr) {
        err(
          `EMAIL SENT but DB stamp failed for order ${order.id} — the customer received the email, ` +
            `but a re-run WILL RESEND it. Manually set confirmation_email_sent_at before re-running. ` +
            `(DB error: ${dbErr.message})`,
        );
        continue;
      }

      ok(`${tag} sent order-confirmation to ${redactEmail(order.email, verbose)}`);
    } catch (e) {
      err(`${tag} FAILED: ${e.message}`);
    }
  }
}

/**
 * --studio: resend missed studio new-order notification emails.
 * NOT idempotent — gated by explicit order IDs or --force-studio.
 */
async function runStudio(orders, { dryRun, forceStudio, explicitIds, env, supabase }) {
  log(`\n── STUDIO (new-order notifications) ── ${orders.length} candidate(s)\n`);

  if (!explicitIds && !forceStudio) {
    warn(
      'Studio emails are NOT idempotent (no studio_notified_at column). ' +
        'Pass explicit order IDs or --force-studio to proceed. Skipping all studio sends.',
    );
    return;
  }

  for (const order of orders) {
    const tag = `[${order.id.slice(0, 8)}]`;

    // Read items even in dry-run to show them in the preview (read-only).
    let items = [];
    const { data: itemRows, error: itemErr } = await supabase
      .from('order_items')
      .select('product_id, unit_price')
      .eq('order_id', order.id);
    if (itemErr) {
      err(`${tag} could not fetch order items: ${itemErr.message}`);
      continue;
    }
    items = itemRows ?? [];

    const fullOrder = { ...order, items };
    const mainContent = buildNewOrderToStudioMainContent(fullOrder);
    const subject = `[Zamówienie] Nowe opłacone zamówienie ${order.id}`;
    const html = resendTemplateHtml().replace('{{{MAIN_CONTENT}}}', mainContent);

    if (dryRun) {
      dryLog(
        `${tag} WOULD send studio new-order email to ${env.STUDIO_NOTIFY_EMAIL} ` +
          `(${items.length} item(s), total=${formatGrosze(order.total, order.currency)})`,
      );
      continue;
    }

    try {
      await resendPost(
        {
          from: EMAIL_FROM,
          to: [env.STUDIO_NOTIFY_EMAIL],
          reply_to: EMAIL_CONTACT,
          subject,
          html,
        },
        env.RESEND_API_KEY,
      );
      ok(`${tag} sent studio new-order email to ${env.STUDIO_NOTIFY_EMAIL} (${items.length} item(s))`);
    } catch (e) {
      err(`${tag} FAILED: ${e.message}`);
    }
  }
}

/**
 * --buy: buy the prepared offer for each stuck shipment.
 */
async function runBuy(orders, { dryRun, env }) {
  log(`\n── BUY (InPost shipment offers) ── ${orders.length} candidate(s)\n`);
  const inpost = makeInPost(env);

  for (const order of orders) {
    const tag = `[${order.id.slice(0, 8)}]`;
    const sid = order.inpost_shipment_id;

    if (!sid) {
      warn(`${tag} skip — no inpost_shipment_id`);
      continue;
    }

    try {
      const { offerId, alreadyConfirmed } = await pollForBuyableOffer(inpost, sid);

      if (alreadyConfirmed) {
        log(`${tag} shipment ${sid} already confirmed — skip buy`);
        continue;
      }

      if (offerId === null) {
        err(
          `${tag} shipment ${sid} — offers expired/empty after polling. ` +
            'ACTION REQUIRED: cancel & recreate this shipment in Manager Paczek, then re-run.',
        );
        continue;
      }

      if (dryRun) {
        dryLog(`${tag} WOULD buy offer ${offerId} for shipment ${sid} (offer fetched live from InPost)`);
        continue;
      }

      await inpost.buyShipment(sid, offerId);
      ok(`${tag} bought offer ${offerId} for shipment ${sid}`);
    } catch (e) {
      err(`${tag} FAILED: ${e.message}`);
    }
  }
}

/**
 * --labels: fetch the A6 PDF label and email it to the studio.
 */
async function runLabels(orders, { dryRun, env, supabase }) {
  log(`\n── LABELS (InPost A6 label emails to studio) ── ${orders.length} candidate(s)\n`);
  const inpost = makeInPost(env);

  for (const order of orders) {
    const tag = `[${order.id.slice(0, 8)}]`;
    const sid = order.inpost_shipment_id;

    if (order.inpost_label_emailed_at) {
      log(`${tag} skip — inpost_label_emailed_at already set (${order.inpost_label_emailed_at})`);
      continue;
    }

    if (!sid) {
      warn(`${tag} skip — no inpost_shipment_id`);
      continue;
    }

    let shipment;
    try {
      shipment = await pollUntilConfirmed(inpost, sid);
    } catch (e) {
      err(`${tag} could not check shipment ${sid}: ${e.message}`);
      continue;
    }

    if (!shipment) {
      warn(
        `${tag} shipment ${sid} is not confirmed yet / no tracking number. ` +
          'Run --buy first (or wait for InPost to confirm), then re-run --labels.',
      );
      continue;
    }

    const trackingNumber = shipment.tracking_number;

    // Build label email content
    const orderForLabel = {
      id: order.id,
      delivery_method: order.delivery_method,
      inpost_tracking_number: trackingNumber,
      inpost_target_point: order.inpost_target_point ?? null,
      receiver_first_name: order.receiver_first_name ?? null,
      receiver_last_name: order.receiver_last_name ?? null,
    };
    const mainContent = buildLabelToStudioMainContent(orderForLabel);
    const subject = `[Etykieta] Etykieta InPost — zamówienie ${order.id}`;

    if (dryRun) {
      dryLog(
        `${tag} WOULD fetch label PDF for shipment ${sid} ` +
          `(tracking: ${trackingNumber}, status: ${shipment.status} — fetched live from InPost) ` +
          `and email to ${env.STUDIO_NOTIFY_EMAIL}`,
      );
      continue;
    }

    let labelPdfBuffer;
    try {
      const arrayBuf = await inpost.getLabelPdf(sid);
      labelPdfBuffer = Buffer.from(arrayBuf).toString('base64');
    } catch (e) {
      err(`${tag} could not fetch label PDF for shipment ${sid}: ${e.message}`);
      continue;
    }

    try {
      await resendPost(
        {
          from: EMAIL_FROM,
          to: [env.STUDIO_NOTIFY_EMAIL],
          reply_to: EMAIL_CONTACT,
          subject,
          template: {
            id: TEMPLATE_ALIASES.labelStudio,
            variables: { MAIN_CONTENT: mainContent },
          },
          attachments: [
            {
              filename: `etykieta-${order.id}.pdf`,
              content: labelPdfBuffer,
            },
          ],
        },
        env.RESEND_API_KEY,
      );
    } catch (e) {
      err(`${tag} Resend send FAILED: ${e.message}`);
      continue;
    }

    // Stamp the DB
    const { error: dbErr } = await supabase
      .from('orders')
      .update({
        inpost_label_emailed_at: new Date().toISOString(),
        inpost_tracking_number: trackingNumber,
        delivery_status: LABEL_READY_STATUS,
      })
      .eq('id', order.id);
    if (dbErr) {
      err(
        `LABEL EMAILED but DB stamp failed for order ${order.id} — the label was emailed to the studio, ` +
          `but a re-run WILL RE-EMAIL it. Manually set inpost_label_emailed_at before re-running. ` +
          `(DB error: ${dbErr.message})`,
      );
      continue;
    }

    ok(
      `${tag} label email sent to ${env.STUDIO_NOTIFY_EMAIL}, ` +
        `tracking=${trackingNumber}, delivery_status=confirmed`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-discovery
// ─────────────────────────────────────────────────────────────────────────────

async function discoverEmails(supabase) {
  const { data, error } = await supabase
    .from('orders')
    .select('id, email, receiver_first_name, locale, confirmation_email_sent_at')
    .eq('status', 'paid')
    .is('confirmation_email_sent_at', null);
  if (error) throw new Error(`discover --emails: ${error.message}`);
  return data ?? [];
}

async function discoverStudio(supabase) {
  const { data, error } = await supabase
    .from('orders')
    .select(
      'id, email, receiver_first_name, receiver_last_name, total, currency, delivery_method, inpost_target_point, locale',
    )
    .eq('status', 'paid')
    .neq('delivery_method', 'odbior')
    .gte('paid_at', STUDIO_EMAIL_SINCE);
  if (error) throw new Error(`discover --studio: ${error.message}`);
  return data ?? [];
}

async function discoverBuy(supabase) {
  const { data, error } = await supabase
    .from('orders')
    .select('id, inpost_shipment_id, delivery_status')
    .eq('status', 'paid')
    .not('inpost_shipment_id', 'is', null)
    .in('delivery_status', ['created', 'offers_prepared', 'offer_selected']);
  if (error) throw new Error(`discover --buy: ${error.message}`);
  return data ?? [];
}

async function discoverLabels(supabase) {
  const { data, error } = await supabase
    .from('orders')
    .select(
      'id, inpost_shipment_id, inpost_label_emailed_at, delivery_method, inpost_target_point, receiver_first_name, receiver_last_name',
    )
    .eq('status', 'paid')
    .not('inpost_shipment_id', 'is', null)
    .is('inpost_label_emailed_at', null)
    .neq('delivery_method', 'odbior');
  if (error) throw new Error(`discover --labels: ${error.message}`);
  return data ?? [];
}

/** Load full order data for explicitly given IDs, merged with what each action needs. */
async function loadOrdersByIds(supabase, orderIds) {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .in('id', orderIds);
  if (error) throw new Error(`load orders by id: ${error.message}`);
  return data ?? [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Env validation
// ─────────────────────────────────────────────────────────────────────────────

function requireEnvKeys(env, keys) {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length > 0) {
    console.error(
      `ERROR: Missing required env var(s): ${missing.join(', ')}\n` +
        'Load via --env-file <path-to-.dev.vars> or set in the environment.',
    );
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Help text
// ─────────────────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
reconcile-orders.mjs — backfill missed emails + stuck InPost shipments.

Usage:
  node scripts/reconcile-orders.mjs [options] [order-id ...]

Options:
  --dry-run        Print what WOULD happen; no writes/sends. Still performs
                   read-only Supabase SELECTs and InPost GETs to show real state
                   (--buy/--labels dry-run still needs INPOST_API_TOKEN).
  --emails         Resend missed customer order-confirmation emails.
  --studio         Resend missed studio new-order notification emails.
  --buy            Buy the InPost shipment offer for stuck shipments.
  --labels         Fetch the A6 label PDF and email it to the studio.
  --force-studio   Skip the idempotency gate for --studio (no studio_notified_at column).
  --verbose        Show unredacted email addresses.
  --allow-nonprod  Allow writes against a non-production Supabase/InPost target.
  --env-file       Path to env file (default: .dev.vars in cwd).
  order-id ...     Scope actions to specific order UUIDs; otherwise auto-discover.

Note: .dev.vars lives in the MAIN repo root (gitignored). Run from the main
checkout or pass --env-file with the full path.
`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.previewOnly) {
    printHelp();
    log('No action flag given — running in preview/dry-run mode.\n');
  }

  // ── Load env ──────────────────────────────────────────────────────────────
  const envFilePath = args.envFile
    ? path.resolve(process.cwd(), args.envFile)
    : path.resolve(process.cwd(), '.dev.vars');

  let fileEnv = {};
  try {
    fileEnv = loadEnvFile(envFilePath);
  } catch (e) {
    if (args.envFile) {
      // Explicit path that doesn't exist → hard error
      console.error(`ERROR: ${e.message}`);
      process.exit(1);
    } else {
      // Default .dev.vars missing → warn but allow env to come from process.env
      warn(`Env file not found at ${envFilePath} — falling back to process.env`);
    }
  }

  // Merge: file env takes precedence over process.env
  const env = { ...process.env, ...fileEnv };

  // ── Determine which env keys are needed ───────────────────────────────────
  const needsResend = args.emails || args.studio || args.labels;
  const needsInpost = args.buy || args.labels;

  const requiredKeys = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
  if (needsResend) requiredKeys.push('RESEND_API_KEY', 'STUDIO_NOTIFY_EMAIL');
  if (needsInpost) requiredKeys.push('INPOST_API_URL', 'INPOST_API_TOKEN');

  requireEnvKeys(env, requiredKeys);

  // ── Prod-safety guard ─────────────────────────────────────────────────────
  let supabaseRef = '(unknown)';
  try {
    const host = new URL(env.SUPABASE_URL).hostname;
    supabaseRef = host.split('.')[0];
  } catch {
    // leave as (unknown)
  }

  let inpostHost = '(n/a)';
  if (env.INPOST_API_URL) {
    try {
      inpostHost = new URL(env.INPOST_API_URL).hostname;
    } catch {
      inpostHost = env.INPOST_API_URL;
    }
  }

  const isProdSupabase = supabaseRef === EXPECTED_SUPABASE_REF;
  const isProdInpost =
    !needsInpost || inpostHost === EXPECTED_INPOST_HOST;
  const isExpectedProd = isProdSupabase && isProdInpost;

  log(`
┌─ reconcile-orders ────────────────────────────────────────────────────────┐
│ Supabase project  : ${supabaseRef}
│ InPost host       : ${inpostHost}
│ Actions           : ${[args.emails && '--emails', args.studio && '--studio', args.buy && '--buy', args.labels && '--labels'].filter(Boolean).join(' ') || '(none)'}
│ Dry run           : ${args.dryRun ? 'YES ✓' : 'NO — WRITES ENABLED'}
│ Target            : ${isExpectedProd ? 'PRODUCTION ✓' : 'NON-PRODUCTION ⚠'}
└───────────────────────────────────────────────────────────────────────────┘`);

  if (!isExpectedProd && !args.dryRun && !args.allowNonprod) {
    console.error(
      '\nERROR: Target does not match expected production environment.\n' +
        `  Expected Supabase ref : ${EXPECTED_SUPABASE_REF}\n` +
        `  Got                  : ${supabaseRef}\n` +
        `  Expected InPost host : ${EXPECTED_INPOST_HOST}\n` +
        `  Got                  : ${inpostHost}\n\n` +
        'Pass --allow-nonprod to allow writes against a non-production target, ' +
        'or --dry-run to inspect without writing.',
    );
    process.exit(1);
  }

  if (!isExpectedProd && args.dryRun) {
    warn('Non-production target detected — dry-run is allowed, but no writes will be made.');
  }

  // ── Supabase client ───────────────────────────────────────────────────────
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const ctx = { dryRun: args.dryRun, verbose: args.verbose, env, supabase };

  // ── Discover or load orders ───────────────────────────────────────────────
  const explicitIds = args.orderIds.length > 0;
  let emailOrders, studioOrders, buyOrders, labelOrders;

  if (explicitIds) {
    // Load all columns; each action will use what it needs
    const allOrders = await loadOrdersByIds(supabase, args.orderIds);
    if (allOrders.length === 0) {
      warn('No orders found for the given IDs');
    }
    emailOrders = args.emails ? allOrders : [];
    studioOrders = args.studio ? allOrders : [];
    buyOrders = args.buy ? allOrders : [];
    labelOrders = args.labels ? allOrders : [];
  } else {
    emailOrders = args.emails ? await discoverEmails(supabase) : [];
    studioOrders = args.studio ? await discoverStudio(supabase) : [];
    buyOrders = args.buy ? await discoverBuy(supabase) : [];
    labelOrders = args.labels ? await discoverLabels(supabase) : [];
  }

  if (args.previewOnly) {
    log('\n── Auto-discovered candidates ──────────────────────────────────────────────');
    log(`  --emails  : ${emailOrders.length} order(s) missing customer confirmation email`);
    log(`  --studio  : ${studioOrders.length} order(s) candidates for studio re-notify (since ${STUDIO_EMAIL_SINCE})`);
    log(`  --buy     : ${buyOrders.length} shipment(s) needing offer purchase`);
    log(`  --labels  : ${labelOrders.length} shipment(s) needing label email`);
    log('\nRerun with one or more action flags to proceed.');
    log('Example: node scripts/reconcile-orders.mjs --dry-run --emails --buy --labels\n');
    process.exit(0);
  }

  // ── Run actions ───────────────────────────────────────────────────────────
  if (args.emails) {
    await runEmails(emailOrders, ctx);
  }

  if (args.studio) {
    await runStudio(studioOrders, {
      ...ctx,
      forceStudio: args.forceStudio,
      explicitIds,
    });
  }

  if (args.buy) {
    await runBuy(buyOrders, ctx);
  }

  if (args.labels) {
    await runLabels(labelOrders, ctx);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  log('\n────────────────────────────────────────────────────────────────────────────');
  if (args.dryRun) {
    log('DRY RUN — no changes made. Rerun without --dry-run to apply.');
  } else {
    log(hasErrors ? 'DONE with errors (see ✗ lines above).' : 'DONE — all actions completed.');
  }
  log('────────────────────────────────────────────────────────────────────────────\n');

  if (hasErrors) process.exit(1);
}

main().catch((e) => {
  console.error('FATAL:', e.message ?? e);
  process.exit(1);
});
