// Fixture for container-config.test.ts's Sharp-boundary regression tests
// (Task D item 7): a literal dynamic import expression, the other form the
// from-clause-only regex also used to miss. esbuild bundles a
// statically-analyzable dynamic import just like a static one, so this form
// is just as real a Sharp-boundary breach as a static import would be. Not
// imported by any production code; reachable only via the test file's own
// importGraph() calls.
//
// (Deliberately not spelling the actual syntax out in this comment with its
// own quote-delimited argument — doing so would itself match the walker's
// dynamic-import regex and add a spurious entry to the `packages` set.)
export async function loadSharpDynamically() {
  return import('sharp');
}
