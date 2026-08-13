import { describe, it, expect } from 'vitest';
import { buildOutcomeAlert, serializeOutcomeIssues } from './outcome-alert';

const ISSUE = {
  objectId: 'item-1',
  errorCode: 'items.assets.NotDownloaded',
  description: 'Asset could not be downloaded <script>',
};

describe('serializeOutcomeIssues', () => {
  it('keeps outcome + full issue codes/descriptions as valid JSON (no truncation)', () => {
    const long = { ...ISSUE, description: 'x'.repeat(5000) };
    const s = serializeOutcomeIssues('createdWithIssues', [long]);
    const parsed = JSON.parse(s) as { outcome: string; issues: Array<typeof long> };
    expect(parsed.outcome).toBe('createdWithIssues');
    expect(parsed.issues[0].errorCode).toBe(ISSUE.errorCode);
    expect(parsed.issues[0].description).toHaveLength(5000);
  });
});

describe('buildOutcomeAlert', () => {
  const alert = buildOutcomeAlert({
    orderId: 'o1',
    jobId: 'j1',
    prodigiOrderId: 'pr_1',
    outcome: 'createdWithIssues',
    issues: [ISSUE],
  });

  it('builds a structured log + error-level Sentry payload with the ids and issues', () => {
    expect(alert.log).toMatchObject({
      event: 'prodigi_order_outcome_issues',
      orderId: 'o1',
      jobId: 'j1',
      prodigiOrderId: 'pr_1',
      outcome: 'createdWithIssues',
    });
    expect(alert.sentry.level).toBe('error');
    expect(alert.sentry.extra).toMatchObject({ prodigiOrderId: 'pr_1' });
  });

  it('renders an HTML-escaped studio email with the issue code', () => {
    expect(alert.email.subject).toContain('pr_1');
    expect(alert.email.html).toContain('items.assets.NotDownloaded');
    expect(alert.email.html).not.toContain('<script>');
    expect(alert.email.html).toContain('&lt;script&gt;');
  });

  it('notes an empty issues list instead of rendering nothing', () => {
    const empty = buildOutcomeAlert({
      orderId: 'o1', jobId: 'j1', prodigiOrderId: 'pr_1', outcome: 'OnHold', issues: [],
    });
    expect(empty.email.html).toContain('pusta lista issues');
  });
});
