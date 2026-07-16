import { describe, it, expect } from 'vitest';
import { buildFailedActionAlert, type FailedActionJobInput } from './failed-action-alert';

function job(overrides: Partial<FailedActionJobInput> = {}): FailedActionJobInput {
  return {
    id: 'job-1',
    orderId: 'ord-1',
    attempts: 2,
    lastError: 'order not paid',
    updatedAt: '2026-07-15T12:00:00Z',
    ...overrides,
  };
}

describe('buildFailedActionAlert', () => {
  it('builds log + sentry + email for a representative job', () => {
    const alert = buildFailedActionAlert([job()]);

    expect(alert.log.event).toBe('fulfilment_failed_action_required');
    expect(alert.log.count).toBe(1);
    expect(alert.log.jobs[0]).toMatchObject({
      id: 'job-1',
      orderId: 'ord-1',
      attempts: 2,
      lastErrorSnippet: 'order not paid',
    });

    expect(alert.sentry.message).toBe('fulfilment_failed_action_required');
    expect(alert.sentry.level).toBe('error');
    expect(alert.sentry.extra.count).toBe(1);
    expect(alert.sentry.extra.jobs[0].orderId).toBe('ord-1');

    expect(alert.email.subject).toContain('1');
    expect(alert.email.subject).toContain('failed_action_required');
    expect(alert.email.html).toContain('<!DOCTYPE html>');
    expect(alert.email.html).toContain('job-1');
    expect(alert.email.html).toContain('ord-1');
    expect(alert.email.html).toContain('order not paid');
  });

  it('reports the count across multiple jobs', () => {
    const alert = buildFailedActionAlert([
      job({ id: 'a', orderId: 'oa' }),
      job({ id: 'b', orderId: 'ob' }),
      job({ id: 'c', orderId: 'oc' }),
    ]);
    expect(alert.log.count).toBe(3);
    expect(alert.sentry.extra.count).toBe(3);
    expect(alert.email.subject).toContain('3');
    for (const id of ['a', 'b', 'c']) expect(alert.email.html).toContain(id);
    expect(alert.email.html).not.toContain('kolejnych');
  });

  it('substitutes an em-dash when lastError is null', () => {
    const alert = buildFailedActionAlert([job({ lastError: null })]);
    expect(alert.log.jobs[0].lastErrorSnippet).toBe('—');
    expect(alert.email.html).toContain('—');
  });

  it('truncates a last_error longer than the cap', () => {
    const longErr = 'x'.repeat(500);
    const alert = buildFailedActionAlert([job({ lastError: longErr })]);
    expect(alert.log.jobs[0].lastErrorSnippet.length).toBeLessThanOrEqual(301); // 300 + ellipsis
    expect(alert.log.jobs[0].lastErrorSnippet.endsWith('…')).toBe(true);
  });

  it('escapes HTML in last_error so it cannot inject email markup', () => {
    const alert = buildFailedActionAlert([job({ lastError: '<script>alert(1)</script>' })]);
    expect(alert.email.html).not.toContain('<script>');
    expect(alert.email.html).toContain('&lt;script&gt;');
  });

  it('caps rendered sections and notes the remainder', () => {
    const jobs = Array.from({ length: 25 }, (_, i) =>
      job({ id: `job-${i}`, orderId: `ord-${i}` }),
    );
    const alert = buildFailedActionAlert(jobs);
    expect(alert.email.html).toContain('job-0');
    expect(alert.email.html).toContain('job-9');
    expect(alert.email.html).not.toContain('job-10');
    expect(alert.email.html).toContain('15 kolejnych');
    // count in log/sentry still reflects the true total
    expect(alert.log.count).toBe(25);
    expect(alert.sentry.extra.jobs).toHaveLength(25);
  });

  it('handles an empty list defensively (sweep never calls it with 0)', () => {
    const alert = buildFailedActionAlert([]);
    expect(alert.log.count).toBe(0);
    expect(alert.email.subject).toContain('0');
    expect(alert.email.html).toContain('<!DOCTYPE html>');
  });
});
