import { describe, it, expect } from 'vitest';
import { buildProdigiAttributes } from '../../src/lib/print-prodigi-attributes';

describe('buildProdigiAttributes', () => {
  it('returns empty attrs for unframed variants', () => {
    expect(buildProdigiAttributes({ framed: false, mount: false, frameColour: 'none' })).toEqual({});
  });

  it('includes frame colour for framed unmounted variants', () => {
    expect(buildProdigiAttributes({ framed: true, mount: false, frameColour: 'black' })).toEqual({
      color: 'black',
    });
  });

  it('includes mount attrs for framed mounted variants', () => {
    expect(buildProdigiAttributes({ framed: true, mount: true, frameColour: 'white' })).toEqual({
      color: 'white',
      mount: '2.4mm',
      mountColor: 'Snow white',
    });
  });
});
