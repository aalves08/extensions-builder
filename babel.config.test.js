/**
 * Babel config used only by jest.
 *
 * The root babel.config.js re-exports @rancher/shell's, whose `test`
 * environment pulls in `transform-require-context` and `babel-plugin-istanbul`.
 * Those are dashboard build-time dependencies that an extension does not get,
 * so jest is pointed here instead (see jest.config.js). Nothing under test
 * needs require.context, and coverage is not instrumented.
 */
module.exports = {
  presets: [
    ['@babel/preset-env', { targets: { node: 'current' } }],
    '@babel/preset-typescript'
  ]
};
