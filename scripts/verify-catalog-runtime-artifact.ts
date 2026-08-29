import {
  type CatalogRuntimeArtifact,
  verifyCatalogRuntimeArtifact,
} from './lib/catalog-runtime-artifact';

const artifactFlagIndex = process.argv.indexOf('--artifact');
const artifact = process.argv[artifactFlagIndex + 1] as CatalogRuntimeArtifact | undefined;

if (artifactFlagIndex < 0 || (artifact !== 'next' && artifact !== 'opennext')) {
  throw new Error('Usage: verify-catalog-runtime-artifact --artifact next|opennext');
}

verifyCatalogRuntimeArtifact({ repositoryRoot: process.cwd(), artifact });
console.log(`Verified runtime-only catalog routes in the ${artifact} artifact.`);
