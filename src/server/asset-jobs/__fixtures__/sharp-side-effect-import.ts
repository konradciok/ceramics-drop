// Fixture for container-config.test.ts's Sharp-boundary regression tests
// (Task D item 7): a bare side-effect import with no named/namespace
// bindings — the `import '…'` form the from-clause-only regex used to miss
// entirely. Not imported by any production code; reachable only via the
// test file's own importGraph() calls.
import 'sharp';
