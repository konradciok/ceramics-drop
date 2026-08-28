import { getCloudflareContext } from '@opennextjs/cloudflare';
import { getSupabaseAdmin } from '@/lib/supabase';
import { validateCmsPayload } from './schemas';
import type { CmsDocumentKind, CmsLocale, CmsPayload, CmsVersionRow } from './types';

type PreviewPayload = {
  kind: CmsDocumentKind;
  slug: string;
  locale: CmsLocale;
  version: number;
  exp: number;
};

// Dedicated HMAC secret for preview tokens — never reused from Stripe/Supabase.
// Fail closed: if unset, minting throws (admin sees the error) and verification
// throws too, but getProductNote wraps it in .catch → storefront falls back to
// published/messages, so a missing secret never breaks a PDP.
function getPreviewSecret(): string {
  const env = getCloudflareContext().env as CloudflareEnv & Record<string, string | undefined>;
  const secret = env.CMS_PREVIEW_SECRET;
  if (!secret) throw new Error('CMS_PREVIEW_SECRET unset');
  return secret;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(input: string): Uint8Array {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(input.length / 4) * 4, '=');
  const binary = atob(b64);
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function key() {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(getPreviewSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

async function sign(payload: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await key(), new TextEncoder().encode(payload));
  return base64Url(new Uint8Array(sig));
}

export async function mintPreviewToken(payload: Omit<PreviewPayload, 'exp'>, ttlSeconds = 15 * 60): Promise<string> {
  const body = base64Url(new TextEncoder().encode(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })));
  return `${body}.${await sign(body)}`;
}

export async function verifyPreviewToken(token: string | null | undefined): Promise<PreviewPayload | null> {
  if (!token) return null;
  const [body, signature] = token.split('.');
  if (!body || !signature) return null;
  // Everything below can throw on a malformed token (invalid base64 in
  // fromBase64Url → atob, a missing/misshapen secret in key(), a bad
  // signature length in crypto.subtle.verify, or invalid JSON) — a crafted
  // ?preview= value must fail closed to null, never 500 the page.
  try {
    const ok = await crypto.subtle.verify('HMAC', await key(), arrayBuffer(fromBase64Url(signature)), new TextEncoder().encode(body));
    if (!ok) return null;
    const parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as PreviewPayload;
    if (!parsed.kind || !parsed.slug || !parsed.locale || !parsed.version || !parsed.exp) return null;
    if (parsed.exp < Math.floor(Date.now() / 1000)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function getPublishedContent<TPayload = CmsPayload>(
  kind: CmsDocumentKind,
  slug: string,
  locale: CmsLocale,
): Promise<TPayload | null> {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('cms_documents')
      .select('id, cms_document_versions!inner(payload)')
      .eq('kind', kind)
      .eq('slug', slug)
      .eq('status', 'published')
      .eq('cms_document_versions.locale', locale)
      .eq('cms_document_versions.status', 'published')
      .maybeSingle();
    if (error || !data) return null;
    const versions = (data as { cms_document_versions?: Array<{ payload: unknown }> }).cms_document_versions ?? [];
    const payload = versions[0]?.payload;
    if (!payload) return null;
    return validateCmsPayload(kind, slug, payload) as TPayload;
  } catch (err) {
    console.error('CMS published read failed; falling back to messages', { kind, slug, locale, err });
    return null;
  }
}

export async function getPreviewContent<TPayload = CmsPayload>(
  token: string | null | undefined,
  expected: { kind: CmsDocumentKind; slug: string; locale: CmsLocale },
): Promise<TPayload | null> {
  const preview = await verifyPreviewToken(token);
  if (!preview) return null;
  if (preview.kind !== expected.kind || preview.slug !== expected.slug || preview.locale !== expected.locale) return null;
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('cms_documents')
      .select('id, cms_document_versions!inner(id, document_id, locale, version, status, payload, created_by, created_at)')
      .eq('kind', preview.kind)
      .eq('slug', preview.slug)
      .eq('cms_document_versions.locale', preview.locale)
      .eq('cms_document_versions.version', preview.version)
      .maybeSingle();
    if (error || !data) return null;
    const versions = (data as { cms_document_versions?: CmsVersionRow[] }).cms_document_versions ?? [];
    const payload = versions[0]?.payload;
    if (!payload) return null;
    return validateCmsPayload(preview.kind, preview.slug, payload) as TPayload;
  } catch (err) {
    console.error('CMS preview read failed', { expected, err });
    return null;
  }
}
