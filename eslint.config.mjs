import globals from 'globals'
import pluginJs from '@eslint/js'
import tseslint from 'typescript-eslint'
import pluginReact from '@eslint-react/eslint-plugin'
import stylistic from '@stylistic/eslint-plugin'
import pluginReactHooks from 'eslint-plugin-react-hooks'

/** @type {import('eslint').Linter.Config[]} */
export default [
  { files: ['**/*.{js,mjs,cjs,ts,jsx,tsx}'] },
  { languageOptions: { globals: globals.browser } },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['**/*.{jsx,tsx}'], ...pluginReact.configs['recommended-typescript'] },
  stylistic.configs.recommended,
  {
    plugins: { 'react-hooks': pluginReactHooks },
    rules: { ...pluginReactHooks.configs.recommended.rules },
  },
  {
    rules: {
      'no-import-assign': 'warn',
      '@typescript-eslint/no-unused-vars': 'warn',
      'react-hooks/exhaustive-deps': 'error',
      '@stylistic/jsx-max-props-per-line': 'off',
    },
  },
]
