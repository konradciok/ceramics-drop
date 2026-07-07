// Minimal Cloudflare Workers handler types for worker.ts.
// cf-typegen writes env bindings to cloudflare-env.d.ts with --include-runtime=false
// so Next.js server code stays free of full Workers globals; worker.ts needs these
// when wrangler generates worker-configuration.d.ts (typeof import("./worker")).

interface QueueRetryOptions {
  delaySeconds?: number;
}

interface ScheduledController {
  readonly scheduledTime: number;
  readonly cron: string;
  noRetry(): void;
}

interface Message<Body = unknown> {
  readonly id: string;
  readonly timestamp: Date;
  readonly body: Body;
  readonly attempts: number;
  ack(): void;
  retry(options?: QueueRetryOptions): void;
}

interface MessageBatch<Body = unknown> {
  readonly queue: string;
  readonly messages: readonly Message<Body>[];
  retryAll(options?: QueueRetryOptions): void;
  ackAll(): void;
}

type ExportedHandlerFetchHandler<Env = unknown> = (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
) => Response | Promise<Response>;

type ExportedHandlerQueueHandler<Env = unknown, Body = unknown> = (
  batch: MessageBatch<Body>,
  env: Env,
  ctx: ExecutionContext,
) => void | Promise<void>;

type ExportedHandlerScheduledHandler<Env = unknown> = (
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
) => void | Promise<void>;

interface ExportedHandler<Env = unknown, QueueHandlerMessage = unknown> {
  fetch?: ExportedHandlerFetchHandler<Env>;
  queue?: ExportedHandlerQueueHandler<Env, QueueHandlerMessage>;
  scheduled?: ExportedHandlerScheduledHandler<Env>;
}
