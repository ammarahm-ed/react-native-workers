import { fixupConfigRules } from '@eslint/compat';
import { FlatCompat } from '@eslint/eslintrc';
import js from '@eslint/js';
import prettier from 'eslint-plugin-prettier';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});

export default defineConfig([
  {
    extends: fixupConfigRules(compat.extends('@react-native', 'prettier')),
    plugins: { prettier },
    rules: {
      'react/react-in-jsx-scope': 'off',
      'prettier/prettier': 'error',
    },
  },
  {
    // The @react-native preset parses everything as script-scoped CommonJS, so
    // ESM-only syntax (`import.meta`) in standalone Node build scripts trips it.
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
  },
  {
    // Node-side tooling: the CLI, the Expo config plugin, build scripts and
    // config files run under Node, not Metro, so they get the Node globals.
    files: [
      'cli/**/*.js',
      'scripts/**/*.{js,mjs}',
      'metro/**/*.js',
      'app.plugin.js',
      '*.config.js',
      'react-native.config.js',
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    ignores: ['node_modules/', 'lib/', 'docs/'],
  },
]);
