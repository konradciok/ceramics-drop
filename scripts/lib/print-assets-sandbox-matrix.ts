/**
 * Side-effect-free helpers for the sandbox-matrix CLI: arg parsing, a
 * UUID-suffixed default run id (so replays don't collide as `AlreadyExists`),
 * and Prodigi create-order outcome classification. Prodigi's outcome table
 * uses lower camel case (`created`, `onHold`, `alreadyExists`,
 * `createdWithIssues`) while some response examples and the repository type
 * use initial capitals, so classification is case-insensitive.
 */
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { parseEnvFileOption } from './print-assets-cli';

const PRODIGI_FETCH_TIMEOUT_MS = 15_000;

export function parseSandboxArgs(argv: string[]): {
  product: string;
  runId: string | undefined;
  dryRun: boolean;
  help: boolean;
} {
  parseEnvFileOption(argv);
  const { values } = parseArgs({
    args: argv,
    options: {
      product: { type: 'string' },
      'run-id': { type: 'string' },
      'dry-run': { type: 'boolean' },
      'env-file': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
    allowPositionals: false,
    allowNegative: false,
  });
  const product = values.product ?? 'fap01';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(product)) throw new Error('Invalid --product');
  if (values['run-id'] !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(values['run-id'])) {
    throw new Error('Invalid --run-id');
  }
  return {
    product,
    runId: values['run-id'],
    dryRun: values['dry-run'] === true,
    help: values.help === true,
  };
}

export function defaultRunId(date = new Date(), uuid: () => string = randomUUID): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 10)}-${iso.slice(11, 23).replace(/[:.]/g, '')}-${uuid()}`;
}

export function classifyCreateOutcome(body: unknown): 'success' | 'duplicate' | 'failure' {
  const outcome = (body as { outcome?: unknown } | null)?.outcome;
  if (typeof outcome !== 'string') {
    throw new Error(`Unexpected Prodigi outcome: ${JSON.stringify(outcome)}`);
  }
  const normalized = outcome.toLowerCase();
  if (normalized === 'created' || normalized === 'onhold') return 'success';
  if (normalized === 'alreadyexists') return 'duplicate';
  if (normalized === 'createdwithissues') return 'failure';
  throw new Error(`Unexpected Prodigi outcome: ${JSON.stringify(outcome)}`);
}

/**
 * Redact the `sig` query value in any string, recursively. Prodigi's
 * asset-download issues (`items.assets.NotDownloaded` — the exact failure this
 * matrix exists to surface) echo the failing asset URL back in the issue
 * description, and a still-valid 7-day signed URL must never land in operator
 * output or the evidence JSON attached to a PR.
 */
function redactSignedUrls(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/([?&]sig=)[^&#\s"'<>]*/gi, '$1[redacted]');
  if (Array.isArray(value)) return value.map(redactSignedUrls);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) out[key] = redactSignedUrls(child);
    return out;
  }
  return value;
}

export function summarizeCreateResponse(body: unknown): {
  outcome: string | null;
  orderId: string | null;
  stage: string | null;
  issues: unknown[];
} {
  const root = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
  const order = typeof root.order === 'object' && root.order !== null
    ? root.order as Record<string, unknown>
    : {};
  const status = typeof order.status === 'object' && order.status !== null
    ? order.status as Record<string, unknown>
    : {};
  return {
    outcome: typeof root.outcome === 'string' ? root.outcome : null,
    orderId: typeof order.id === 'string' ? order.id : null,
    stage: typeof status.stage === 'string' ? status.stage : null,
    issues: Array.isArray(status.issues) ? (redactSignedUrls(status.issues) as unknown[]) : [],
  };
}

export async function postSandboxOrder(input: {
  apiKey: string;
  payload: unknown;
  fetchImpl?: typeof fetch;
}): Promise<{
  summary: ReturnType<typeof summarizeCreateResponse>;
  classification: 'success' | 'duplicate' | 'failure';
}> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl('https://api.sandbox.prodigi.com/v4.0/orders', {
    method: 'POST',
    headers: { 'X-API-Key': input.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(input.payload),
    signal: AbortSignal.timeout(PRODIGI_FETCH_TIMEOUT_MS),
  });
  const body = await response.json().catch(() => null);
  const summary = summarizeCreateResponse(body);
  if (!response.ok) {
    throw new Error(`Prodigi order failed (${response.status}): ${JSON.stringify(summary)}`);
  }
  return { summary, classification: classifyCreateOutcome(body) };
}
