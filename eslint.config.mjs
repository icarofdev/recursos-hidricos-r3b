import js from '@eslint/js';
import ts from 'typescript-eslint';
import globals from 'globals';
export default [
 {ignores:['static/js/vendor/**','legacy/**','dist/**','.runtime/**']},
 js.configs.recommended,
 ...ts.configs.recommended.map(config=>({...config,files:['cloudflare/**/*.ts']})),
 {files:['static/js/**/*.js'],languageOptions:{globals:{...globals.browser,Chart:'readonly'}}},
 {files:['scripts/**/*.mjs','tests/**/*.mjs'],languageOptions:{globals:globals.node}},
 {
  rules: {
   'no-unused-vars': 'off',
   'no-empty': ['error', { allowEmptyCatch: true }],
   'no-control-regex': 'off'
  }
 },
 {
  files: ['cloudflare/**/*.ts'],
  rules: {
   '@typescript-eslint/no-unused-vars': 'off',
   '@typescript-eslint/no-explicit-any': 'error'
  }
 }
];
