import parser from "@typescript-eslint/parser";

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
      "src/interfaces/mcp-app/**/*.ts",
      "test/interfaces/mcp-app/**/*.ts",
    ],
    languageOptions: {
      parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
  },
];
