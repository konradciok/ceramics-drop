# Email migration → `@ciok.art` — agent prompt

> **Purpose:** Copy-paste prompt for an AI agent with MCP access (OVH, Resend, Cloudflare). The agent audits current email setup, plans migration of all addresses to `@ciok.art`, orchestrates DNS/MX/Resend/Workers secrets, and prepares a minimal code diff. **Do not execute production changes without explicit user approval.**

## Context

**Repository:** `ceramics-drop` — Next.js storefront on Cloudflare Workers (OpenNext).

| Layer | Details |
| --- | --- |
| Storefront (WWW) | `anna-ciok.studio` — Cloudflare Workers; DNS in Cloudflare (registrar: Namecheap → NS Cloudflare) |
| **Email (target)** | **`ciok.art`** — DNS/MX/mailboxes likely **OVH** (OVH MCP) |
| Transactional send | **Resend** — `src/lib/email.ts` (fetch REST, Workers-friendly) |
| Worker secrets | `RESEND_API_KEY`, `STUDIO_NOTIFY_EMAIL`, optional `STUDIO_RETURN_*` |

Cloudflare zone ID for `anna-ciok.studio`: `df154a46a71277a8b5b4a9e3d9af23ad` (`docs/cloudflare-deployment.md`) — **does not** govern Resend verification for `ciok.art` unless `ciok.art` DNS is also in Cloudflare (agent must confirm).

---

## Product decision (approved)

**All new email addresses use the `@ciok.art` domain.**

The shop website stays on **`anna-ciok.studio`** — separate domain, not the send/receive email domain.

---

## Target address map @ciok.art

Agent verifies alias availability in OVH/Resend and proposes corrections if needed. Default mapping:

| Role | Current address | Target @ciok.art |
| --- | --- | --- |
| Public contact (mailto, legal, JSON-LD) | `hej@annaciok.pl` | **`hej@ciok.art`** |
| FROM — customer emails (shipping, returns) | `sklep@anna-ciok.studio` | **`sklep@ciok.art`** |
| FROM — InPost labels → studio | `etykiety@anna-ciok.studio` | **`etykiety@ciok.art`** |
| TO — label inbox (Workers secret) | `STUDIO_NOTIFY_EMAIL` | **`studio@ciok.art`** or **`etykiety@ciok.art`** (confirm with user) |
| InPost returns (`STUDIO_RETURN_EMAIL`) | defaults to `STUDIO_NOTIFY_EMAIL` | same as notify, e.g. **`studio@ciok.art`** |
| Reply-To on transactional mail (optional) | none | **`hej@ciok.art`** — recommended |

**FROM strings in code (Resend):**

```
Anna Ciok Studio <sklep@ciok.art>
Etykiety InPost <etykiety@ciok.art>
```

---

## Current state (from repository — verify before planning)

### Transactional send — `src/lib/email.ts`

| Trigger | FROM (current) | TO |
| --- | --- | --- |
| InPost label → studio | `etykiety@anna-ciok.studio` | `STUDIO_NOTIFY_EMAIL` |
| Shipping confirmation → customer | `sklep@anna-ciok.studio` | order email |
| Return label → customer | `sklep@anna-ciok.studio` | order email |

Resend template aliases (`src/lib/email-layout.ts`): `label-to-studio`, `shipping-confirmation`, `return-label-customer`.

Email template footer: `Anna Ciok Ceramics · anna-ciok.studio` + logo from `https://anna-ciok.studio/logotype.png` — **keep** (shop URL, not FROM domain).

### Public contact — `hej@annaciok.pl` in 15+ places

- `src/components/shop/ContactForm.tsx`, `src/lib/contact-mailto.ts` (+ test)
- `src/components/layout/Footer.tsx`
- `src/app/[locale]/page.tsx`, `kontakt/page.tsx`
- `regulamin`, `polityka-prywatnosci`, `dostawa-i-zwroty`
- `src/lib/seo/structured-data.ts` — JSON-LD `email`
- `messages/pl.json`, `en.json`, `es.json` — legal and contact copy

**Rule:** translation keys are a stable contract — change **address values in strings**, not key names.

### Secrets — `.env.example`, `cloudflare-env.d.ts`

```
RESEND_API_KEY=
STUDIO_NOTIFY_EMAIL=studio@example.com   → target e.g. studio@ciok.art
STUDIO_RETURN_EMAIL=                     → optional; defaults to STUDIO_NOTIFY_EMAIL
```

---

## Target architecture

```
┌─────────────────────────────────────────────────────────────┐
│  ciok.art (OVH — DNS + MX + mailboxes/aliases)              │
│  ├── hej@        → public contact inbox (OVH MX)            │
│  ├── studio@     → InPost label inbox (STUDIO_NOTIFY)       │
│  ├── sklep@      → Resend FROM (customers)                  │
│  └── etykiety@   → Resend FROM (label PDFs)                 │
│                                                             │
│  TXT/CNAME: SPF, DKIM, DMARC for Resend on ciok.art         │
└─────────────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
   Resend (send)                  OVH MX (receive)
         │
         ▼
   Cloudflare Worker (ceramics-drop)
   secrets: RESEND_API_KEY, STUDIO_NOTIFY_EMAIL=studio@ciok.art

┌─────────────────────────────────────────────────────────────┐
│  anna-ciok.studio — WWW only (Cloudflare), not email FROM   │
└─────────────────────────────────────────────────────────────┘

Legacy (redirect after migration; do not delete immediately):
  hej@annaciok.pl        → forward → hej@ciok.art
  *@anna-ciok.studio     → retire in Resend after ciok.art verified
```

---

## Agent role

You are a DevOps/infrastructure agent. Goals:

1. Map current email state
2. Plan migration of all addresses to `@ciok.art`
3. Configure infrastructure (OVH DNS/MX, Resend, Cloudflare Workers secrets)
4. Prepare minimal code diff

**Do not apply production changes without explicit user approval.** Deliver a phased plan with risks and rollback.

---

## MCP tools — order of use

### Step 0: Auth

1. `user-ovhcloud-official` → `mcp_auth` if required
2. `user-ovhcloud` — if error, report to user and continue read-only from API docs
3. `user-resend` — domains, templates
4. Cloudflare MCP — only if `ciok.art` DNS is in Cloudflare (unlikely; verify)

### Step 1: OVH discovery — `ciok.art`

```
GET  /domain
GET  /domain/ciok.art/zone/record
GET  /email/domain
GET  /email/domain/ciok.art/account
GET  /email/domain/ciok.art/redirection
```

**OVH API (EU v1):** https://eu.api.ovh.com/1.0  
**Redirection:** `POST /email/domain/ciok.art/redirection` → `{ "from", "to", "localCopy" }`  
**OVH MX:** `mx0.mail.ovh.net` (priority 1), … — https://docs.ovhcloud.com/en/guides/web-cloud/domains/dns-zone-mx

Also check **`annaciok.pl`** — set forward `hej@annaciok.pl` → `hej@ciok.art` during transition.

### Step 2: Resend — add and verify `ciok.art`

```
list-domains
create-domain { name: "ciok.art" }    # if missing
get-domain { id }                     # required SPF/DKIM/DMARC records
verify-domain { id }                  # after DNS records in OVH
list-templates                        # confirm aliases exist
```

Resend DNS records go in the **`ciok.art`** zone (OVH), not Cloudflare `anna-ciok.studio`.

Docs: https://resend.com/docs/dashboard/domains/introduction

### Step 3: Legacy cleanup (after ciok.art verified)

- Resend: stop using `anna-ciok.studio` as FROM; keep domain for rollback window
- OVH: forward old aliases

---

## Refactoring plan

### Phase 1 — Audit (read-only)

- [ ] OVH: `ciok.art` — zone owner, MX, existing accounts
- [ ] OVH: `annaciok.pl` — forwards to migrate
- [ ] Resend: is `ciok.art` already added; status of `anna-ciok.studio`
- [ ] Repo: full grep `hej@annaciok|sklep@anna|etykiety@anna|STUDIO_`
- [ ] Confirm with user: `STUDIO_NOTIFY_EMAIL` = `studio@ciok.art` vs `etykiety@ciok.art`

### Phase 2 — OVH + Resend infrastructure (after approval)

1. Create mailboxes/aliases: `hej@`, `studio@` (or chosen notify inbox)
2. Add Resend DNS records (SPF, DKIM, DMARC) in `ciok.art` zone
3. `verify-domain` in Resend — wait for `verified`
4. Forward: `hej@annaciok.pl` → `hej@ciok.art`
5. Test receive on each inbox

### Phase 3 — Cloudflare Workers secrets

```bash
wrangler secret put STUDIO_NOTIFY_EMAIL    # e.g. studio@ciok.art
wrangler secret put STUDIO_RETURN_EMAIL    # if different
# RESEND_API_KEY — unchanged unless rotating
```

### Phase 4 — Code (minimal diff, centralize addresses)

**New file** `src/lib/email-addresses.ts`:

```typescript
/** Single source of truth — all @ciok.art addresses */
export const EMAIL = {
  contact: 'hej@ciok.art',
  shopFrom: 'sklep@ciok.art',
  labelsFrom: 'etykiety@ciok.art',
  shopFromDisplay: 'Anna Ciok Studio',
  labelsFromDisplay: 'Etykiety InPost',
} as const;

export const EMAIL_FROM = {
  shop: `${EMAIL.shopFromDisplay} <${EMAIL.shopFrom}>`,
  labels: `${EMAIL.labelsFromDisplay} <${EMAIL.labelsFrom}>`,
} as const;
```

**Files to update:**

| File | Change |
| --- | --- |
| `src/lib/email.ts` | `FROM` / `CUSTOMER_FROM` → `EMAIL_FROM.*` |
| `src/lib/contact-mailto.ts`, `ContactForm.tsx`, test | `hej@ciok.art` |
| `Footer.tsx`, `page.tsx`, legal pages | mailto → `hej@ciok.art` |
| `src/lib/seo/structured-data.ts` | JSON-LD email |
| `messages/pl.json`, `en.json`, `es.json` | `hej@annaciok.pl` → `hej@ciok.art` in all strings |
| `.env.example` | comments: FROM `@ciok.art`, Resend domain `ciok.art` |
| `src/lib/return.test.ts`, `shipx.test.ts` | mock email → `@ciok.art` |

**No changes:**

- `email-layout.ts` — footer “anna-ciok.studio” (shop URL)
- `wrangler.jsonc` — WWW domains
- i18n keys — address values only

### Phase 5 — Verification

- [ ] `npm test` — email, contact-mailto, return, shipx
- [ ] Resend test send: FROM `sklep@ciok.art`, `etykiety@ciok.art`
- [ ] InPost webhook (staging): label PDF → `STUDIO_NOTIFY_EMAIL`
- [ ] `/kontakt` — mailto `hej@ciok.art`
- [ ] JSON-LD — `hej@ciok.art`
- [ ] Mail to `hej@annaciok.pl` arrives at `hej@ciok.art` (forward)
- [ ] DMARC alignment: FROM `@ciok.art` + Resend SPF/DKIM on `ciok.art`

---

## Constraints

1. Never commit secrets or `.dev.vars`
2. Do not remove old DNS records / forwards before new ones are tested
3. No production deploy without approval
4. Two registries: **email DNS = OVH (`ciok.art`)**, **WWW = Cloudflare (`anna-ciok.studio`)** — do not mix zones
5. Resend failure in InPost webhook → HTTP 500 → retry — test carefully

---

## Expected agent deliverable format

1. **Executive summary**
2. **OVH `ciok.art` state** — DNS, MX, accounts (MCP results)
3. **Resend state** — `ciok.art` verification
4. **Migration map** — old → new address
5. **Phased plan** with PR checklist
6. **One question** (if needed): `STUDIO_NOTIFY_EMAIL` = `studio@ciok.art` or `etykiety@ciok.art`?

---

## Helper commands (repo)

```bash
rg -i "mailto:|@anna|@annaciok|@ciok|STUDIO_|RESEND|sklep@|etykiety@" --glob "!node_modules"
npm test -- src/lib/email.test.ts src/lib/contact-mailto.test.ts
npm run cf-typegen   # after cloudflare-env.d.ts changes
```

---

## Start

1. Authorize OVH + Resend MCP
2. Read-only discovery of `ciok.art` in OVH
3. Present plan — **wait for variant approval** before any write operations
