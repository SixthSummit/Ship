import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: { ecmaVersion: 2022, sourceType: "module" },
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        global: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        fetch: "readonly",
        URL: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { args: "none", varsIgnorePattern: "^_" },
      ],
      "no-restricted-globals": [
        "error",
        {
          name: "process",
          message:
            "Read env via the validated `env` object from src/environment.ts (defineEnv). Direct process.env access bypasses the schema.",
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.object.type='MemberExpression'][callee.object.property.name='req'][callee.property.name=/^(json|query|param)$/]",
          message:
            "Avoid raw `c.req.json()` / `c.req.query()` / `c.req.param()`. Register a Zod schema with validate() and read via c.req.valid(...).",
        },
      ],
      // Keep raw Drizzle query operators in the data-access layer. Express
      // service queries via QueryOptions / DrizzleEntityService so a future
      // ORM swap touches only the db layer. Schema (src/db, src/modules/**/
      // schema.ts) is exempt below; type-only imports are allowed.
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "drizzle-orm",
              message:
                "Raw Drizzle operators (eq/and/or/sql/…) bypass the QueryOptions abstraction. Express service queries via QueryOptions / DrizzleEntityService so an ORM swap touches only the db layer. For specialized access (row locking, raw SQL), add `// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- <reason>`.",
              allowTypeImports: true,
            },
          ],
          // Operators also re-export from drizzle-orm/sql* and **/expressions
          // subpaths; block those too so `import { eq } from "drizzle-orm/sql"`
          // can't dodge the rule. `drizzle-orm/pg-core` (columns) stays free.
          patterns: [
            {
              group: [
                "drizzle-orm/sql",
                "drizzle-orm/sql/**",
                "drizzle-orm/**/expressions",
                "drizzle-orm/**/expressions/**",
              ],
              message:
                "Raw Drizzle operators re-export from these subpaths too — keep them in the data-access layer (src/db / schema) and express service queries via QueryOptions / DrizzleEntityService.",
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
  {
    // Schema + the db layer are where raw Drizzle belongs.
    files: ["src/db/**", "src/modules/**/schema.ts"],
    rules: { "@typescript-eslint/no-restricted-imports": "off" },
  },
  {
    files: ["src/environment.ts"],
    rules: {
      // environment.ts is the boundary that reads process.env via
      // defineEnv. The rest of the app routes through `env`.
      "no-restricted-globals": "off",
    },
  },
  {
    files: ["**/*.test.ts"],
    rules: {
      "no-restricted-syntax": "off",
      "@typescript-eslint/no-restricted-imports": "off",
    },
  },
];
