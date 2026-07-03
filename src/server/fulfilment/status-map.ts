const TERMINAL = new Set(['completed', 'shipped', 'cancelled', 'failed_action_required']);

/**
 * Map Prodigi status.stage → local fulfilment_jobs status.
 * Unknown stages return null (no-op) so an unrecognised callback can never
 * downgrade a job that already advanced.
 */
export function mapProdigiStage(stage: string): string | null {
  const map: Record<string, string> = {
    InProgress:    'fulfilment_submitted',
    InProduction:  'in_production',
    Complete:      'shipped',
    Cancelled:     'cancelled',
  };
  return map[stage] ?? null;
}

/** True when a terminal status must not be overwritten by a later callback. */
export function isTerminalStatus(status: string): boolean {
  return TERMINAL.has(status);
}
