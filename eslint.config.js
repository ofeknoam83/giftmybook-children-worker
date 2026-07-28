'use strict';

/**
 * Minimal lint gate — `no-undef` only.
 *
 * Added after the 2026-07-28 audit of book 4c8daf08: server.js referenced the
 * block-scoped `pipelineResult` from a sibling scope, which threw ReferenceError
 * at runtime inside a non-blocking catch and silently killed every cover PDF
 * for six days. `?.` does not guard an undeclared identifier — only static
 * analysis catches this class before deploy. Style rules are deliberately NOT
 * enabled; this config exists to reject undeclared identifiers, nothing else.
 *
 * Run with: npm run lint
 */

const nodeGlobals = Object.fromEntries([
  // CommonJS
  'require', 'module', 'exports', '__dirname', '__filename',
  // Node runtime
  'process', 'console', 'Buffer', 'global', 'globalThis',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'setImmediate', 'clearImmediate', 'queueMicrotask',
  // Web-compat globals available in Node >= 18
  'fetch', 'AbortController', 'AbortSignal', 'URL', 'URLSearchParams',
  'TextEncoder', 'TextDecoder', 'structuredClone', 'atob', 'btoa',
  'Blob', 'FormData', 'Headers', 'Request', 'Response',
].map((name) => [name, 'readonly']));

const jestGlobals = Object.fromEntries([
  'describe', 'it', 'test', 'expect', 'beforeAll', 'afterAll',
  'beforeEach', 'afterEach', 'jest', 'fail',
].map((name) => [name, 'readonly']));

module.exports = [
  {
    ignores: ['node_modules/**', 'coverage/**'],
  },
  {
    files: ['**/*.js'],
    // In-code disable directives target rules (e.g. no-unused-vars) that this
    // minimal config doesn't enable — don't warn about them here.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: nodeGlobals,
    },
    rules: {
      'no-undef': 'error',
    },
  },
  {
    files: ['**/__tests__/**/*.js', '**/*.test.js'],
    languageOptions: {
      globals: { ...nodeGlobals, ...jestGlobals },
    },
  },
];
