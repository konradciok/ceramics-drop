# Notion translation editor (pl.json)

Edit Polish UI copy in Notion’s table UI; pull changes back into `messages/pl.json` before deploy.

**Source of truth for the site:** `messages/pl.json` in this repo (loaded by next-intl).  
**Editing UI:** Notion database **ACC — Polish translations (pl.json)**.

## Translation files in this repo

| File | Role |
|------|------|
| `messages/pl.json` | Polish catalog — **wire this to Notion first** |
| `messages/en.json` | English reference column on push |
| `messages/es.json` | Spanish — extend the same pattern later |

**Shape:** nested objects + string arrays only (e.g. `home.marquee.0`, `notes.kubki.26`).  
**Leaf count (pl):** 482 strings. ICU placeholders (`{count, plural, …}`) and rich-text markers (`<em>`, `<link>`) are stored as plain text.

## Feasibility notes

- **Flatten / unflatten** is safe for this JSON: all leaves are strings; arrays use numeric suffixes (`.0`, `.1`, …).
- **Repo wins on deploy** — merge Notion edits with `npm run i18n:pull` before commit; do not edit `pl.json` and Notion in parallel without pulling.
- **Push does not overwrite Status** on existing rows — only Polish/English text updates.
- **Pull** applies rows with Status **Ready** or **Done** (or `--since-last-sync` for rows edited after the last pull).
- **Key order** is preserved via the on-disk JSON structure; pull updates values in place.
- **Risk:** codegen or other agents editing `messages/pl.json` directly — pull may conflict; prefer one editor at a time.

## One-time setup

1. Create a Notion integration: [notion.so/my-integrations](https://www.notion.so/my-integrations) → copy **Internal integration secret**.
2. Share the database (or its parent page) with the integration (**⋯ → Connections**).  
   The integration must be able to see the DB — run `npm run i18n:check` to verify before push.
3. Copy `.env.example` → `.env` and set:

```env
NOTION_TOKEN=secret_…
NOTION_DATABASE_ID=e0a71651758c4a9aa4f5de46447336a7
```

The database already exists under **Ceramics Drop — Go to Market** in Notion. To create a fresh copy elsewhere:

```bash
NOTION_PARENT_PAGE_ID=<page-uuid> npm run i18n:setup
```

## Commands

```bash
npm run i18n:push              # pl.json + en.json → Notion (create/update rows)
npm run i18n:push -- --dry-run # preview without API writes

npm run i18n:pull              # Notion (Ready/Done) → pl.json
npm run i18n:pull -- --dry-run
npm run i18n:pull -- --since-last-sync   # also rows edited since last pull
```

**Typical workflow**

1. `npm run i18n:push` — refresh Notion from repo (after adding new keys in code).
2. Edit **Polish** in Notion; set **Status** to **Ready** when done.
3. `npm run i18n:pull` — write approved rows to `pl.json`.
4. Commit `messages/pl.json` and deploy.

Local sync metadata (page IDs, timestamps) lives in `.notion-i18n/state.json` (gitignored).

## Database columns

| Column | Purpose |
|--------|---------|
| **Key** | Dotted path (`cart.heading`, `notes.kubki.0`) |
| **Area** | High-level site group (6 areas — Shop, Home, Collections, …) |
| **Page** | Page or screen (Cart, Home, Terms, …) |
| **Section** | Sub-block within the page (Main, Marquee, Mugs, …) |
| **Polish** | Editable PL string |
| **English** | Reference from `en.json` (updated on push) |
| **Status** | Draft → In review → **Ready** / **Done** (pull filter) |
| **Notes** | Optional translator comments |

**Views:** In the database, use **By page** or **By area** board views. For a cleaner editor layout, open **ACC translations — by page & section** (under Ceramics Drop — Go to Market) — six filtered tables, one per area.

After adding new keys in code, run `npm run i18n:push` then `npm run i18n:organize` if grouping columns look empty.

## Phase 3 (not implemented)

Scheduled pull or Notion webhooks are unnecessary for on-demand editing. Revisit only if multiple editors need automatic sync.
