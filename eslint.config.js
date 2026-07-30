import tseslint from "typescript-eslint";

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: "Engine and fixtures must not read the system clock (SPEC §6): pass asof in.",
        },
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message: "Deterministic core: no randomness (SPEC §2.1).",
        },
      ],
    },
  },
  // docs/ is the generated browser bundle; demo-statements.ts is generated too.
  { ignores: ["node_modules/**", "data/**", "demo-data/**", "docs/**", "src/web/demo-statements.ts", "src/web/validate-parse-output.generated.mjs"] }
);
