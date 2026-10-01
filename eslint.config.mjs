import shellConfig from '@rancher/shell/eslint.config.base.mjs';

export default [
  ...shellConfig,
  {
    ignores: [
      'builder/**',
      'charts/**',
      'dist-pkg/**',
      'node_modules/**'
    ]
  },
  {
    // `no-undef` has no view of TypeScript's lib types, so it flags things like
    // `RequestInit` that tsc resolves perfectly well. tsc is the authority on
    // undefined identifiers in .ts files - `yarn check-types` covers this.
    files: ['**/*.ts'],
    rules: { 'no-undef': 'off' }
  },
  {
    files:           ['**/*.test.ts', '**/__tests__/**/*.ts'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it:       'readonly',
        expect:   'readonly',
        jest:     'readonly',
        beforeAll: 'readonly',
        beforeEach: 'readonly',
        afterAll:  'readonly',
        afterEach: 'readonly'
      }
    }
  }
];
