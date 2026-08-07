# Changelog

## [0.14.0](https://github.com/konradciok/ceramics-drop/compare/v0.13.0...v0.14.0) (2026-08-07)


### Features

* **admin/products:** list navigation, editor safety, audit timeline ([#234](https://github.com/konradciok/ceramics-drop/issues/234)) ([392bbdf](https://github.com/konradciok/ceramics-drop/commit/392bbdf097c0cb6aae467d3934dd40a6232a4a50))
* **notes:** support fine-art prints in notes:generate ([#230](https://github.com/konradciok/ceramics-drop/issues/230)) ([e2d8acf](https://github.com/konradciok/ceramics-drop/commit/e2d8acfcc1903e83bd5c411c049bd6a9639ed257))
* **prints:** global admin-managed print price list (EUR-canonical) ([#235](https://github.com/konradciok/ceramics-drop/issues/235)) ([d0f9006](https://github.com/konradciok/ceramics-drop/commit/d0f90062cf884904ae33ef8119a9f20044d7e82c))
* **prints:** real Polish notes for all 43 production designs ([#232](https://github.com/konradciok/ceramics-drop/issues/232)) ([0de2151](https://github.com/konradciok/ceramics-drop/commit/0de21518513530e0f2d10600d168212f58d36fa4))
* **prints:** translate the 43 print notes into en/es/de ([#233](https://github.com/konradciok/ceramics-drop/issues/233)) ([0fd93d8](https://github.com/konradciok/ceramics-drop/commit/0fd93d8471780878c2e7dbadaf2bfc07caa9c165))

## [0.13.0](https://github.com/konradciok/ceramics-drop/compare/v0.12.0...v0.13.0) (2026-08-07)


### Features

* **print-assets:** full-bleed mode for prepare/onboard pipeline (Phases 1-3) ([#219](https://github.com/konradciok/ceramics-drop/issues/219)) ([1460dd7](https://github.com/konradciok/ceramics-drop/commit/1460dd707b5833b2be8ae45a500fd1fb37fef8a7))
* **prints:** fap005 fully live — real gallery + mockup images ([#223](https://github.com/konradciok/ceramics-drop/issues/223)) ([060f2e1](https://github.com/konradciok/ceramics-drop/commit/060f2e129eee481d2ca1b6e6ecab150ffcda64ee))
* **prints:** fap006-fap047 fully live (Phase C batch, 41 designs + fap015 retry) ([#225](https://github.com/konradciok/ceramics-drop/issues/225)) ([4bc0d87](https://github.com/konradciok/ceramics-drop/commit/4bc0d872f38695a7f7f0f8fb11a052284a5fbe76))
* **prints:** group fine-art prints into five curated collections ([#227](https://github.com/konradciok/ceramics-drop/issues/227)) ([96da974](https://github.com/konradciok/ceramics-drop/commit/96da974e89cd9b4078bac4e2dd140dda326f2489))
* **prints:** live print mockups + brown frames ([#205](https://github.com/konradciok/ceramics-drop/issues/205)) ([6167c62](https://github.com/konradciok/ceramics-drop/commit/6167c622d8b900808ce117583baa6e52474694ec))
* **prints:** publish fap005 MVP content, set num for all 43 full-bleed designs ([#220](https://github.com/konradciok/ceramics-drop/issues/220)) ([fcca606](https://github.com/konradciok/ceramics-drop/commit/fcca6062bc33960c3382adcc694f53fd632c9d8f))
* **prints:** publish fap006-fap047 (Phase C batch, 42 designs) ([#224](https://github.com/konradciok/ceramics-drop/issues/224)) ([ac3c3c4](https://github.com/konradciok/ceramics-drop/commit/ac3c3c41aa3b0ae252362883ac3712533a55329a))
* **prints:** withdraw legacy posters fap01-03 — production designs only ([#228](https://github.com/konradciok/ceramics-drop/issues/228)) ([29ed36b](https://github.com/konradciok/ceramics-drop/commit/29ed36b8840639195c309ed87513acdb6ac75726))


### Bug Fixes

* **analytics:** docs-only — AGENTS.md sync describing the already-shipped webhook idempotency ledger and print feed rows (no runtime change) ([#221](https://github.com/konradciok/ceramics-drop/issues/221)) ([6bda2a4](https://github.com/konradciok/ceramics-drop/commit/6bda2a4573ae9a1ab0b171a0c9a80c1dec1c1a49))
* **print-assets:** Windows spawnSync + R2 upload bugs found running the real fap005 pilot ([#222](https://github.com/konradciok/ceramics-drop/issues/222)) ([f8fbd09](https://github.com/konradciok/ceramics-drop/commit/f8fbd099faf6b70c98dc8f02af52ea2014d2d970))

## [0.12.0](https://github.com/konradciok/ceramics-drop/compare/v0.11.0...v0.12.0) (2026-07-29)


### Features

* **analytics:** native GTM tags replace the Custom-HTML bridges (F-03/F-04) ([#215](https://github.com/konradciok/ceramics-drop/issues/215)) ([caf7bc0](https://github.com/konradciok/ceramics-drop/commit/caf7bc0426662bdf7acd625bb323eefd6f6ffcf7))


### Bug Fixes

* **analytics:** event-correctness plan — item_variant symmetry, begin_checkout dedup, currency labels (Plan 3) ([#212](https://github.com/konradciok/ceramics-drop/issues/212)) ([c4b7757](https://github.com/konradciok/ceramics-drop/commit/c4b7757d6d53d8f239f65dd8d1086fa53e5daaa1))
* **analytics:** fine-art prints analytics parity — feeds + full funnel (N-2) ([#211](https://github.com/konradciok/ceramics-drop/issues/211)) ([3602884](https://github.com/konradciok/ceramics-drop/commit/3602884c6126e0beb749fd2c93887ceb3ad4b131))
* **analytics:** GA4 measurement hygiene — EM ownership, CAPI token header, doc conventions (Plan 4) ([#213](https://github.com/konradciok/ceramics-drop/issues/213)) ([93eb4b6](https://github.com/konradciok/ceramics-drop/commit/93eb4b6d992b83a61b52338b035fd8685ec69040))
* **analytics:** identity, CI guards, Sentry/CSP hardening, webhook ledger (Plan 5) ([#214](https://github.com/konradciok/ceramics-drop/issues/214)) ([ac2e510](https://github.com/konradciok/ceramics-drop/commit/ac2e51087ca82e0cf251f43bd1280668ece9c684))
* **analytics:** stop capability tokens leaking to GA4 via page_location (N-1) ([#208](https://github.com/konradciok/ceramics-drop/issues/208)) ([64a636c](https://github.com/konradciok/ceramics-drop/commit/64a636c5a02303bee49a18a01308e8103fcc450a))

## [0.11.0](https://github.com/konradciok/ceramics-drop/compare/v0.10.0...v0.11.0) (2026-07-28)


### Features

* **analytics:** stamp app_version/app_git_sha on GA4 events ([4afef79](https://github.com/konradciok/ceramics-drop/commit/4afef7996e896b69896c2b7d8d46fc5e66ff3d98))
* **analytics:** stamp app_version/app_git_sha on GA4 events ([1fe1b62](https://github.com/konradciok/ceramics-drop/commit/1fe1b621d0fa816d31859800894ac3095d0ec83b))
* **auth:** update customer accounts runbook and implementation plan with Google sign-in status; configure Supabase for production ([881819d](https://github.com/konradciok/ceramics-drop/commit/881819dc6a647976dfb9be262dbd304e0548f145))
* **gtm:** add ACC - Consent Update trigger to the two base tags ([009f4bf](https://github.com/konradciok/ceramics-drop/commit/009f4bfd042dfab083d87e14b3e5a9f6d89b9ef5))
* **marketing:** fire a GA4 refund event to correct revenue on a full refund ([4ef2d3f](https://github.com/konradciok/ceramics-drop/commit/4ef2d3f84ea61322fc8ff5d2f87f2ff5b9eb6e59))


### Bug Fixes

* **analytics:** re-fire GA4/Meta/Clarity when consent is granted mid-session ([b6ab006](https://github.com/konradciok/ceramics-drop/commit/b6ab00615dcb3c9a21f6adec05a74534c4eafcab))
* **analytics:** redact private-sale and CMS preview tokens from dataLayer URLs ([be09db4](https://github.com/konradciok/ceramics-drop/commit/be09db4550aee40cada022588c0d3144813cae0a))
* **analytics:** send real currency on cart-page remove_from_cart ([#203](https://github.com/konradciok/ceramics-drop/issues/203)) ([f439967](https://github.com/konradciok/ceramics-drop/commit/f43996747288e879c1341a7177eac7f6fc2bd02e))
* **checkout:** stop persisting ad identifiers in orders.marketing when consent is denied ([d0d7b64](https://github.com/konradciok/ceramics-drop/commit/d0d7b64312bcc9cf74f37d9b7594ed3bdf6c03e0))
* **consent:** push consent_update directly, drop the analytics.ts coupling ([2e699f2](https://github.com/konradciok/ceramics-drop/commit/2e699f2ed847cda4d123f744153bbd16302becd1))
* **consent:** push consent_update event so GTM can re-fire blocked tags ([c8344b6](https://github.com/konradciok/ceramics-drop/commit/c8344b6b734aa602ef385e2f726bb4f5aa89dd07))
* **marketing:** bound Meta CAPI and GA4 MP requests with an 8s timeout ([bad7a95](https://github.com/konradciok/ceramics-drop/commit/bad7a9595eb517526870e6734d1012d442825287))
* **marketing:** server-side conversions reliability (F-05, F-06, F-08) ([6b37289](https://github.com/konradciok/ceramics-drop/commit/6b37289356a6d19178d63ad2f93435c8057df31d))
* **privacy:** consent &amp; PII hygiene — redact capability tokens, drop ad ids on denied consent (F-24, F-10) ([04a83f4](https://github.com/konradciok/ceramics-drop/commit/04a83f4899159cf12416a975c7641b11245339c8))
* **test:** complete the pricing mock in checkout route.test.ts ([2a0dbd7](https://github.com/konradciok/ceramics-drop/commit/2a0dbd7e67136eaa00d244fe12e9707a36d156fd))
* **webhook:** alert via Sentry when a succeeded payment lands on a dead order ([7b98a09](https://github.com/konradciok/ceramics-drop/commit/7b98a096e4f311c34e5bd24551b1a7d692860c61))
* **webhook:** alert via Sentry when the conversions order lookup fails ([64cd17a](https://github.com/konradciok/ceramics-drop/commit/64cd17a46b385112bb792ff304aa3fbe6a4af843))
* **webhook:** claim conversions_sent_at so a redelivery can't double-send a purchase conversion ([167256d](https://github.com/konradciok/ceramics-drop/commit/167256d353c5ae62757dea1b8ca67c4f7ee29ed2))
* **webhook:** payment_intent.payment_failed no longer releases the reservation hold ([603370c](https://github.com/konradciok/ceramics-drop/commit/603370cef03ee98e378edc7b89a972c4c4749938))


### Performance Improvements

* **webhook:** defer the conversion sends to ctx.waitUntil ([5d9bd1d](https://github.com/konradciok/ceramics-drop/commit/5d9bd1dffe83d9c029052681aa1c62b080f67904))

## [0.10.0](https://github.com/konradciok/ceramics-drop/compare/v0.9.2...v0.10.0) (2026-07-25)


### Features

* **account:** customer accounts — Google/Apple sign-in, order history, tracking (executes PR [#178](https://github.com/konradciok/ceramics-drop/issues/178) plan) ([35ef0f6](https://github.com/konradciok/ceramics-drop/commit/35ef0f6222eac2d6032cab721121e97e7a512f60))
* **account:** navigation entry, e2e coverage, runbook ([52e9f8e](https://github.com/konradciok/ceramics-drop/commit/52e9f8e5638ba40e78e74e44182a45fe2d7a4183))
* **account:** order history and tracking pages ([212bfc4](https://github.com/konradciok/ceramics-drop/commit/212bfc49da57f5284f41320e5d8f6f454454df15))
* **auth:** supabase auth core behind fail-closed env gate ([e69bcd9](https://github.com/konradciok/ceramics-drop/commit/e69bcd9378382d9e3719bdf27e1dfcf5ee852cc9))
* **db:** link orders to auth users and persist prodigi tracking ([c7936dc](https://github.com/konradciok/ceramics-drop/commit/c7936dccab8ded98e54f3aac1771c6f2f4054c21))
* newsletter signup with Resend double opt-in ([ffd399c](https://github.com/konradciok/ceramics-drop/commit/ffd399c2ce7f6e0a060b6bb88a89e2724d44687f))
* newsletter signup with Resend double opt-in ([bfaa4b0](https://github.com/konradciok/ceramics-drop/commit/bfaa4b0efa52505feaaeffc527f9057b0b61af25))
* **prints:** print composition engine — geometry, config parser, sharp compose-master ([bf82b27](https://github.com/konradciok/ceramics-drop/commit/bf82b27220757b3ba1c4fb54bb4707de4004655e))
* **prints:** sharp compose-master module; integer-px contract in composeLayout ([18c4e16](https://github.com/konradciok/ceramics-drop/commit/18c4e16192b939443b58c53363902edd4c5e54e9))


### Bug Fixes

* **account:** address PR [#186](https://github.com/konradciok/ceramics-drop/issues/186) review — indexable backfill, safe migration casts, variant guards ([ea57ea5](https://github.com/konradciok/ceramics-drop/commit/ea57ea5e66c2d73e0416296738fa30a7ca5bf026))
* **account:** owner review — bounded pre-reservation auth resolve, monotonic tracking, locale-aware sign-out ([4fbcb39](https://github.com/konradciok/ceramics-drop/commit/4fbcb3931a9b2e5217b64d22364ae8f456ab5b8d))
* **db:** restrict link_orders_to_user execute to service_role ([8bf1df5](https://github.com/konradciok/ceramics-drop/commit/8bf1df5655fdd6378a45739c85b856c5cc4533cc))
* **e2e:** wait for streamed collection grid in checkout-409 stock probe ([4c0d8f1](https://github.com/konradciok/ceramics-drop/commit/4c0d8f13cb11c6af5edd314941d70cedc5970a24))
* **prints:** address PR [#182](https://github.com/konradciok/ceramics-drop/issues/182) review — signature tracks Y offset, validated config, doc sync ([b934f00](https://github.com/konradciok/ceramics-drop/commit/b934f006b56df148bb880d69f77aab6668dfe07e))
* scope e2e contact fill to checkout root; guard newsletter token decode ([78b4327](https://github.com/konradciok/ceramics-drop/commit/78b432786239324c981bb491eef247bb48ca2d0b))

## [0.9.2](https://github.com/konradciok/ceramics-drop/compare/v0.9.1...v0.9.2) (2026-07-23)


### Bug Fixes

* **checkout:** trim return-page bundle and announce print form errors ([c5bee66](https://github.com/konradciok/ceramics-drop/commit/c5bee66b9d79d9aa4f501ba461b97d15c8d15dcd))
* **print-assets:** enforce strict operator arguments and tracked source ([75dc316](https://github.com/konradciok/ceramics-drop/commit/75dc316ba26678b1e221798f8f04a58843358ec8))
* **print-assets:** rasterise signatures at bounded contain scale ([8d73f27](https://github.com/konradciok/ceramics-drop/commit/8d73f2707e94ded916bc6007fbbe2f385b276fdd))
* **print-assets:** reject bare --env-file with a clean error ([59a6d61](https://github.com/konradciok/ceramics-drop/commit/59a6d6121a0f5463970418377e409770d9a6c78e))
* **print-assets:** validate manifest v2 before external access ([ed9034b](https://github.com/konradciok/ceramics-drop/commit/ed9034b2b13c3a1f41abeb16d6fe2878b55b9dd9))
* **print-assets:** create fulfilment objects with conditional R2 puts ([4a67c57](https://github.com/konradciok/ceramics-drop/commit/4a67c576a01c2a83e64a34a9e0907e515fa12f7a))
* **print-assets:** classify sandbox outcomes and use unique run ids ([6078f03](https://github.com/konradciok/ceramics-drop/commit/6078f0319b49092cec053cb8f6abbff4e5d98428))
* **print-assets:** verify gallery source bytes and null ordering ([6f94981](https://github.com/konradciok/ceramics-drop/commit/6f94981c9a4fde612c3be09fee6cdfa89459e1df))
* **print-assets:** promote verified assets transactionally ([1a10e56](https://github.com/konradciok/ceramics-drop/commit/1a10e56af196a4166df85b51e5d7f52cd3715e8b))
* **print-assets:** redact signed-URL sig values in sandbox issue output ([cf340a6](https://github.com/konradciok/ceramics-drop/commit/cf340a680c3abd7a578826ffcc5884d58b05f847))
* **print-assets:** redact any sig value shape and scope the rollback guarantee ([47943e6](https://github.com/konradciok/ceramics-drop/commit/47943e62a1d0131915be51ceae8afcb304d665a7))

## [0.9.1](https://github.com/konradciok/ceramics-drop/compare/v0.9.0...v0.9.1) (2026-07-18)


### Bug Fixes

* **checkout:** report missing PMC secret to Sentry and cover the fail-closed branch ([c9790f9](https://github.com/konradciok/ceramics-drop/commit/c9790f915df5f80156fdb932b71548b53a97461a))

## [0.9.0](https://github.com/konradciok/ceramics-drop/compare/v0.8.0...v0.9.0) (2026-07-18)


### Features

* **checkout:** collapse the InPost map behind an explicit locker choice ([9f8798f](https://github.com/konradciok/ceramics-drop/commit/9f8798f5c3b05729d2491d044ee09938bb2af636))
* **checkout:** collapse the InPost map behind an explicit locker choice ([5ae1714](https://github.com/konradciok/ceramics-drop/commit/5ae171412e79a3b1a90f5fd6ec454a6ede65f6f3))


### Bug Fixes

* **a11y:** name tile/cart links, open lightbox from keyboard, translate lang label ([5cbd185](https://github.com/konradciok/ceramics-drop/commit/5cbd1850c2449214da341f2df58fa30083b9e246))
* **a11y:** name tile/cart links, open lightbox from keyboard, translate lang label ([f52de51](https://github.com/konradciok/ceramics-drop/commit/f52de51bcd8476cf030859f0b37fd64da88e1e8f))
* **home:** derive card prices/counts from the registry, evergreen delivery notice ([1f51474](https://github.com/konradciok/ceramics-drop/commit/1f51474b30cadb162db8d024ffb7b482019a989c))
* **responsive:** fit status filter on phones, uncrowd 561-860px header, icon-only tile CTA ([7aa9c0c](https://github.com/konradciok/ceramics-drop/commit/7aa9c0c732ba0574d5b910f4d9509170755abb67))
* **responsive:** fit status filter on phones, uncrowd 561-860px header, icon-only tile CTA ([15c49e5](https://github.com/konradciok/ceramics-drop/commit/15c49e59484a7a91050e02a71135fe2aebab907b))
* **storefront:** size button icons and gate cart UI on hydration ([5932d60](https://github.com/konradciok/ceramics-drop/commit/5932d60013089b1ced9ffff37ccbb41a44b38105))

## [0.8.0](https://github.com/konradciok/ceramics-drop/compare/v0.7.1...v0.8.0) (2026-07-18)


### Features

* add print checkout address management ([#157](https://github.com/konradciok/ceramics-drop/issues/157)) ([19f4abb](https://github.com/konradciok/ceramics-drop/commit/19f4abb95ea239275c026ac44fdbe99459f02152))
* **print-assets:** add proportional layout placement math ([2870c9a](https://github.com/konradciok/ceramics-drop/commit/2870c9a396e976f33b7ae2aba72bca8ab09050d4))
* **print-assets:** add proportional print composition ([c63678a](https://github.com/konradciok/ceramics-drop/commit/c63678a5702bbf0bf811b957381f3cd58b0a979e))
* **print-assets:** composition config + additive manifest layout ([aeefaa1](https://github.com/konradciok/ceramics-drop/commit/aeefaa10ebc25ecc8aea3e3a2b27789b3d655d44))
* **print-assets:** rewire prepare CLI to proportional composition ([37237d0](https://github.com/konradciok/ceramics-drop/commit/37237d02814bddb1cf5ee72baae87f54c74f9947))
* **print-assets:** rewrite derivative generation as layer composition ([c98da95](https://github.com/konradciok/ceramics-drop/commit/c98da95264c61353f6d8c79f8aee54c5b519ef50))


### Bug Fixes

* **print-assets:** address review feedback ([ed2ad5d](https://github.com/konradciok/ceramics-drop/commit/ed2ad5d4a349294654fbadf9b37bed0e4d9b9c88))
* **print-assets:** harden proportional composition proof ([e624804](https://github.com/konradciok/ceramics-drop/commit/e62480482b478ddbd03cd3b50db93c7f89393c66))
* **print-assets:** harden status activation RPC ([9b7822a](https://github.com/konradciok/ceramics-drop/commit/9b7822aee31e50d98b486e0debfd428487e715a9))

## [0.7.1](https://github.com/konradciok/ceramics-drop/compare/v0.7.0...v0.7.1) (2026-07-16)


### Bug Fixes

* **env:** correct FULFILMENT_DEBUG_TOKEN spelling in .env.example ([38ff7f5](https://github.com/konradciok/ceramics-drop/commit/38ff7f58481f4387ac0c4040a04d72ecb0ea8ae7))
