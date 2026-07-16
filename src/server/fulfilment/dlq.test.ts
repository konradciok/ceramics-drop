import { describe, it, expect } from 'vitest';
import {
  buildDlqAlert,
  buildDlqBatchAlertEmail,
  DLQ_QUEUE_NAME,
} from './dlq';

describe('buildDlqAlert', () => {
  it('reads orderId/jobId from a well-formed FulfilmentJobMessage body', () => {
    const alert = buildDlqAlert({
      id: 'msg-1',
      body: { orderId: 'ord-123', jobId: 'job-456' },
      attempts: 10,
    });
    expect(alert.log.orderId).toBe('ord-123');
    expect(alert.log.jobId).toBe('job-456');
    expect(alert.log.attempts).toBe(10);
    expect(alert.log.queue).toBe(DLQ_QUEUE_NAME);
    expect(alert.log.event).toBe('prodigi_dlq_message');
    expect(alert.log.messageId).toBe('msg-1');
    // snippet is the JSON-serialised body
    expect(alert.log.bodySnippet).toBe('{"orderId":"ord-123","jobId":"job-456"}');
    expect(alert.sentry.message).toBe('prodigi_dlq_poison_message');
    expect(alert.sentry.level).toBe('error');
    expect(alert.sentry.extra.orderId).toBe('ord-123');
  });

  it('nulls orderId/jobId when the body is malformed (poison)', () => {
    const alert = buildDlqAlert({ id: 'msg-2', body: { foo: 'bar' }, attempts: 3 });
    expect(alert.log.orderId).toBeNull();
    expect(alert.log.jobId).toBeNull();
    expect(alert.log.bodySnippet).toBe('{"foo":"bar"}');
  });

  it('handles a primitive body (JSON.stringify quotes strings)', () => {
    const alert = buildDlqAlert({ id: 'msg-3', body: 'not-json', attempts: 1 });
    expect(alert.log.bodySnippet).toBe('"not-json"');
    expect(alert.log.orderId).toBeNull();
  });

  it('handles a null body', () => {
    const alert = buildDlqAlert({ id: 'msg-4', body: null, attempts: 2 });
    expect(alert.log.bodySnippet).toBe('null');
    expect(alert.log.orderId).toBeNull();
  });

  it('truncates a body snippet longer than the cap', () => {
    const longValue = 'x'.repeat(500);
    const alert = buildDlqAlert({ id: 'msg-5', body: { orderId: longValue }, attempts: 1 });
    expect(alert.log.bodySnippet.length).toBeLessThanOrEqual(201); // 200 + ellipsis
    expect(alert.log.bodySnippet.endsWith('…')).toBe(true);
  });

  it('escapes HTML in the email section so a poison body cannot inject markup', () => {
    const alert = buildDlqAlert({
      id: 'msg-6',
      body: { orderId: '<script>alert(1)</script>' },
      attempts: 1,
    });
    expect(alert.emailSection).not.toContain('<script>');
    expect(alert.emailSection).toContain('&lt;script&gt;');
  });

  it('includes orderId and attempts in the email section', () => {
    const alert = buildDlqAlert({
      id: 'msg-7',
      body: { orderId: 'ord-9', jobId: 'job-9' },
      attempts: 7,
    });
    expect(alert.emailSection).toContain('ord-9');
    expect(alert.emailSection).toContain('job-9');
    expect(alert.emailSection).toContain('>7<');
  });
});

describe('buildDlqBatchAlertEmail', () => {
  it('builds a subject that reports the count and wraps sections in the template shell', () => {
    const a = buildDlqAlert({ id: 'm1', body: { orderId: 'o1', jobId: 'j1' }, attempts: 10 });
    const { subject, html } = buildDlqBatchAlertEmail([a.emailSection]);
    expect(subject).toBe('[DLQ] Prodigi — 1 wiadomość/i w kolejce martwych wiadomości');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('o1');
  });

  it('renders every section when under the cap', () => {
    const sections = Array.from({ length: 5 }, (_, i) =>
      buildDlqAlert({ id: `m${i}`, body: { orderId: `ord-${i}`, jobId: `job-${i}` }, attempts: 1 }).emailSection,
    );
    const { html } = buildDlqBatchAlertEmail(sections);
    for (let i = 0; i < 5; i++) {
      expect(html).toContain(`ord-${i}`);
    }
    expect(html).not.toContain('kolejnych');
  });

  it('caps the rendered sections and notes the remainder', () => {
    const sections = Array.from({ length: 25 }, (_, i) =>
      buildDlqAlert({ id: `m${i}`, body: { orderId: `ord-${i}`, jobId: `job-${i}` }, attempts: 1 }).emailSection,
    );
    const { html } = buildDlqBatchAlertEmail(sections);
    // first 10 shown
    expect(html).toContain('ord-0');
    expect(html).toContain('ord-9');
    // the 11th is NOT rendered
    expect(html).not.toContain('ord-10');
    // remainder is noted
    expect(html).toContain('15 kolejnych');
  });

  it('handles an empty section list (defensive — handler only calls with >0)', () => {
    const { subject, html } = buildDlqBatchAlertEmail([]);
    expect(subject).toContain('0');
    expect(html).toContain('<!DOCTYPE html>');
  });
});
