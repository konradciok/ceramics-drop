# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working in this repository.

The full project context — architecture, commands, conventions, deployment — lives in **[AGENTS.md](./AGENTS.md)**, the single source of truth shared with every coding agent (Claude Code, Codex, Cursor, Copilot). It is imported below; keep edits to project guidance in `AGENTS.md`, not here.

@AGENTS.md

## Claude-specific notes

- **Non-negotiable:** the build must stay `next build --webpack`. Turbopack chunks break at the Cloudflare Workers runtime (ChunkLoadError → HTTP 500 on every page). Never add `--turbo` or switch to Turbopack. (Restated here because it is the one rule whose violation takes production down — full rationale in [AGENTS.md](./AGENTS.md).)
- Persistent project memory for this repo lives under `C:\Users\Komp\.claude\projects\E--repositories-ceramics-drop\memory\` (indexed by `MEMORY.md`); it is loaded automatically and reflects what was true when written — verify any file/flag it names still exists before acting.
- Prefer `/ce-work-beta` for plan execution with Codex delegation; deep multi-agent review stays on Claude (`/ce-code-review`, `/ce-doc-review`).
