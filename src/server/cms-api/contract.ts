// Kept in sync BY HAND with contracts/cms-v1.json's info.version — this is
// the runtime value GET /v1/session and /v1/capabilities actually report
// (cms-ceramics's gateway.ts compares it against its own pinned copy's
// info.version before allowing any write; see CONTRACT_MISMATCH in
// gateway.ts). Nothing in this repo derives it from the JSON file
// automatically, so every contract change here that changes request/response
// shape must bump BOTH this constant and contracts/cms-v1.json's
// info.version, identically, in the same change. Task 12 bumped 1.0.0 ->
// 1.1.0: POST /v1/uploads now requires productId, a backward-incompatible
// change to an already-implemented (if not yet deployed) operation.
export const CMS_API_CONTRACT_VERSION = '1.1.0';
