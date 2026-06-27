const TERMINAL = new Set(['completed', 'cancelled', 'failed_action_required']);

/** Map Prodigi status.stage → local fulfilment_jobs status. */
export function mapProdigiStage(stage: string): string {
  const map: Record<string, string> = {
    InProgress:    'fulfilment_submitted',
    InProduction:  'in_production',
    Complete:      'shipped',
    Cancelled:     'cancelled',
  };
  return map[stage] ?? 'fulfilment_submitted';
}

/** True when a terminal status must not be overwritten by a later callback. */
export function isTerminalStatus(status: string): boolean {
  return TERMINAL.has(status);
}
