import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import nextPlugin from "@next/eslint-plugin-next/dist/index.js";

/**
 * Shared ESLint flat config for the entire Vexlyx monorepo.
 * All workspace packages inherit these rules automatically.
 *
 * Uses ESLint 9+ flat config format.
 * Prettier integration disables formatting-related rules to avoid conflicts.
 */
export default tseslint.config(
  // Global ignores - must be first
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "apps/api/Python/**",
      "node_modules/",
      "dist/",
      ".next/",
      ".turbo/",
      "*.config.js",
      "*.config.mjs",
      "apps/dashboard/.next/**",
      "apps/dashboard/next-env.d.ts",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    rules: {
      /* Enforce CLAUDE.md Section 6: no `any` type */
      "@typescript-eslint/no-explicit-any": "warn",

      /* Encourage explicit return types on exported functions */
      "@typescript-eslint/explicit-function-return-type": "off",

      /* Catch unused variables but allow underscore-prefixed params */
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      /* Discourage console.log in production (CLAUDE.md Section 6) */
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  // Plain Node scripts (dev-setup, docs tooling) run outside any bundler,
  // so they need the Node globals that tseslint's TS overrides strip out.
  {
    files: ["scripts/**/*.mjs", "docs/scripts/**/*.mjs", "docs/**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setImmediate: "readonly",
        queueMicrotask: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        require: "readonly",
        module: "readonly",
        exports: "writable",
      },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  // Standalone browser probes under tests/ inject JS into a page, so they
  // legitimately reference browser globals alongside Node's.
  {
    files: ["tests/**/*.cjs", "tests/**/*.js"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        __dirname: "readonly",
        require: "readonly",
        module: "readonly",
        exports: "writable",
        document: "readonly",
        location: "readonly",
        window: "readonly",
        navigator: "readonly",
        fetch: "readonly",
        localStorage: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  // Next.js specific rules for the dashboard
  {
    files: ["apps/dashboard/**/*.{ts,tsx,js,jsx}"],
    plugins: {
      "@next/next": nextPlugin,
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      // Disable overly strict rules for this codebase
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-unsafe-function-type": "off",
      "@typescript-eslint/no-wrapper-object-types": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  }
);
