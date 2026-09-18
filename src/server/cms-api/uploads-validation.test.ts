import { describe, expect, it } from 'vitest';
import { validateUploadCreate } from './uploads-validation';

const validBody = { filename: 'kubek-01.jpg', contentType: 'image/jpeg', bytes: 123456, ratio: '4:5', productId: 'print-01' };

describe('validateUploadCreate', () => {
  it('accepts a valid body', () => {
    const result = validateUploadCreate(validBody);
    expect(result).toEqual({ ok: true, data: validBody });
  });

  it('accepts image/png as well as image/jpeg', () => {
    const result = validateUploadCreate({ ...validBody, contentType: 'image/png' });
    expect(result.ok).toBe(true);
  });

  it('rejects an unsupported contentType (contract enum is jpeg/png only)', () => {
    const result = validateUploadCreate({ ...validBody, contentType: 'image/gif' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors.contentType).toBeDefined();
  });

  it('rejects a blank filename', () => {
    const result = validateUploadCreate({ ...validBody, filename: '' });
    expect(result.ok).toBe(false);
  });

  it('rejects a whitespace-only filename', () => {
    const result = validateUploadCreate({ ...validBody, filename: '   ' });
    expect(result.ok).toBe(false);
  });

  it('rejects a non-integer bytes value', () => {
    const result = validateUploadCreate({ ...validBody, bytes: 123.45 });
    expect(result.ok).toBe(false);
  });

  it('rejects a zero or negative bytes value', () => {
    expect(validateUploadCreate({ ...validBody, bytes: 0 }).ok).toBe(false);
    expect(validateUploadCreate({ ...validBody, bytes: -10 }).ok).toBe(false);
  });

  it('rejects a blank ratio', () => {
    const result = validateUploadCreate({ ...validBody, ratio: '' });
    expect(result.ok).toBe(false);
  });

  // Task 12: the product-association gap Task 11's Container processor
  // self-flagged (see profiles.ts's caller in process-job.ts) — productId is
  // now a required field on the request body itself, not just a nullable DB
  // column nothing populates.
  it('rejects a missing productId, naming it in fieldErrors', () => {
    const rest: Record<string, unknown> = { ...validBody };
    delete rest.productId;
    const result = validateUploadCreate(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors.productId).toBeDefined();
  });

  it('rejects a blank productId', () => {
    expect(validateUploadCreate({ ...validBody, productId: '' }).ok).toBe(false);
  });

  it('rejects a whitespace-only productId', () => {
    expect(validateUploadCreate({ ...validBody, productId: '   ' }).ok).toBe(false);
  });

  it('rejects a missing field, naming it in fieldErrors', () => {
    const rest: Record<string, unknown> = { ...validBody };
    delete rest.filename;
    const result = validateUploadCreate(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors.filename).toBeDefined();
  });

  it('rejects extra properties not in the contract (additionalProperties: false)', () => {
    const result = validateUploadCreate({ ...validBody, mysteryField: true });
    expect(result.ok).toBe(false);
  });

  it('rejects a non-object body', () => {
    expect(validateUploadCreate(null).ok).toBe(false);
    expect(validateUploadCreate('nope').ok).toBe(false);
    expect(validateUploadCreate(42).ok).toBe(false);
  });
});
