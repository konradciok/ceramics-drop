/**
 * Shared helpers for Notion ↔ messages/pl.json sync.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '../..');
export const PL_PATH = path.join(ROOT, 'messages', 'pl.json');
export const EN_PATH = path.join(ROOT, 'messages', 'en.json');
export const STATE_DIR = path.join(ROOT, '.notion-i18n');
export const STATE_PATH = path.join(STATE_DIR, 'state.json');

const NOTION_VERSION = '2022-06-28';
const PULL_STATUSES = new Set(['Ready', 'Done']);

/** Site area for Notion views (6 high-level groups). */
export const AREA_OPTIONS = [
  'Shop & checkout',
  'Home',
  'Collections',
  'Studio & contact',
  'Legal & shipping',
  'Global & SEO',
];

/** JSON key prefix → Notion Page label. */
const PAGE_BY_PREFIX = {
  announce: 'Banner',
  title: 'Page titles (SEO)',
  nav: 'Navigation',
  aria: 'Accessibility',
  footer: 'Footer',
  product: 'Product labels',
  gallery: 'Gallery',
  selbar: 'Selection bar',
  lightbox: 'Lightbox',
  cart: 'Cart',
  ship: 'Checkout — summary',
  delivery: 'Checkout — delivery',
  return: 'Checkout — return',
  home: 'Home',
  collection: 'Collection pages',
  studio: 'Studio',
  contact: 'Contact',
  shipping: 'Shipping & returns',
  terms: 'Terms',
  privacy: 'Privacy',
  notes: 'Product notes',
  returns: 'Returns form',
  error: 'Error page',
  notFound: '404 page',
  meta: 'Meta descriptions',
  consent: 'Cookie consent',
};

const AREA_BY_PREFIX = {
  announce: 'Global & SEO',
  title: 'Global & SEO',
  nav: 'Global & SEO',
  aria: 'Global & SEO',
  footer: 'Global & SEO',
  meta: 'Global & SEO',
  consent: 'Global & SEO',
  error: 'Global & SEO',
  notFound: 'Global & SEO',
  cart: 'Shop & checkout',
  ship: 'Shop & checkout',
  delivery: 'Shop & checkout',
  return: 'Shop & checkout',
  selbar: 'Shop & checkout',
  lightbox: 'Shop & checkout',
  gallery: 'Shop & checkout',
  product: 'Shop & checkout',
  home: 'Home',
  collection: 'Collections',
  notes: 'Collections',
  studio: 'Studio & contact',
  contact: 'Studio & contact',
  shipping: 'Legal & shipping',
  terms: 'Legal & shipping',
  privacy: 'Legal & shipping',
  returns: 'Legal & shipping',
};

const SECTION_LABELS = {
  '(main)': 'Main',
  marquee: 'Marquee',
  card: 'Collection cards',
  collections: 'Collection SEO',
  kubki: 'Mugs',
  wazony: 'Vases',
  'wazony-duze': 'Large vases',
  talerzyki: 'Dishes',
  'talerze-duze': 'Large plates',
  'duze-michy': 'Large bowls',
  'miski-falowane': 'Wavy bowls',
};

const COLLECTION_SLUGS = new Set([
  'kubki',
  'wazony',
  'wazony-duze',
  'talerzyki',
  'talerze-duze',
  'duze-michy',
  'miski-falowane',
]);

/** Map a flat messages key to Area / Page / Section for Notion grouping. */
export function classifyKey(key) {
  const parts = key.split('.');
  const prefix = parts[0];
  const area = AREA_BY_PREFIX[prefix] ?? 'Global & SEO';
  const page = PAGE_BY_PREFIX[prefix] ?? prefix;

  let sectionKey = '(main)';
  if (parts.length >= 3) {
    sectionKey = /^\d+$/.test(parts[1]) ? parts[0] : parts[1];
  } else if (parts.length === 2 && /^\d+$/.test(parts[1])) {
    sectionKey = '(main)';
  }

  let section = SECTION_LABELS[sectionKey] ?? sectionKey;
  if (COLLECTION_SLUGS.has(sectionKey)) {
    section = SECTION_LABELS[sectionKey] ?? sectionKey;
  } else if (sectionKey === '(main)') {
    section = 'Main';
  } else {
    section = sectionKey.charAt(0).toUpperCase() + sectionKey.slice(1);
  }

  return { area, page, section };
}

export const ALL_PAGE_LABELS = [...new Set(Object.values(PAGE_BY_PREFIX))].sort();

/** Load KEY=VALUE lines from repo-root .env (does not override existing env). */
export function loadDotEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

export function requireEnv(name) {
  const val = process.env[name]?.trim();
  if (!val) {
    console.error(`Missing ${name}. Set it in .env or the shell environment.`);
    process.exit(1);
  }
  return val;
}

/** Depth-first flatten: nested objects and string arrays → dotted keys. */
export function flattenMessages(obj, prefix = '') {
  const rows = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const item = v[i];
        if (typeof item === 'string') {
          rows.push({ key: `${key}.${i}`, value: item });
        } else if (item && typeof item === 'object') {
          rows.push(...flattenMessages(item, `${key}.${i}`));
        } else {
          throw new Error(`Unsupported array item at ${key}.${i}: ${typeof item}`);
        }
      }
    } else if (v !== null && typeof v === 'object') {
      rows.push(...flattenMessages(v, key));
    } else if (typeof v === 'string') {
      rows.push({ key, value: v });
    } else {
      throw new Error(`Unsupported leaf at ${key}: ${typeof v}`);
    }
  }
  return rows;
}

/** Apply flat key → value map onto a deep-cloned template (preserves structure & key order). */
export function applyFlatToTemplate(template, flatMap) {
  const clone = structuredClone(template);
  for (const [dotKey, value] of Object.entries(flatMap)) {
    setByPath(clone, dotKey, value);
  }
  return clone;
}

function setByPath(root, dotKey, value) {
  const parts = dotKey.split('.');
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    const next = parts[i + 1];
    const isIndex = /^\d+$/.test(next);
    if (isIndex) {
      if (!Array.isArray(cur[p])) {
        throw new Error(`Expected array at ${parts.slice(0, i + 1).join('.')} for ${dotKey}`);
      }
      cur = cur[p];
      i++;
      const idx = Number(next);
      if (i === parts.length - 1) {
        cur[idx] = value;
        return;
      }
      if (cur[idx] === undefined || cur[idx] === null) {
        cur[idx] = /^\d+$/.test(parts[i + 1]) ? [] : {};
      }
      cur = cur[idx];
    } else {
      if (cur[p] === undefined || cur[p] === null) {
        cur[p] = /^\d+$/.test(next) ? [] : {};
      }
      cur = cur[p];
    }
  }
  const last = parts[parts.length - 1];
  if (/^\d+$/.test(last) && Array.isArray(cur)) {
    cur[Number(last)] = value;
  } else {
    cur[last] = value;
  }
}

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/** Write JSON with 2-space indent and trailing newline (matches messages/*.json). */
export function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export function loadState() {
  if (!fs.existsSync(STATE_PATH)) {
    return { pages: {}, lastPullAt: null, keyOrder: [] };
  }
  return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
}

export function saveState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function richText(content) {
  const text = content ?? '';
  if (text.length <= 2000) {
    return [{ type: 'text', text: { content: text } }];
  }
  const chunks = [];
  for (let i = 0; i < text.length; i += 2000) {
    chunks.push({ type: 'text', text: { content: text.slice(i, i + 2000) } });
  }
  return chunks;
}

export function pageProperties({ key, polish, english, status, notes, area, page, section }) {
  const group = classifyKey(key);
  const props = {
    Key: { title: richText(key) },
    Polish: { rich_text: richText(polish) },
    English: { rich_text: richText(english ?? '') },
    Area: { select: { name: area ?? group.area } },
    Page: { select: { name: page ?? group.page } },
    Section: { rich_text: richText(section ?? group.section) },
  };
  if (status) props.Status = { select: { name: status } };
  if (notes !== undefined) props.Notes = { rich_text: richText(notes) };
  return props;
}

export function readPageFields(page) {
  const p = page.properties;
  return {
    pageId: page.id,
    key: p.Key?.title?.map((t) => t.plain_text).join('') ?? '',
    polish: p.Polish?.rich_text?.map((t) => t.plain_text).join('') ?? '',
    english: p.English?.rich_text?.map((t) => t.plain_text).join('') ?? '',
    status: p.Status?.select?.name ?? null,
    notes: p.Notes?.rich_text?.map((t) => t.plain_text).join('') ?? '',
    area: p.Area?.select?.name ?? null,
    page: p.Page?.select?.name ?? null,
    section: p.Section?.rich_text?.map((t) => t.plain_text).join('') ?? '',
    lastEdited: page.last_edited_time,
  };
}

export class NotionClient {
  constructor(token) {
    this.token = token;
  }

  async request(method, apiPath, body, { retries = 4 } = {}) {
    const retryable = new Set([429, 502, 503, 504]);
    for (let attempt = 0; attempt <= retries; attempt++) {
      const res = await fetch(`https://api.notion.com/v1${apiPath}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Notion-Version': NOTION_VERSION,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) return data;

      const msg = data.message ?? JSON.stringify(data);
      if (retryable.has(res.status) && attempt < retries) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }

      const hint =
        res.status === 404 && apiPath.includes('/databases/')
          ? ' Share the database with your integration: Notion → ⋯ → Connections.'
          : '';
      throw new Error(`Notion ${method} ${apiPath} → ${res.status}: ${msg}${hint}`);
    }
    throw new Error(`Notion ${method} ${apiPath} failed after retries`);
  }

  async queryDatabase(databaseId, filter, startCursor) {
    const body = { page_size: 100 };
    if (filter) body.filter = filter;
    if (startCursor) body.start_cursor = startCursor;
    return this.request('POST', `/databases/${databaseId}/query`, body);
  }

  async queryAll(databaseId, filter) {
    const pages = [];
    let cursor;
    do {
      const res = await this.queryDatabase(databaseId, filter, cursor);
      pages.push(...res.results);
      cursor = res.has_more ? res.next_cursor : undefined;
      if (cursor) await sleep(350);
    } while (cursor);
    return pages;
  }

  async createPage(databaseId, properties) {
    return this.request('POST', '/pages', {
      parent: { database_id: databaseId },
      properties,
    });
  }

  async updatePage(pageId, properties) {
    return this.request('PATCH', `/pages/${pageId}`, { properties });
  }

  async createDatabase(parentPageId, title) {
    return this.request('POST', '/databases', {
      parent: { type: 'page_id', page_id: parentPageId },
      title: richText(title).map((t) => ({ type: 'text', text: t.text })),
      properties: {
        Key: { title: {} },
        Polish: { rich_text: {} },
        English: { rich_text: {} },
        Status: {
          select: {
            options: [
              { name: 'Draft', color: 'gray' },
              { name: 'In review', color: 'yellow' },
              { name: 'Ready', color: 'blue' },
              { name: 'Done', color: 'green' },
            ],
          },
        },
        Notes: { rich_text: {} },
        Area: {
          select: {
            options: AREA_OPTIONS.map((name) => ({ name, color: 'default' })),
          },
        },
        Page: { select: {} },
        Section: { rich_text: {} },
      },
    });
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export { PULL_STATUSES };

/** Round-trip self-check (flatten → apply → flatten). */
export function assertRoundTrip(obj) {
  const flat = flattenMessages(obj);
  const map = Object.fromEntries(flat.map((r) => [r.key, r.value]));
  const restored = applyFlatToTemplate(obj, map);
  const flat2 = flattenMessages(restored);
  if (flat.length !== flat2.length) {
    throw new Error(`Round-trip key count mismatch: ${flat.length} vs ${flat2.length}`);
  }
  for (let i = 0; i < flat.length; i++) {
    if (flat[i].key !== flat2[i].key || flat[i].value !== flat2[i].value) {
      throw new Error(`Round-trip mismatch at ${flat[i].key}`);
    }
  }
}
