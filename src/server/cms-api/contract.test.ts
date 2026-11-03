import { describe, expect, it } from 'vitest';
import contract from '../../../contracts/cms-v1.json';
import { CMS_API_CONTRACT_VERSION } from './contract';

// Task 12 found that CMS_API_CONTRACT_VERSION (the runtime value GET
// /v1/session and /v1/capabilities report, and the ONLY thing cms-ceramics's
// gateway.ts actually compares against its own pinned contract copy before
// allowing writes) is a hand-maintained literal, entirely decoupled from
// contracts/cms-v1.json's own info.version — nothing enforced the two ever
// agreeing. A silent drift between them would not fail loudly: it would
// surface, in production, as every write suddenly 409 CONTRACT_MISMATCH (or
// worse, as a false "match" that hides a real contract change). This test
// exists solely to make that drift a fast, local, pre-merge failure instead.
describe('CMS_API_CONTRACT_VERSION', () => {
  it('matches contracts/cms-v1.json info.version exactly', () => {
    expect(CMS_API_CONTRACT_VERSION).toBe(contract.info.version);
  });
});
