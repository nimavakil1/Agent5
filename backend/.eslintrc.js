module.exports = {
  env: {
    node: true,
    es2022: true,
    jest: true,
  },
  parserOptions: {
    ecmaVersion: 2022,
  },
  extends: ['eslint:recommended'],
  rules: {
    'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'no-undef': 'error',
    'no-unreachable': 'error',
    'no-constant-condition': 'warn',
    'no-empty': 'warn',
    'no-prototype-builtins': 'off',
    'require-await': 'warn',
  },
};
