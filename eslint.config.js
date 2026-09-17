// @ts-check
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "artifacts/**", "evidence/**", "coverage/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      // Matches this codebase's own convention (see e.g. src/schema/artifact.ts's
      // "never" exhaustiveness checks): an intentional escape hatch, not sloppiness.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
);
