# Full-Bleed Print Assets — Implementation Plan

> Date: 2026-08-03
> Status: PLANNED (no code changes yet)
> Scope: fulfilment pipeline support for full-bleed, per-ratio print masters
> (the 43 new paintings). The poster path (fap01–fap03: margins + background +
> signature) stays untouched and remains the default.

## Decision record

- The 43 new paintings sell **full-bleed**: the submitted derivative IS the
  artwork, edge to edge. No poster border, no signature.
- Derivatives are rendered from **per-ratio masters**, not one master per
  design — the operator controls the crop/extension per aspect ratio in
  Photoshop (generative canvas extension), so the pipeline must never
  re-crop. Canonical location (gitignored):

  ```
  design/uploads/master-images-prints/{NN}/{NN}__{ratio}.jpg
  NN ∈ 01..43,  ratio ∈ 3x4 | 5x7 | 7x10 | 2x3
  ```

- Verified 2026-08-03: 43 folders × 4 files, all present; ratios exact;
  every master ≥ its largest target profile (no-upscale holds: min widths
  8858/8436/8412/8412 vs targets 3600/6000/8400/7200).

## Profile → ratio mapping (fixed by PRODIGI_SKU_MAP / assetPxFor)

| Profile (assetPx) | Ratio source | Variants |
|---|---|---|
| 3600x4800 | `3x4` | 30x40 unframed + framed (incl. black, decision #6) |
| 6000x8400 | `5x7` | 50x70 unframed + framed |
| 8400x12000 | `7x10` | 70x100 unframed + framed |
| 2400x3600 / 4800x7200 / 7200x10800 | `2x3` (shared) | all mounted (CFPM) |

6 distinct profiles per design, 4 source files. Mapping must be resolved by
aspect ratio with a strict tolerance and **fail closed** on an unknown
profile ratio (a future SKU with a new ratio must break prepare, not
silently reuse a wrong master).

## What does NOT change

- `upload` / `verify` / `publish` scripts, the atomic RPC, R2 key scheme,
  immutability rules.
- Checkout snapshot, `resolvePrintAsset`, queue + `process-job`, HMAC Worker
  route, Prodigi mapper (`sizing: fillPrintArea` stays as defence in depth).
- Poster mode: existing configs (`fap01`–`fap04`) keep working byte-for-byte
  (rendererVersion bump only re-gates manifests, see Phase 2).

## Phase 0 — Decisions to lock before code

- [ ] **Design ids for the 43**: proposal `fap005`…`fap047` (onboarding
      schema requires `^fap\d{3,}$`; existing 2-digit `fap01`–`fap04` stay).
      Mapping `NN → fap(NN+4)` recorded in the onboarding manifest, painting
      number kept in `PrintDesign.num`.
- [ ] **Manifest versioning**: recommended — keep `schemaVersion: 2` with an
      additive, mode-gated shape (top-level `source*` fields for poster mode;
      per-profile `source` object for fullBleed), and bump
      `COMPOSE_RENDERER_VERSION` to `3.0.0`. Alternative: `schemaVersion: 3`.
      Decide once `parsePrepareManifest` strictness is reviewed in Phase 1.
- [ ] Pilot design: `fap005` (painting 01).

## Phase 1 — Pure lib support (src/lib/print-assets-prepare.ts + tests)

- [ ] Extend `PrepareConfig` with `mode?: 'poster' | 'fullBleed'` (absent =
      `poster`, full back-compat). FullBleed config shape:

      ```jsonc
      {
        "product": "fap005",
        "mode": "fullBleed",
        "format": "jpg",
        "sources": {
          "3x4":  "design/uploads/master-images-prints/01/01__3x4.jpg",
          "5x7":  "design/uploads/master-images-prints/01/01__5x7.jpg",
          "7x10": "design/uploads/master-images-prints/01/01__7x10.jpg",
          "2x3":  "design/uploads/master-images-prints/01/01__2x3.jpg"
        },
        "gallery": { "hero": { "sourceProfile": "8400x12000", "uploadStem": "fap-005" } }
      }
      ```

- [ ] `validatePrepareConfig`: in fullBleed mode REQUIRE `sources` (exactly
      the four ratio keys, non-empty paths) and REJECT `artwork`,
      `background`, `layout`, `signature` (explicit error, no silent
      ignoring). Poster mode validation unchanged.
- [ ] New pure `ratioForProfile(w, h)`: maps a profile to `3x4|5x7|7x10|2x3`
      by aspect with tolerance ≤ 0.5%; throws on no match. Unit-test against
      all six current profiles + a poison profile.
- [ ] FullBleed placement: trivial `Placement` (artworkBox = full canvas,
      no signature). Source ratio must match target ratio within 0.5% or
      prepare fails (protects against a wrong/renamed file — the pipeline
      never crops in this mode). `validateNoUpscale` reused as-is
      (contain == cover when ratios match).
- [ ] Manifest: per-profile source identity (`sourceSha256`, `sourceWidth`,
      `sourceHeight`, `sourcePath`) recorded per derivative in fullBleed
      mode; parser accepts both shapes per the Phase 0 decision.

## Phase 2 — Operator scripts (scripts/)

- [ ] `print-assets-prepare.ts`: branch on `mode`. FullBleed path: load the
      four sources, decode + validate ratio/no-upscale per profile, Sharp
      resize (Lanczos3) to exact profile px, sRGB profile embedded, same
      determinism guarantees (double-run byte-identity), proofs generated per
      profile as today.
- [ ] `preflightPreparedRevision` (upload preflight): teach the
      config ⇄ manifest ⇄ on-disk byte-identity check the multi-source shape.
- [ ] `verify` / `publish`: no logic change expected — confirm via tests that
      the manifest projection they consume is shape-stable; adjust the legacy
      projection only if the Phase 0 manifest decision requires it.
- [ ] Tests with tiny fixtures (e.g. 30x40/45x63/42x60/24x36 px sources):
      full-bleed compose determinism, ratio-mismatch failure, upscale
      failure, config validation matrix, manifest round-trip.

## Phase 3 — Onboarding + catalog for the 43

- [ ] Extend `onboardingRowSchema` with `style: 'poster' | 'fullBleed'` and,
      for fullBleed, `masterFolder` (default derivable from the manifest
      row's painting number). Poster rows keep the current `incomingFile`
      flow.
- [ ] Onboard validation for fullBleed rows: all four sources exist, decode,
      exact ratio, resolution floor per profile (reuse
      `expectedVariantDimensions` + `ratioForProfile`).
- [ ] `buildPrepareConfig` emits the fullBleed config shape; generated
      `PrintDesign` entries default to full axes (policy #7) and
      `published: false`.
- [ ] Operator steps: paste generated entries into `src/lib/prints.ts`,
      provide storefront `image` webps (separate track), run
      `npm run catalog:backfill` (adds 43 × 21 = 903 variants),
      re-run `scripts/verify-print-area-contract.ts`.

## Phase 4 — Pilot, then batch rollout

- [ ] Pilot `fap005` end-to-end on sandbox: prepare → visual proof review →
      upload → verify → publish → sandbox order (`print-assets:sandbox-matrix`
      / `print-asset-smoke`) → confirm Prodigi downloads the asset and the
      order reaches `complete`.
- [ ] Batch the remaining 42: small operator loop (or documented shell loop)
      over `--product fapNNN --revision <R>`; publish stays per-product with
      explicit `--confirm`.
- [ ] R2 volume estimate: 43 designs × 6 derivatives ≈ 260 objects,
      ~3–6 GB one-time. Checkout stays fail-closed until each design is
      published — unpublished designs are browsable-but-unbuyable, so
      rollout can be incremental.

## Phase 5 — Deferred / parallel (not fulfilment-blocking)

- Storefront visuals for the 43: gallery WebPs (`print-assets:gallery` works
  from a published derivative + `gallery` config), mockups (poster-specific
  framing assumptions — review before reuse), product copy/notes, pricing
  overrides if any.
- Poster path for fap02's widened variants (existing decision) proceeds
  independently with its existing config.
- Photoshop Stage B script (`2_export_print_jpgs.jsx`) becomes redundant for
  fulfilment once fullBleed prepare lands (Stage A / generative expansion
  remains the artistic step). Retire it in the masters-folder README.

## Risks

- **Manifest strictness**: the exact blast radius of the multi-source
  manifest shape on `upload`/`verify`/`publish` parsers is the main unknown;
  Phase 1 starts with a read of `parsePrepareManifest` + the legacy
  projection and locks the Phase 0 versioning decision before code.
- **Wrong-file protection** relies on the ratio check; two same-ratio
  paintings swapped between folders would not be caught by geometry — the
  per-profile `sourceSha256` in the manifest plus operator proof review is
  the guard.
- **`design/` is gitignored**: masters exist only on the operator machine —
  backup policy for `design/uploads/master-images-prints/` should be
  confirmed (R2 keeps derivatives, not sources).
