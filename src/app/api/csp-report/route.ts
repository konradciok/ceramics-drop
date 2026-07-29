import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const MAX_REPORT_BYTES = 4_000;

/** Drop the query string / fragment from a report URI so a capability token in a
 *  document-uri / referrer / blocked-uri never reaches the logs. */
function redactUri(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  return value.split(/[?#]/)[0]; // keep origin + path; drop ?query and #fragment
}

/**
 * CSP violation-report sink (report-only phase). Browsers POST either the legacy
 * `application/csp-report` body or the modern `application/reports+json` batch.
 * We log only a bounded, structured line (never the raw body) so violations are
 * observable in Workers logs before enforcing; no storage, no PII.
 */
export async function POST(req: Request) {
  try {
    // (a) Bound memory BEFORE buffering: a CSP report always carries a
    // Content-Length. Reject a missing/unparseable/over-limit length outright so
    // a hostile client can't stream an unbounded body — we only read a body we
    // already know is <= MAX_REPORT_BYTES.
    // ponytail: reports without Content-Length are dropped; browsers always send
    // it for CSP POSTs. Add a streamed byte-cap only if a real client omits it.
    const declared = Number(req.headers.get('content-length'));
    if (!Number.isFinite(declared) || declared <= 0 || declared > MAX_REPORT_BYTES) {
      return new NextResponse(null, { status: 204 });
    }
    const raw = (await req.text()).slice(0, MAX_REPORT_BYTES);
    // (b) Parse only the fields we log and redact their query strings — never
    // console.log the raw body. Handle both report shapes.
    const parsed = JSON.parse(raw) as unknown;
    const reports = Array.isArray(parsed)
      ? parsed.map((r) => (r as { body?: Record<string, unknown> }).body ?? {})
      : [(parsed as { 'csp-report'?: Record<string, unknown> })?.['csp-report'] ?? {}];
    for (const r of reports) {
      console.log(JSON.stringify({
        event: 'csp_report',
        'document-uri': redactUri(r['document-uri'] ?? r['documentURL']),
        referrer: redactUri(r['referrer']),
        'blocked-uri': redactUri(r['blocked-uri'] ?? r['blockedURL']),
        'violated-directive': r['violated-directive'] ?? r['effectiveDirective'] ?? null,
      }));
    }
  } catch {
    // never throw — a malformed/oversized report must still 204
  }
  return new NextResponse(null, { status: 204 });
}
