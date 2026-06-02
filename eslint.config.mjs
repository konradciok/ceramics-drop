import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    ignores: ['design/**', '.next/**', '.open-next/**', '.wrangler/**', 'node_modules/**'],
  },
];

export default eslintConfig;
