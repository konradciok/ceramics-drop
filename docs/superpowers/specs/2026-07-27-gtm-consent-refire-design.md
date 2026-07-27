# GTM consent re-fire: base tags never recover after a mid-session "Accept"

Status: Design approved 2026-07-27, not yet implemented.

## Context

While gating the previously-undiscovered `Microsoft Clarity - Official` tag for
consent (PR #200, the event-system-audit F-02 follow-up), CodeRabbit flagged a
"Major / Functional Correctness" finding: Clarity's tag only has an
`All Pages`-equivalent trigger, so if a visitor denies
`analytics_storage` on load and grants it later via the cookie banner, GTM
never re-fires the tag for that pageview.

Investigation (Google's own Tag Manager docs + independent GTM expert Simo
Ahava's "Basic Consent Mode" guide, both fetched and cross-checked 2026-07-27)
confirmed this is a real, general GTM limitation, not a Clarity-specific bug:
**"Additional Consent Checks" (the `consentSettings` field on a GTM tag) is a
one-time gate evaluated only when the tag's own trigger fires. It does not
listen for later `gtag('consent','update',...)` calls and does not re-fire the
tag automatically.**

Tracing the app's actual consent flow
(`src/components/consent/consent-mode.ts`, `ConsentBanner.tsx`) shows this is
not just Clarity's problem:

- `ACC - GA4 base` and `ACC - Meta Pixel base` (the two GTM tags that load
  `gtag.js`/`fbq.js` in the first place) fire on `ACC - Initialization`, a
  GTM `init`-type trigger — fires exactly once, when the container itself
  initializes.
- `ACC - GA4 dataLayer bridge` and `ACC - Meta dataLayer bridge` fire on
  `ACC - analytics dataLayer events`, a `customEvent` trigger matching any of
  `ANALYTICS_EVENTS` (`page_view`, `add_to_cart`, `site_engagement`, …) — this
  one *does* re-evaluate on every subsequent matching event, so it isn't
  itself one-shot. But its own tag body no-ops via `if (!window.gtag) return;`
  / `if (!window.fbq) return;` if the base tags never loaded those globals.
- `ConsentBanner.tsx`'s `choose(v)` handler calls `setConsent(v)` — which
  writes the cookie and calls `gtag('consent','update',...)` — then
  `setDismissed(true)`. **No dataLayer event is pushed.** Nothing tells GTM to
  re-evaluate anything.
- Returning visitors are unaffected: `defaultConsentSnippet()` (the
  `beforeInteractive` script, runs *before* GTM loads) reads the stored
  cookie and calls `gtag('consent','update',granted)` synchronously, before
  `Initialization` ever fires. GTM's own consent bootstrapping sees granted
  consent from the start, so the base tags fire correctly on the very first
  evaluation.

**Net effect:** any visitor who decides via the banner mid-session (i.e.
almost every first-time "Accept") gets no GA4 ecommerce funnel, no Meta Pixel
`fbp`/`fbc` (which the server-side Meta CAPI dedup depends on), and now no
Clarity — for their entire session, since Next.js client-side navigation
doesn't reinitialize the GTM container. This predates today's work; gating
Clarity the same way the other 4 tags are gated just means it now shares this
pre-existing limitation instead of being uniquely broken.

## Decision

Add a dedicated `consent_update` dataLayer event, pushed by `setConsent()`
immediately after the existing `gtag('consent','update',...)` call — this is
the pattern Google/Simo Ahava's own "Basic Consent Mode" guidance describes
for exactly this gap ("the Update call should be immediately followed by a
`dataLayer.push`"). Add one new GTM trigger matching that event, and add it
as a **second** firing trigger on the three affected tags (`ACC - GA4 base`,
`ACC - Meta Pixel base`, `Microsoft Clarity - Official`), alongside each tag's
existing trigger. Everything else about those tags — `consentSettings`,
`oncePerLoad` — stays as-is.

### Alternatives considered

1. **Trigger-level consent logic instead of tag-level `consentSettings`**
   (Simo Ahava's stronger recommendation: drop Additional Consent Checks
   entirely, gate via a trigger condition reading a Consent State variable).
   Sidesteps a community-reported GTM quirk where a *blocked* firing attempt
   may consume the tag's "once per page" budget, making a second trigger a
   no-op too. Rejected as the primary approach because it's a materially
   bigger restructuring (new variable types, two separate trigger conditions
   for `analytics_storage` vs `ad_storage`) — kept as the documented fallback
   if empirical testing (see Verification) shows the chosen approach doesn't
   work.
2. **`window.location.reload()` after Accept.** Trivially correct — a fresh
   load re-runs the same before-GTM snippet that already handles returning
   visitors. Rejected: a forced full-page reload immediately after clicking a
   banner button is a real UX regression (lost scroll position, in-flight
   cart/form state, a white-flash reload) for a problem that doesn't need it.

## Design

### App side: `src/components/consent/consent-mode.ts`

`setConsent(value)` gains one line: after the existing `window.gtag?.(...)`
call, push a `consent_update` event via `pushDataLayer()` (imported from
`src/lib/analytics.ts` — this reuses the existing `app_version`/`app_git_sha`
stamping and debug-mirroring for free, and is safe to call here since
`setConsent` only ever runs client-side, after full app hydration, unlike
`defaultConsentSnippet()`'s inline bootstrap string). Event shape:
`{ event: 'consent_update', consent_state: 'granted' | 'denied' }`.

`consent_update` is **not** added to `ANALYTICS_EVENTS` in `analytics.ts` — it
must not match the existing bridge-tag trigger, so it never gets forwarded to
GA4/Meta as a fake user event. It exists purely as a GTM-internal signal.

`defaultConsentSnippet()` (the returning-visitor bootstrap) is **not**
touched — per Context above, that path already works correctly today.

### GTM side: `scripts/gtm-api.mjs`

`setupWorkspace()` gains one new trigger, `ACC - Consent Update`
(`type: 'customEvent'`, matching `consent_update` via the same
`matchRegex`/`{{_event}}` pattern the existing custom-event trigger uses),
created via the existing `upsertTrigger` helper. `ACC - GA4 base` and
`ACC - Meta Pixel base`'s `customHtmlTag(...)` calls gain this trigger's id
in their `firingTriggerId` array, alongside `ACC - Initialization`'s id — no
other options change. `Microsoft Clarity - Official` (UI-managed, not part of
`setupWorkspace()` — see PR #200) gets the same trigger id added to its
`firingTriggerId` by a direct, one-off Tag Manager API call, matching how it
was gated last time.

### Data flow

1. First-time visitor loads the page with consent denied. `Initialization`
   fires; `ACC - GA4 base`/`ACC - Meta Pixel base` are blocked (denied
   consent); `Microsoft Clarity - Official`'s equivalent trigger is likewise
   blocked.
2. Visitor clicks Accept. `setConsent('granted')` writes the cookie, calls
   `gtag('consent','update', granted)`, then pushes `consent_update`.
3. `ACC - Consent Update` trigger fires. The three tags' consent checks now
   read granted; they fire, `window.gtag`/`window.fbq` become defined.
4. Any subsequent dataLayer event from the visitor's continued browsing
   (a `page_view` on the next soft-navigation, `add_to_cart`, …) reaches the
   bridge tags via their existing trigger; their consent check now passes and
   `window.gtag`/`window.fbq` exist, so GA4/Meta/Clarity track normally for
   the rest of the session.
5. A visitor who denies and never accepts: no `consent_update` event, nothing
   changes — identical to today's (correct) behaviour.

### Error handling / edge cases

- **Double-fire:** if `consent_update` somehow fires twice (e.g. a double
  click before `setDismissed` re-renders the banner away), `oncePerLoad` on
  the three tags means only the first actual execution counts — no duplicate
  library loads, *provided* the "once-per-page quirk" from Alternative 1
  doesn't apply (to be confirmed empirically — see Verification).
- **Reject path:** `setConsent('denied')` also pushes `consent_update` with
  `consent_state: 'denied'` for symmetry/observability, but the consent check
  still fails, so nothing fires — harmless.
- **No server-side impact:** this is entirely client-side GTM/dataLayer; no
  webhook, checkout, or Supabase code is touched.

### Testing

- **Unit** (`consent-mode.test.ts`, currently thin — closes part of the F-19
  backlog note on `setConsent()`'s `gtag` call being untested): assert
  `setConsent('granted')` and `setConsent('denied')` each push a
  `consent_update` event with the correct `consent_state` alongside the
  existing `gtag` assertion.
- **Empirical/integration** (GTM Preview, browser-automated, against the
  draft workspace — no live traffic affected): simulate deny-on-load then
  accept mid-session; confirm in Tag Assistant that `ACC - GA4 base`,
  `ACC - Meta Pixel base`, and `Microsoft Clarity - Official` actually fire
  after Accept, not just that the trigger evaluates. This is what resolves
  the open question from Alternative 1 (does a previously-blocked tag's
  "once per page" budget get consumed even while blocked) one way or the
  other, before anything publishes. If Preview shows the tags still don't
  fire, fall back to Alternative 1 for the affected tag(s) rather than
  publishing something unverified.
- No new GA4 custom dimension is needed — `consent_update` never reaches GA4.

### Rollout

Same care as the Clarity fix (PR #200): `workspaces.sync()` first (the
container's one workspace can drift stale relative to the live version — see
`gtm-ga4-service-account-access` memory), verify in Preview, then
`create_version` + `publish`, then re-verify via `versions.live()` that all
three tags carry the new trigger and still show correct `consentSettings`.
