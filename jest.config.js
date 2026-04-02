module.exports = {
  testEnvironment: 'node',
  forceExit: true,
  coverageDirectory: 'coverage',
  collectCoverageFrom: [
    'services/**/*.js',
    'prompts/**/*.js',
    '!services/taskQueue.js',
  ],
  testMatch: ['**/__tests__/**/*.test.js'],
};
