import { describe, it, expect } from 'vitest';
import { isTerminalStatus, mapProdigiStage } from './status-map';

describe('mapProdigiStage', () => {
  it('maps InProduction', () => expect(mapProdigiStage('InProduction')).toBe('in_production'));
  it('maps Complete to shipped', () => expect(mapProdigiStage('Complete')).toBe('shipped'));
  it('defaults unknown stages', () => expect(mapProdigiStage('Pending')).toBe('fulfilment_submitted'));
});

describe('isTerminalStatus', () => {
  it('treats completed as terminal', () => expect(isTerminalStatus('completed')).toBe(true));
  it('does not treat in_production as terminal', () => expect(isTerminalStatus('in_production')).toBe(false));
});
