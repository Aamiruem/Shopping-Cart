import js from '@eslint/js';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default [
  { ignores: ['dist/**'] },
  js.configs.recommended,
  react.configs.flat.recommended,
  react.configs.flat['jsx-runtime'],
  {
    files: ['**/*.{js,jsx,mjs}'], // .jsx too: without this, ESLint 9 skips every React component
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: { ...globals.browser }, ecmaVersion: 'latest', sourceType: 'module' },
    settings: { react: { version: 'detect' } },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react/prop-types': 'off',
      'react/no-unknown-property': ['error', { ignore: ['fetchpriority'] }],
    },
  },
  { files: ['scripts/**', 'vite.config.js'], languageOptions: { globals: { ...globals.node } } },
];
