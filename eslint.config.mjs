import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

const GENERATED_AND_EXTERNAL_PATHS = [
  'design/**',
  '.next/**',
  '**/.next/**',
  '.open-next/**',
  '**/.open-next/**',
  '.wrangler/**',
  '**/.wrangler/**',
  'node_modules/**',
  '**/node_modules/**',
  '.claude/**',
  '.worktrees/**',
];

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    ignores: GENERATED_AND_EXTERNAL_PATHS,
  },
];

export default eslintConfig;
