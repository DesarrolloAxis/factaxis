'use strict';

module.exports = {
  testEnvironment: 'node',
  testTimeout: 20000,
  globalSetup: '<rootDir>/scripts/test-global-setup.js',
  testPathIgnorePatterns: ['/node_modules/', '/__fixtures__/'],
};
