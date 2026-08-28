# Plan: PSTR-style full-bleed homepage hero, CMS-managed media

Branch `feat/home-hero-pstr` off `origin/main` (afe8305). Executed via subagent-driven development, one task per phase. Phases 1–4 ship dark; Phase 5 is the visible swap.

## Context

The homepage hero (rebuilt 2026-08-24 in PR #262 as a "diptych": copy column + ceramic photo + framed-print mockup) is being replaced with a PSTR.studio-style full-bleed photographic hero (reference: docs/research/PSTR/hero-desktop.png + hero-mobile.png):

- Desktop (≥861px): edge-to-edge landscape image or muted looping video, ~88svh; overlay bottom-left — italic display line + second display line + small uppercase tagline + one CTA button, over a bottom gradient scrim.
- Mobile (<861px): a separately uploaded tall/square media file (independent crop control), ~82svh; overlay = the two headline lines + CTA (tagline hidden).
- The hero becomes CMS-managed: admin replaces the image/video (desktop and mobile uploaded separately) and edits copy at /admin/content, with the existing draft → preview → publish → revert lifecycle.

User decisions (confirmed):
1. Media + copy both in CMS as doc page:home, per-locale, falling back to messages/*.json — mirroring page:print-pdp.
2. CTA stays visible on mobile (preserves e2e/hero-header.spec.ts above-the-fold assertion).
3. Single CTA → /sklep, label CMS-editable.
4. Only the hero is replaced — hero-beat band, marquee, collections, prints rail stay untouched.

Key repo findings:
- CMS: homePageSchema for (kind='page', slug='home') already exists at src/lib/cms/schemas.ts:49-54 and is routed by validateCmsPayload (L126) but is completely unwired — free to reshape. All lifecycle machinery is reusable (publish_cms_version() RPC, mintPreviewToken/verifyPreviewToken, PrintPdpEditor pattern, history/revert). No new DB migration needed (ensureDocument inserts on first draft).
- Upload/serving: nothing exists — no admin file upload anywhere, no public R2 route, no <video> in the repo. PRINT_ASSETS R2 bucket is bound in the Worker (read-only so far). sharp is Node-only → no server-side resizing possible.
- /api/admin/* routes inherit the Cloudflare Access gate via ADMIN_PATH_RE (src/lib/admin/access.ts:3) — the upload route goes there; the public media route must live outside it.
- contentItems() in src/lib/admin/content.ts:84 falls through to registryProductsByCategory(slug) for unknown slugs — would throw for home; needs an early return.
- previewPath() (src/app/api/admin/content/preview/route.ts:17-24) already resolves page:home → localizedPath(locale, '/') — no change needed.
- CSP is report-only with no media-src → falls to default-src 'self'; same-origin /api/media/... is clean for both img and video.
- --f-display is Jost — the "script" line is italic Jost (matches existing marquee idiom). A true script webfont is out of scope.

Core design decisions:
1. Storage & serving: R2 PRINT_ASSETS bucket under key prefix site-media/<sha256-hex>.<ext> (content-hash keys = perfect cache-busting; preview env shares the bucket — acceptable, keys are collision-proof and inert until referenced). No metadata table — the CMS payload jsonb carries the media reference; media lifecycle rides CMS versions (draft/publish/revert just swap keys). Orphaned R2 objects are cheap; a future cleanup script is noted as follow-up. Served by a new public route GET /api/media/[key] with cache-control: public, max-age=31536000, immutable, etag, and Range support (mandatory — iOS Safari refuses <video> from servers ignoring Range).
2. Upload: POST /api/admin/content/media — raw body (not multipart) with content-type header + ?width=&height= query (client reads dimensions; the Worker can't decode media). Server: type allowlist (image/webp|jpeg|png, video/mp4|webm), magic-byte sniff, caps 8 MB image / 50 MB video, crypto.subtle.digest('SHA-256') → key, PRINT_ASSETS.put() (idempotent), returns { key, contentType, width, height, url }.
3. Variants: single file per slot, no client-side canvas resizing. The separate mobile upload already bounds mobile bytes and <picture> downloads only one file. The editor shows size guidance (desktop WebP ~2400–2800px wide < 700 KB; mobile ~1080×1350 < 350 KB) + a soft over-size warning. Video slots require a poster image (doubles as LCP/fallback/reduced-motion image).
4. Payload media sharing across locales: media is edited once in the editor; when media changed, draft save fans out to all four locales (active locale gets edited copy + new media; others get their last-saved copy + new media) via the existing draft API — locales can't drift. Publish stays per-locale (existing model); banner reminds admin to publish all locales after a media change.
5. Rendering: server-rendered <picture> is always the base and the LCP element (image slot → image; video slot → its poster), zero-JS-correct. If any slot is a video, a tiny client island mounts one <video> on top after hydration, gated by matchMedia('(min-width:861px)') and skipped under prefers-reduced-motion: reduce — only the active breakpoint's video downloads.

## Global Constraints

- Build must stay `next build --webpack` — never Turbopack, never `--turbo`.
- TDD: write the failing test first for every pure helper; tests colocated `*.test.ts` run by vitest.
- No git push, no PR creation, no branch switching, no `git add -A` (add files by explicit path). Never commit the untracked `.next` symlink at the worktree root or anything under `.superpowers/`.
- Follow repo conventions: plain CSS with tokens (no CSS-in-JS), native `<img>`/`<picture>` (no next/image), `Link` from `src/i18n/navigation.ts`, API errors as `NextResponse.json({ error }, { status })`.
- `messages/{pl,en,es,de}.json` must stay structurally in sync across all four locales.
- Only the hero section is replaced on the homepage — hero-beat band, marquee, collections, prints rail stay untouched.
- The e2e selector `.hero-actions .btn-primary` and CTA above-the-fold behavior on mobile must be preserved.

## Task 1 — Media helpers + public serving route (Phase 1)

Constraints: TDD (failing test first). No git push. Commit only your own new files by explicit path. Conventional commit message `feat(media): …`.

New files:
- `src/lib/site-media.ts` — `SITE_MEDIA_PREFIX = 'site-media/'`, `SITE_MEDIA_KEY_RE`, `IMAGE_KEY_RE` (`/^[a-f0-9]{64}\.(webp|jpe?g|png)$/`), `VIDEO_KEY_RE` (`/^[a-f0-9]{64}\.(mp4|webm)$/`), `EXT_CONTENT_TYPES` map (webp→image/webp, jpg/jpeg→image/jpeg, png→image/png, mp4→video/mp4, webm→video/webm), `siteMediaUrl(key)` → `/api/media/<key>`, `parseRangeHeader(header, size)` (single-range only; supports `bytes=A-B`, open-ended `bytes=A-`, and suffix `bytes=-N` forms; malformed/absent → `null` meaning "serve whole file"; syntactically valid but unsatisfiable → the string `'invalid'`), `siteMediaHeaders(obj, key, range?)` building the response header set.
- `src/lib/site-media.test.ts` — key regexes (valid 64-hex keys per extension; reject wrong length, uppercase hex, path traversal, unknown extensions), content-type map, range parsing (`bytes=0-`, `bytes=100-199`, `bytes=-500`, malformed → null, unsatisfiable (start ≥ size) → 'invalid', suffix larger than file clamps to whole file).
- `src/app/api/media/[key]/route.ts` — GET and HEAD handlers, `export const dynamic = 'force-dynamic'`; 404 on key regex fail; `getCloudflareContext().env.PRINT_ASSETS.get(SITE_MEDIA_PREFIX + key, { range })` (do a `head()` first when object size is needed for suffix-range resolution/validation); 206 + `content-range` for range responses, 416 for unsatisfiable ranges; headers: `content-type` from extension map (server-controlled, never client-supplied), `etag: obj.httpEtag`, `accept-ranges: bytes`, `cache-control: public, max-age=31536000, immutable`. 404 when the object does not exist. Template for the streaming shape: `src/app/api/print-assets/[id]/route.ts` (but this route is public — no HMAC, no token).

Verification: `npx vitest run src/lib/site-media.test.ts` green; `npm run lint` and `npm run typecheck` clean.

## Task 2 — Admin upload route (Phase 2)

Constraints: TDD. No git push. Commit only your own new files by explicit path. Conventional commit `feat(admin): …`. Depends on Task 1's `src/lib/site-media.ts` (prefix, regexes, `siteMediaUrl`).

New files:
- `src/lib/admin/site-media-upload.ts` — pure, testable: `validateUpload({contentType, contentLength, width, height, bytes})` enforcing: content-type allowlist (image/webp, image/jpeg, image/png, video/mp4, video/webm), magic-byte sniff matching the declared type (RIFF….WEBP for webp, \x89PNG for png, \xFF\xD8\xFF for jpeg, `ftyp` at offset 4 for mp4, EBML \x1A\x45\xDF\xA3 for webm), size caps 8 MB for images / 50 MB for videos, dimensions integers 1–10000. Returns a discriminated result (ok with normalized ext, or error code + suggested HTTP status: 415 bad/mismatched type, 413 oversize, 400 bad dims). Also `uploadKeyFor(bytes, ext)` → sha256-hex of bytes via WebCrypto (`crypto.subtle.digest`) + `.` + ext.
- `src/lib/admin/site-media-upload.test.ts` — bad content type, magic bytes mismatching declared type, oversize image and video, absurd/missing dims, sha256 key correctness against a known vector and idempotence (same bytes → same key).
- `src/app/api/admin/content/media/route.ts` — POST only (auto-gated by Cloudflare Access via ADMIN_PATH_RE — no auth code needed here): read `req.arrayBuffer()` + `width`/`height` from query → `validateUpload` → on failure `NextResponse.json({error}, {status})` per the validator's status → on success `getCloudflareContext().env.PRINT_ASSETS.put(SITE_MEDIA_PREFIX + key, buf, {httpMetadata:{contentType}})` (idempotent by content-hash key) → 200 `{ key, contentType, width, height, url: siteMediaUrl(key) }`.

Verification: `npx vitest run src/lib/admin/site-media-upload.test.ts` green; `npm run lint` and `npm run typecheck` clean.

## Task 3 — CMS schema, types, read helper, fallback messages (Phase 3)

Constraints: TDD. No git push. Commit by explicit path. Conventional commit `feat(cms): …`. Keep messages/*.json in sync across all four locales. Do NOT remove any existing home.* message keys in this task (removal happens in Task 5 so the stack stays green mid-way). Depends on Task 1's key regexes (`IMAGE_KEY_RE`, `VIDEO_KEY_RE` from `src/lib/site-media.ts`).

Modified:
- `src/lib/cms/schemas.ts` — replace `homePageSchema` wholesale (current heroEyebrow/heroTitle/heroLead shape is unwired — free to drop):
  ```ts
  const heroImage = z.object({ kind: z.literal('image'), key: IMAGE_KEY, width: dim, height: dim });
  const heroVideo = z.object({ kind: z.literal('video'), key: VIDEO_KEY, poster: heroImage.omit({ kind: true }) });
  const heroSlot = z.discriminatedUnion('kind', [heroImage, heroVideo]).nullable();
  export const homePageSchema = z.object({
    heroLine1: plainText, heroLine2: plainText, heroTagline: optionalPlainText,
    ctaLabel: plainText, heroAlt: optionalPlainText,
    media: z.object({ desktop: heroSlot, mobile: heroSlot }),
  });
  ```
  where IMAGE_KEY / VIDEO_KEY are zod string schemas validated with the regexes from `src/lib/site-media.ts`, and plainText/optionalPlainText/dim follow the file's existing validator idioms (plain text = no HTML/scripts, consistent with existing schema fields). `validateCmsPayload` already routes (kind='page', slug='home') — verify, don't duplicate.
- `src/lib/cms/types.ts` — `HOME_PAGE_SLUG = 'home'`, `HomePagePayload`, `HeroMediaSlot`; extend the `CmsPayload` union.
- `src/lib/cms/schemas.test.ts` — add cases: valid image slots, video+poster valid, video without poster rejected, malformed key rejected, `<script>` in copy rejected, null slots OK.
- `messages/{pl,en,es,de}.json` — add `home.heroLine1`, `home.heroLine2`, `home.heroTagline`, `home.heroCta`, `home.heroAlt` in all four locales (sensible localized copy for a ceramics studio; PL is the source language). Do not remove old keys yet.

New:
- `src/lib/cms/home.ts` — mirror `src/lib/cms/print-pdp.ts`: `fallbackHomePayload(locale)` built from LOCALE_MESSAGES (the new home.* keys) with `media: {desktop: null, mobile: null}`; `getHomeContent(locale, previewToken?)` = preview (valid token) > published > fallback; any CMS/DB error → fallback (a CMS outage must never break the homepage).
- `src/lib/cms/home.test.ts` — mirror `src/lib/cms/print-pdp.test.ts`: fallback per locale, preview/published precedence, invalid stored payload → fallback.

Verification: `npx vitest run src/lib/cms/schemas.test.ts src/lib/cms/home.test.ts` green; `npm run lint`, `npm run typecheck`, and full `npm run test` clean (existing suites must not regress).

## Task 4 — Admin registration + HomeHeroEditor (Phase 4)

Constraints: No git push. Commit by explicit path. Conventional commit `feat(admin): …`. Follow the existing PrintPdpEditor pattern closely; admin styles use the `adm-*` idiom in `src/styles/admin.css`. Depends on Task 2's upload route + Task 3's schema/types/`fallbackHomePayload`.

Modified:
- `src/lib/admin/content.ts` — `HOME_PAGE_DOCUMENT = { kind:'page', slug: HOME_PAGE_SLUG, label:'Strona główna — hero', publicPath:'/' }` appended to EDITABLE_DOCUMENTS; `contentItems('home')` → `[]` early return (required — the fall-through to registryProductsByCategory throws for unknown slugs); defaultPayload for home → `fallbackHomePayload(locale)`.
- `src/app/admin/content/[kind]/[slug]/page.tsx` — add an isHome branch rendering `<HomeHeroEditor state={state} />` (same treatment as the isPrintPdp branch at L18/37-41).
- `src/app/api/admin/content/publish/route.ts` — add `kind==='page' && slug==='home'` → `revalidatePath(localizedPath(locale,'/'))` (symmetric with the product_notes handling).

New:
- `src/app/admin/content/[kind]/[slug]/HomeHeroEditor.tsx` — client component, modeled on PrintPdpEditor.tsx (locale tabs, dirty tracking, postJson from editor-shared.ts, draft/preview/publish/revert flows). Additions:
  - copy fields per locale: heroLine1, heroLine2, heroTagline, ctaLabel, heroAlt;
  - a shared media panel (desktop + mobile slot cards): `<input type="file">`, thumbnail preview `<img>` / `<video muted>` sourced from `/api/media/<key>` — NOT blob: URLs (CSP); dims caption; remove button; for video slots a poster image input is required before the slot is savable;
  - upload via `fetch('/api/admin/content/media?width=&height=', {method:'POST', body:file, headers:{'content-type':file.type}})` with a busy state; client reads image dims via Image()/video dims via loadedmetadata to fill the query params;
  - fan-out draft save: when media changed, save drafts for all four locales in one action (active locale gets its edited copy + new media; other locales get their last-saved copy with media swapped in) via the existing draft API;
  - size-guidance hints (desktop WebP ~2400–2800px wide < 700 KB; mobile ~1080×1350 < 350 KB) + a soft over-size warning (never blocks);
  - after a media change, show a banner reminding the admin to publish all locales.
- Media-card styles in `src/styles/admin.css` (adm-* idiom).

Verification: `npm run lint`, `npm run typecheck`, full `npm run test` clean. (Manual preview:cf verification of the upload/draft/publish cycle happens at the end of the plan, not in this task.)

## Task 5 — Storefront swap (Phase 5, the visible commit)

Constraints: No git push. Commit by explicit path. Conventional commit `feat(home): …`. Keep messages/*.json structurally in sync. Preserve the `.hero-actions .btn-primary` selector and mobile above-the-fold CTA. Everything below the hero (hero-beat band, marquee, collections, prints rail) stays untouched. Depends on Tasks 1+3 (`siteMediaUrl`, `getHomeContent`).

New:
- `src/components/shop/HomeHero.tsx` (server component): `resolveSlot(slot, fallback)` → a CMS slot uses `siteMediaUrl(key)` (single URL, no srcSet); a null slot uses a committed static default image from `src/lib/editorial-images.ts` + the existing `srcSet()` from `src/lib/images.ts`. JSX skeleton:
  ```tsx
  <section className="hero">
    <picture className="hero-media">
      <source media="(min-width:861px)" srcSet={desktop.srcSet ?? desktop.imgSrc} />
      <img src={mobile.imgSrc} srcSet={mobile.srcSet} alt={content.heroAlt ?? ''}
           width={mobile.width} height={mobile.height} fetchPriority="high" />
    </picture>
    {(desktop.video || mobile.video) && <HeroVideo desktop={desktop.video} mobile={mobile.video} />}
    <div className="hero-scrim" aria-hidden="true" />
    <div className="hero-overlay">
      <h1 className="hero-title"><span className="hero-line1">{heroLine1}</span><span className="hero-line2">{heroLine2}</span></h1>
      {heroTagline && <p className="hero-tagline">{heroTagline}</p>}
      <div className="hero-actions">
        <Link className="btn btn-primary" href="/sklep"><span>{ctaLabel}</span><Icon name="arrow" className="btn-arrow" /></Link>
      </div>
    </div>
  </section>
  ```
  (Link from `src/i18n/navigation.ts`; Icon from `src/components/ui/Icon.tsx`. For a video slot, the `<picture>` renders the poster image — the LCP element is always a server-rendered image.)
- `src/components/shop/HeroVideo.tsx` (`'use client'`): at mount, `matchMedia('(prefers-reduced-motion: reduce)')` → render null; else pick the slot by `matchMedia('(min-width:861px)')` (and listen for changes); render `<video className="hero-video" autoPlay muted loop playsInline preload="metadata" poster={…} src={…} />`. Only the active breakpoint's video ever downloads; the `<picture>` poster underneath prevents any flash.

Modified:
- `src/app/[locale]/page.tsx` — add `searchParams?: Promise<{preview?: string}>`; `generateMetadata` → `robots: {index:false, follow:false}` when previewing; `const content = await getHomeContent(locale, preview)`; replace the inline `<section className="hero">…</section>` (L122–171 on main) with `<StripUrlToken names={['preview']} />` + `<HomeHero content={content} />`; delete now-unused hero bindings (HERO_PRINT_ID, heroMug, heroPrint, hero-only imports). beatPrint, hero-beat, marquee and everything below stay.
- `src/styles/site.css` — replace the HERO block (~L128–190 on main): delete `.hero-inner`/`.hero-copy`/`.hero-sub`/`.hero-duo`/`.hero-art*`/`.hero-print*`/`.hero-badge*` (grep each class for other consumers before deleting; `.eyebrow` is generic — keep it). New rules using existing tokens + the single 861px breakpoint only: `.hero` = position:relative; overflow:hidden; height:82svh (88svh at ≥861px); sensible min-height floors; `.hero-media img`, `.hero-video` = absolute inset 0, width/height 100%, object-fit:cover; `.hero-scrim` = bottom gradient (transparent → dark) for text legibility; `.hero-overlay` = absolute bottom-left, padded by `--gut`, `--c-paper` text; `.hero-line1` italic `--f-display` clamp(44px,5.5vw,88px); `.hero-line2` lighter weight clamp(30px,3.6vw,60px); `.hero-tagline` display:none on mobile / `--f-cond` uppercase small on desktop; `.hero-actions` styling preserved (the e2e selector `.hero-actions .btn-primary` must keep working; the bottom-anchored overlay in an 82svh hero keeps the CTA above the fold on a 390×844 viewport).
- `messages/{pl,en,es,de}.json` — remove `home.heroEyebrow`, `heroTitle`, `heroSub`, `heroCta1`, `heroCta2`, `heroBadgeCeramic`, `heroBadgePrint`, `heroPrintMeta`, `heroMetaName`, `heroMetaDesc` (grep each key for remaining consumers first; keep `heroBeatCap`, `heroBeatAlt`).
- `src/lib/home-copy.test.ts` — drop the heroSub {count}/{printCount} assertions; keep printsLead/heroBeatCap/card tests; add coverage for the new home.* keys if the file's pattern calls for it.
- `e2e/hero-header.spec.ts` — CTA/header/beat-cap tests unchanged; add one @ci assertion that `.hero-media img` is visible on `/` (proves the no-CMS fallback renders).

Verification: `npm run lint`, `npm run typecheck`, full `npm run test`, `npm run build` (webpack) all clean. Do not run Playwright (the controller runs @ci specs at the end).

## Whole-plan verification (controller, after Task 5)

- `npm run lint && npm run typecheck && npm run test`
- `npm run build`
- `npx playwright test --grep @ci` (Windows gotcha: serve manually on :3210 + PLAYWRIGHT_BASE_URL if webServer fails)
- Manual `npm run preview:cf` checks (admin upload → draft → preview → publish → revert; /api/media headers incl. Range 206; fallback rendering; video autoplay + reduced-motion) — operator-assisted, after merge-ready.

## Risks / gotchas

- LCP: hero is the LCP element — fetchpriority="high", single-file slots, admin size guidance.
- CLS: zero by construction (svh-fixed hero height); width/height attrs still set.
- Range/iOS: 206 support is a hard requirement for video; suffix + open-ended forms; 416 on unsatisfiable.
- Hidden-element downloads: never CSS-toggle duplicate media — <picture> + JS-gated single video mount.
- Schema-validated reads: getPublishedContent re-validates on read — payload/schema mismatch silently falls back (no stale home payloads exist; the schema was never wired).
- Preview env shares the prod bucket — accepted (hash keys, site-media/ prefix); orphan-cleanup script is a noted follow-up.
- Fan-out draft save creates 4 draft versions per media change — expected; per-locale history stays coherent.
- Worker memory: 50 MB video cap keeps arrayBuffer + digest well inside 128 MB.
