# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working in this repository.

The full project context — architecture, commands, conventions, deployment — lives in **[AGENTS.md](./AGENTS.md)**, the single source of truth shared with every coding agent (Claude Code, Codex, Cursor, Copilot). It is imported below; keep edits to project guidance in `AGENTS.md`, not here.

@AGENTS.md

## Claude-specific notes

- **Non-negotiable:** the build must stay `next build --webpack`. Turbopack chunks break at the Cloudflare Workers runtime (ChunkLoadError → HTTP 500 on every page). Never add `--turbo` or switch to Turbopack. (Restated here because it is the one rule whose violation takes production down — full rationale in [AGENTS.md](./AGENTS.md).)
- **(Claude Code desktop only)** If persistent project memory exists for this repo, it lives under `~/.claude/projects/<repo-slug>/memory/`, indexed by `MEMORY.md` and loaded automatically. The slug is machine-specific (it encodes the local checkout path), so do not assume a fixed location. Memory reflects what was true when written — verify any file/flag it names still exists before acting. Cloud/remote agents (Cursor, CI) won't have this path — rely on `AGENTS.md` and `docs/` instead.
- Prefer `/ce-work-beta` for plan execution with Codex delegation; deep multi-agent review stays on Claude (`/ce-code-review`, `/ce-doc-review`).
