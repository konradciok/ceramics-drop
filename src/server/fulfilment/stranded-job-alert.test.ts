import { describe, it, expect } from 'vitest';
import { buildStrandedJobAlert, STRANDED_STATUSES, type StrandedJobInput } from './stranded-job-alert';

function job(overrides: Partial<StrandedJobInput> = {}): StrandedJobInput {
  return {
    id: 'job-1',
    orderId: 'ord-1',
    status: 'queued',
    attempts: 0,
    createdAt: '2026-08-13T08:00:00.000Z',
    ...overrides,
  };
}

describe('buildStrandedJobAlert', () => {
  it('exposes exactly the pre-submission stuck statuses (never fulfilment_submitted/in_production)', () => {
    expect([...STRANDED_STATUSES]).toEqual(['queued', 'fulfilment_submitting', 'failed_retryable']);
    expect(STRANDED_STATUSES).not.toContain('fulfilment_submitted');
    expect(STRANDED_STATUSES).not.toContain('in_production');
  });

  it('builds a warning-level Sentry payload + log with per-job status/attempts/createdAt', () => {
    const alert = buildStrandedJobAlert([
      job({ id: 'j1', status: 'failed_retryable', attempts: 3 }),
      job({ id: 'j2', status: 'queued' }),
    ]);
    expect(alert.sentry.level).toBe('warning');
    expect(alert.sentry.message).toBe('fulfilment_job_stranded');
    expect(alert.log.event).toBe('fulfilment_job_stranded');
    expect(alert.log.count).toBe(2);
    expect(alert.log.jobs[0]).toMatchObject({ id: 'j1', status: 'failed_retryable', attempts: 3 });
    expect(alert.email.subject).toContain('2');
  });

  it('escapes HTML in job fields (no injection into the studio email)', () => {
    const alert = buildStrandedJobAlert([job({ orderId: '<img src=x onerror=alert(1)>' })]);
    expect(alert.email.html).not.toContain('<img src=x');
    expect(alert.email.html).toContain('&lt;img src=x');
  });

  it('caps rendered sections at 10 and summarises the remainder', () => {
    const jobs = Array.from({ length: 13 }, (_, i) => job({ id: `j${i}`, orderId: `o${i}` }));
    const alert = buildStrandedJobAlert(jobs);
    expect(alert.log.count).toBe(13);
    expect(alert.email.html).toContain('i 3 kolejnych'); // 13 - 10 shown
  });
});
