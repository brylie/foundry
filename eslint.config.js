// Lint rules for Foundry's mod and tests. They aim at bugs, security and
// maintainability, not formatting. Type-aware rules read tsconfig.json, which
// needs the engine's declarations in .claude-plugin/types/ (see CONTRIBUTING.md).

import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import regexp from 'eslint-plugin-regexp'
import sonarjs from 'eslint-plugin-sonarjs'
import tseslint from 'typescript-eslint'

export default defineConfig(
  { ignores: ['node_modules/', '.claude-plugin/types/', 'eslint.config.js'] },

  js.configs.recommended,
  // Type-aware: floating promises, unsafe `any`, needless conditions, misused async, and more.
  tseslint.configs.strictTypeChecked,
  // Regular expressions: catastrophic backtracking, unreachable alternatives, misplaced flags.
  // The guard is mostly regexes, so a regex bug there is a security bug.
  regexp.configs['flat/recommended'],
  // Bugs and code smells: identical branches, always-true conditions, functions too complex to review.
  sonarjs.configs.recommended,

  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // A guard on an async hook must not be left floating, and neither may a GitHub write.
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
      // Numbers and booleans read naturally in messages; objects and undefined do not.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true, allowBoolean: true }],
      // `const { gone: _, ...rest } = x` is how a key is dropped from a copy.
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true, varsIgnorePattern: '^_', argsIgnorePattern: '^_' }],
      // Every regex the guard runs on agent input must be safe from catastrophic backtracking.
      'regexp/no-super-linear-backtracking': 'error',
      'regexp/no-super-linear-move': 'error',
      // A signal for review, not a gate: the panel's render hook is long by nature.
      'sonarjs/cognitive-complexity': ['warn', 25],

      // sonarjs rules another plugin already checks, more precisely: off, so one problem is one finding.
      'sonarjs/deprecation': 'off', // @typescript-eslint/no-deprecated
      'sonarjs/no-unused-vars': 'off', // @typescript-eslint/no-unused-vars
      'sonarjs/no-control-regex': 'off', // no-control-regex
      'sonarjs/super-linear-regex': 'off', // regexp/no-super-linear-backtracking and -move
      'sonarjs/concise-regex': 'off', // regexp/prefer-w and friends
      'sonarjs/regex-complexity': 'off', // the guard's patterns are long alternations, each documented

      // Style, not bugs.
      'sonarjs/no-nested-conditional': 'off',
      'sonarjs/no-nested-template-literals': 'off',
      'sonarjs/function-return-type': 'off', // a union return type is what TypeScript is for
      // Code-unit order is the same on every machine, which the state's fingerprints rely on;
      // localeCompare is not.
      'sonarjs/no-alphabetical-sort': 'off',
    },
  },

  {
    // JSX nests its event handlers as deep as the layout goes.
    files: ['**/*.tsx'],
    rules: { 'sonarjs/no-nested-functions': 'off' },
  },

  {
    // The hooks module and the flow test hand async callbacks to the engine's
    // `on()`, which awaits them, so "a promise where void was expected" is the
    // wrong question there. It is also the costly one: matching each argument
    // against every overload of the engine's event map takes minutes per file.
    // The other void-return checks stay on, and the rule stays whole elsewhere.
    files: ['hooks/register.tsx', 'tests/flow.test.tsx'],
    rules: {
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false } }],
    },
  },

  {
    files: ['tests/**'],
    rules: {
      // Tests stand in for the engine with loose fixtures.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'sonarjs/no-duplicate-string': 'off',
      // The test kit takes async bodies; not every one needs to await.
      '@typescript-eslint/require-await': 'off',
      // Paths like /tmp/repo are fixtures for the guard, never opened.
      'sonarjs/publicly-writable-directories': 'off',
    },
  },
)
