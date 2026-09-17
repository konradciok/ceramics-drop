# Cloudflare Container image for the print-asset derivative processor
# (Priority 8 / Phase 3). Built by `wrangler deploy` from wrangler.jsonc's
# `containers[].image` + `image_build_context: "."` — the build context is the
# REPO ROOT, not this directory, because the image runs the repo's own
# src/lib + src/server sources.
#
# Cloudflare requires linux/amd64 (containers/get-started: "Your container image
# must be able to run on the `linux/amd64` architecture"), pinned explicitly so
# an arm64 developer machine cannot build an image the platform silently refuses.
FROM --platform=linux/amd64 node:22-bookworm-slim

WORKDIR /app

# Three runtime dependencies only (sharp + zod + tsx) — see container/package.json.
# `npm install` rather than `npm ci`: this image deliberately carries no
# lockfile of its own, and the ranges are asserted against the root
# package.json by src/server/asset-jobs/container-config.test.ts.
#
# sharp ships prebuilt linux-x64 libvips binaries, so no apt build toolchain is
# needed here. If a future sharp bump ever drops that prebuild, this layer is
# where `apt-get install -y libvips-dev build-essential` would go.
COPY container/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund

# The container's own entry point plus exactly the two source trees it imports.
# `src/app` / `src/components` (the Next.js application) are deliberately NOT
# copied: nothing here imports them, and keeping them out keeps the image small
# and the attack surface of the one process that decodes untrusted image bytes
# as narrow as possible.
COPY container/server.ts ./container/server.ts
COPY src/lib ./src/lib
COPY src/server ./src/server

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# tsx type-strips on the fly; `import type` specifiers (including the `@/…`
# aliased ones in container-protocol.ts) are erased, so no tsconfig path
# resolution is needed at runtime. Every VALUE import in this graph is relative.
CMD ["npx", "tsx", "container/server.ts"]
