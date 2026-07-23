# Changelog

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
