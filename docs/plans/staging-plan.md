# Profesjonalne Staging Dla `ceramics-drop`

## Podsumowanie

Wdrożyć stałe środowisko `staging` pod `https://staging.anna-ciok.studio`, działające jako osobny Cloudflare Worker `ceramics-drop-staging` przez `wrangler env staging`. Produkcja zostaje na `main` i `anna-ciok.studio`; staging ma osobne sandboxy/sekrety dla Stripe, Supabase, InPost, Prodigi, R2, Queue, Access, analytics i emaili.

Główna zasada: staging ma testować prawdziwy runtime i pełny checkout/fulfilment, ale bez pieniędzy, produkcyjnych zamówień, produkcyjnego inventory, PII i publicznej indeksacji.

## Kluczowe Zmiany

- Cloudflare:
  - Dodać `env.staging` w `wrangler.jsonc`; Cloudflare utworzy osobnego Workera `ceramics-drop-staging`.
  - Jawnie zdefiniować staging bindings, bo Workers bindings nie dziedziczą się między env:
    `WORKER_SELF_REFERENCE -> ceramics-drop-staging`, `prodigi-fulfilment-staging`, `prodigi-fulfilment-staging-dlq`, `anna-ciok-print-assets-staging`.
  - Dodać custom domain `staging.anna-ciok.studio`, zabezpieczony Cloudflare Access.
  - Rozszerzyć istniejący WAF checkout rate-limit tak, żeby obejmował też host staging, bez dokładania drugiej reguły.
  - Zostawić cron włączony na staging, żeby testować wygaszanie porzuconych zamówień na staging DB.

- Konfiguracja aplikacji:
  - Zastąpić hardcoded `SITE_URL = 'https://anna-ciok.studio'` zmienną `NEXT_PUBLIC_SITE_URL`, z produkcyjnym fallbackiem.
  - Dodać `NEXT_PUBLIC_APP_ENV=production|staging` i używać go do `robots`, `sitemap` oraz `X-Robots-Tag: noindex, nofollow` poza produkcją.
  - Wynieść `STRIPE_PMC_ID` z checkoutu do `STRIPE_PAYMENT_METHOD_CONFIGURATION_ID`, bo Stripe sandbox/test może mieć inny Payment Method Configuration.
  - Dodać tryb bezpieczeństwa emaili: poza produkcją wszystkie maile wychodzące idą do `STAGING_EMAIL_RECIPIENT`, z oryginalnym adresatem dopisanym w treści/metadanych.
  - Uzupełnić `CloudflareEnv`, `.env.example`, `docs/cloudflare-deployment.md` i typegen o nowe staging vars/secrets.

- Skrypty:
  - Dodać:
    - `build:cf:staging`: `opennextjs-cloudflare build --env staging`
    - `preview:cf:staging`: `opennextjs-cloudflare build --env staging && opennextjs-cloudflare preview --env staging`
    - `deploy:cf:staging`: `opennextjs-cloudflare build --env staging && opennextjs-cloudflare deploy --env staging`
  - Nie zmieniać produkcyjnego `npm run build`; `next build --webpack` musi zostać.

## Zasoby Zewnętrzne

- Supabase:
  - Utworzyć persistent branch `staging`, data-less, zgodnie z dokumentacją Supabase.
  - Zastosować wszystkie migracje.
  - Dodać seed stagingowy bez PII: `piece_state` dla aktualnego katalogu, wymagane dane `pod_variants`, minimalne fixture’y do testów.
  - Nie kopiować produkcyjnych `orders`, kontaktów ani marketing payloadów.

- Stripe:
  - Użyć Stripe Sandbox/test mode, osobnych `pk_test`, secret/restricted key, webhook endpointu i webhook signing secret.
  - Webhook: `https://staging.anna-ciok.studio/api/stripe/webhook`.
  - Endpoint API version dopasować do wersji SDK Stripe zainstalowanej w repo.
  - Utworzyć stagingowy `payment_method_configuration` i zapisać jego ID w `STRIPE_PAYMENT_METHOD_CONFIGURATION_ID`.

- InPost:
  - Użyć ShipX sandbox API i stagingowego Geowidget tokena.
  - Dozwolone referrery Geowidget muszą obejmować `staging.anna-ciok.studio`.
  - Webhook: `https://staging.anna-ciok.studio/api/inpost/webhook?token=<staging-token>`.

- Prodigi:
  - Użyć `PRODIGI_ENV=sandbox`.
  - Osobny callback token i endpoint `https://staging.anna-ciok.studio/api/webhooks/prodigi/<token>`.
  - Stagingowy R2 bucket ma zawierać tylko pliki potrzebne do testów printów.

- Analytics/Sentry:
  - Nie używać produkcyjnych GA4/Meta/GTM IDs na staging.
  - Preferowane: osobny GTM container lub puste ID; osobny GA4 stream; Meta tylko z `META_TEST_EVENT_CODE`.
  - Sentry ustawić z environment `staging`.

## CI/CD I Workflow

- Zostawić produkcyjne Cloudflare Workers Builds dla `main` bez zmiany.
- Dodać GitHub Actions workflow `deploy-staging.yml`:
  - trigger: push na branch `staging` oraz `workflow_dispatch`.
  - kroki: `npm ci`, `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run deploy:cf:staging`.
  - po deployu: `PLAYWRIGHT_BASE_URL=https://staging.anna-ciok.studio npm run test:e2e`.
  - użyć GitHub Environment `staging` z osobnymi vars/secrets i ochroną przed przypadkowym deployem.
- Proces release:
  - feature PR -> `staging`
  - automatyczny deploy staging + testy
  - ręczna walidacja checkoutu sandboxowego
  - PR/merge `staging` -> `main`
  - produkcyjne Cloudflare Builds deployują `main`.

## Test Plan

- Lokalnie przed deployem:
  - `npm run lint`
  - `npx tsc --noEmit`
  - `npm test`
  - `npm run build`
  - `npm run preview:cf:staging`

- Po deployu staging:
  - Sprawdzić `/`, `/en`, `/es`, `/de`, `/sklep`, `/fine-art-prints`, PDP ceramiki i PDP printu.
  - Sprawdzić, że staging zwraca `X-Robots-Tag: noindex, nofollow`.
  - Sprawdzić `robots.txt` i `sitemap.xml`, żeby staging nie publikował produkcyjnej mapy indeksacji.
  - Uruchomić `PLAYWRIGHT_BASE_URL=https://staging.anna-ciok.studio npm run test:e2e`.
  - Wykonać sandbox checkout ceramiki: PaymentIntent, webhook, `orders.status=paid`, `piece_state=sold`, email redirect, InPost sandbox shipment.
  - Wykonać sandbox checkout printu: webhook, queue job, Prodigi sandbox order, callback update.
  - Sprawdzić mixed cart block.
  - Sprawdzić `/admin` bez Access JWT zwraca ukrycie/odmowę, a z Access działa.
  - Sprawdzić cron wygaszania porzuconego staging orderu.
  - Sprawdzić Workers Logs, Stripe webhook deliveries, Queue DLQ i Supabase staging rows.

## Assumptions

- Staging hostname: `staging.anna-ciok.studio`.
- Staging jest chroniony Cloudflare Access, ale nadal ma `noindex` jako drugi bezpiecznik.
- Supabase persistent branches są dostępne na obecnym planie; jeśli nie, fallbackiem jest osobny Supabase project seeded tym samym skryptem.
- Nie kopiujemy produkcyjnych danych klientów do staging.
- PR preview/Cloudflare Preview URLs zostają poza głównym stagingiem; można je dodać później tylko do UI smoke-testów.

Źródła praktyk: [Cloudflare Workers environments](https://developers.cloudflare.com/workers/wrangler/environments/), [Wrangler configuration inheritance](https://developers.cloudflare.com/workers/wrangler/configuration/), [Cloudflare secrets](https://developers.cloudflare.com/workers/configuration/secrets/), [Workers Build branches](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/), [Supabase branching](https://supabase.com/docs/guides/deployment/branching), [Stripe sandboxes](https://docs.stripe.com/sandboxes), [Stripe keys/webhook secrets](https://docs.stripe.com/keys), [Prodigi environments](https://www.prodigi.com/print-api/docs/reference/).
