/**
 * `PrintAssetProcessor` — the Durable Object that owns the Cloudflare Container
 * running Node + Sharp (Priority 8 / Phase 3; master plan
 * cms-ceramics/docs/plans/2026-09-09-cms-v1.md §S3: "osobny procesor Node/Sharp
 * w Cloudflare Containers … jedna instancja `standard-3`, jedno zadanie naraz,
 * profile przetwarzane kolejno; kontener usypiany po bezczynności").
 *
 * ⚠️  This file imports `cloudflare:workers` and is therefore excluded from the
 * app tsconfig (see tsconfig.json's "exclude", same treatment as
 * src/server/cms-api/entrypoint.ts). It is type-checked by tsconfig.worker.json
 * via worker.ts's re-export, and is deliberately kept as thin as possible:
 * every decision lives in container-render.ts / container-protocol.ts, which
 * ARE unit-tested.
 *
 * ── Why hand-rolled instead of `@cloudflare/containers` ──────────────────────
 * Cloudflare's `@cloudflare/containers` package (the `Container` base class with
 * `defaultPort` / `sleepAfter`) is a convenience wrapper over exactly the
 * runtime API used below: `ctx.container.start()`, `.setInactivityTimeout()`,
 * `.getTcpPort(port).fetch()`. That runtime API is already fully typed by the
 * `@cloudflare/workers-types` version this repo pins (DurableObjectState.container),
 * so using it directly adds no new dependency, no lockfile churn, and nothing
 * that has to be installed for `tsc`/vitest to pass in an environment without a
 * working registry. The trade-off is disclosed in the task report: the wrapper
 * also carries battle-tested retry/lifecycle behaviour that is reimplemented
 * here in ~40 lines and has never been exercised against a real container.
 *
 * ── Why the R2 I/O happens HERE and not inside the container ─────────────────
 * A container has no Workers bindings of its own; only Worker/DO code does. The
 * plan's "pulls the job's R2 object via a bound R2Bucket" is satisfied by this
 * class reading `env.PRINT_ASSETS` and streaming the bytes across the container
 * boundary, so the container image needs no R2 credentials, no network egress
 * (`enableInternet: false`) and no AWS SDK. The alternative — giving the
 * container S3 credentials and letting it talk to R2 itself — is noted in the
 * report as the road not taken.
 */

import { DurableObject } from 'cloudflare:workers';
import { CONTAINER_ORIGIN, CONTAINER_PORT, HEALTH_PATH } from './container-protocol';
import { renderAndStoreDerivative, type RenderInput, type RenderResult } from './container-render';

export { PRINT_ASSET_PROCESSOR_NAME } from './container-names';

/** Idle sleep (plan: "kontener usypiany po bezczynności"). */
const SLEEP_AFTER_MS = 10 * 60 * 1000;

/** Container boot + listen budget. Cold start pulls the image and starts Node. */
const READY_TIMEOUT_MS = 90_000;
const READY_POLL_MS = 500;

export class PrintAssetProcessor extends DurableObject<CloudflareEnv> {
  /**
   * Serialises work through this DO. RPC methods are NOT automatically
   * serialised across `await` points, and the plan requires one job at a time
   * on a single-instance container — so every call queues behind the previous
   * one. Rejections are swallowed on the chain itself so one failure cannot
   * poison every later call.
   */
  private queue: Promise<unknown> = Promise.resolve();

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn, fn);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Render one derivative profile: R2 → container → R2. Returns a plain
   * structured-cloneable `RenderResult`; it never throws for an expected
   * failure, so the queue consumer can classify the outcome itself.
   */
  async renderDerivative(input: RenderInput): Promise<RenderResult> {
    return this.runExclusive(async () => {
      const port = await this.ensureContainerReady();
      if (port.kind === 'error') return port.result;
      return renderAndStoreDerivative(
        {
          bucket: this.env.PRINT_ASSETS,
          containerFetch: (url, init) => port.fetcher.fetch(url, init as unknown as RequestInit),
        },
        input,
      );
    });
  }

  private async ensureContainerReady(): Promise<{ kind: 'ok'; fetcher: Fetcher } | { kind: 'error'; result: RenderResult }> {
    const container = this.ctx.container;
    if (!container) {
      // Config fault (no `containers` entry for this class, or a local dev run
      // without container support) — an operator must fix the deployment, so
      // this is terminal rather than an unbounded retry loop.
      return {
        kind: 'error',
        result: {
          kind: 'permanent',
          code: 'CONTAINER_NOT_CONFIGURED',
          message: 'no container is attached to PrintAssetProcessor — check wrangler.jsonc `containers`',
        },
      };
    }

    if (!container.running) {
      container.start({ enableInternet: false });
    }
    // Re-armed on every call: the timeout is what puts the container back to
    // sleep after the last job, and re-arming is cheap and idempotent.
    await container.setInactivityTimeout(SLEEP_AFTER_MS);

    const fetcher = container.getTcpPort(CONTAINER_PORT);
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let lastError = 'no attempt made';
    while (Date.now() < deadline) {
      try {
        const response = await fetcher.fetch(`${CONTAINER_ORIGIN}${HEALTH_PATH}`);
        if (response.ok) {
          await response.body?.cancel();
          return { kind: 'ok', fetcher };
        }
        lastError = `health returned ${response.status}`;
        await response.body?.cancel();
      } catch (e) {
        lastError = String(e);
      }
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
    }
    return {
      kind: 'error',
      result: {
        kind: 'retryable',
        code: 'CONTAINER_NOT_READY',
        message: `container did not become ready within ${READY_TIMEOUT_MS}ms: ${lastError}`,
      },
    };
  }
}
