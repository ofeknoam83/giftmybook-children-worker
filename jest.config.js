module.exports = {
  testEnvironment: 'node',
  forceExit: true,
  coverageDirectory: 'coverage',
  collectCoverageFrom: [
    'services/**/*.js',
    '!services/catalogEngine/data/**',
  ],
  testMatch: ['**/__tests__/**/*.test.js'],
};
