import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**", "**/build/**", "coverage/**", "content/**", "site/**",
      "playwright-report/**", "test-results/**", "**/.e2e/**", "**/playwright-report/**", "**/test-results/**", "**/.wrangler/**", "node_modules/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
      eqeqeq: ["error", "always"],
      "no-console": "off",
    },
  },
  {
    // Service workers run in a worker scope, not a window.
    files: ["apps/shell/src/sw/**/*.ts"],
    languageOptions: { globals: { ...globals.serviceworker } },
  },
);
