import parser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  {
    ignores: [
      ".WORK/**",
      "dist/**",
      "node_modules/**",
    ],
  },
  {
    files: [
      "src/interfaces/web/**/*.{ts,tsx}",
      "test/interfaces/web/**/*.{ts,tsx}",
      "src/interfaces/mcp-app/**/*.ts",
      "test/interfaces/mcp-app/**/*.ts",
    ],
    languageOptions: {
      parser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/exhaustive-deps": "error",
      "react-hooks/rules-of-hooks": "error",
    },
  },
];
