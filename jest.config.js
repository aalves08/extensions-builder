module.exports = {
  testEnvironment:      'jsdom',
  roots:                ['<rootDir>/pkg'],
  moduleFileExtensions: ['js', 'ts', 'json', 'vue'],
  transform:            {
    '^.+\\.[jt]s$': ['babel-jest', { configFile: `${ __dirname }/babel.config.test.js` }],
    '^.+\\.vue$':   '@vue/vue3-jest'
  },
  // Mirrors the webpack aliases the extension is built with, so a test imports
  // exactly what the bundle does.
  moduleNameMapper: {
    '^@shell/(.*)$':      '<rootDir>/node_modules/@rancher/shell/$1',
    '^@components/(.*)$': '<rootDir>/node_modules/@rancher/shell/rancher-components/$1',
    '^@pkg/(.*)$':        '<rootDir>/pkg/$1'
  },
  // @rancher/shell ships untranspiled ES modules, so the few of its files the
  // utils import (config/types, config/settings) have to go through babel too.
  transformIgnorePatterns: ['/node_modules/(?!@rancher/shell/)'],
  testMatch:               ['<rootDir>/pkg/**/*.test.ts']
};
