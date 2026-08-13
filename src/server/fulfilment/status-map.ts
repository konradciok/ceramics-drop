const TERMINAL = new Set(['completed', 'shipped', 'cancelled', 'failed_action_required']);

/**
 * Map Prodigi status.stage → local fulfilment_jobs status.
 * Unknown stages return null (no-op) so an unrecognised callback can never
 * downgrade a job that already advanced.
 *
 * §6.11 (settled 2026-08-13): Prodigi v4 has NO top-level `InProduction` stage
 * — the docs list InProgress / Complete / Cancelled only, and the Plan 05
 * rehearsal observed production progress solely under
 * `status.details.inProduction` while the top-level stage stayed `InProgress`.
 * The former `InProduction → 'in_production'` mapping was dead code and was
 * removed; a hypothetical future stage falls into the null branch safely.
 */
export function mapProdigiStage(stage: string): string | null {
  const map: Record<string, string> = {
    InProgress:    'fulfilment_submitted',
    Complete:      'shipped',
    Cancelled:     'cancelled',
  };
  return map[stage] ?? null;
}

/** True when a terminal status must not be overwritten by a later callback. */
export function isTerminalStatus(status: string): boolean {
  return TERMINAL.has(status);
}
