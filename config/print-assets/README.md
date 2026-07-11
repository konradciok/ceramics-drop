# Print asset prepare configs

One file per print product: `config/print-assets/{productId}.json`.
Defines an explicit crop/focal region for every distinct print-area
dimension (profile) the design's active variants require. Consumed by
`scripts/print-assets-prepare.ts` (Phase 2a of
`docs/plans/print-asset-pipeline.md`).

## ⚠️ `fap01.json` currently has PLACEHOLDER crops

Every profile in `fap01.json` is `{ "left": 0, "top": 0, "width": <target>,
"height": <target> }` — i.e. it assumes the source master is already
composed/cropped per profile ahead of time. That is **not realistic** for a
single full-bleed photograph or scan.

These placeholder crops pass every automated check the pipeline runs (aspect
match, no enlargement, within source bounds) — the pipeline has no way to
tell "mathematically valid" apart from "the right part of the image, at the
right focal point, approved by the studio." Nothing in `print-assets-prepare.ts`
enforces studio sign-off; the only defense is a human looking at the
`proof-*.jpg` files it generates next to each derivative.

**Before running `print-assets:prepare` against a real `fap01` master**, an
operator MUST:

1. Open the master in an image editor next to `fap01.json`'s profile list.
2. For each profile, pick real `left/top/width/height` values that frame the
   artwork correctly for that print size/aspect (see
   `docs/plans/print-asset-pipeline.md` Settled Architecture §1: "Require an
   explicit crop/focal configuration for every distinct aspect ratio. Do not
   silently accept Sharp's or Prodigi's centre crop.").
3. Update `fap01.json` with the reviewed crops.
4. Run `prepare`, then visually check every `proof-*.jpg` before proceeding to
   upload/publish (Phase 2b).

Do not treat the current `fap01.json` as approved artwork direction. It exists
only to exercise the schema and the pipeline end-to-end.
