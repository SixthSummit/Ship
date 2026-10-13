import tseslint from "typescript-eslint";

const architectureRules = {
  // Keep request input attached to a schema so transport, client, and OpenAPI
  // projections cannot silently disagree about the accepted shape.
  "no-restricted-syntax": [
    "error",
    {
      selector:
        "CallExpression[callee.type='MemberExpression'][callee.object.type='MemberExpression'][callee.object.property.name='req'][callee.property.name=/^(json|query|param)$/]",
      message:
        "Avoid raw `c.req.json()` / `c.req.query()` / `c.req.param()` — register a Zod schema with `validate('json' | 'query' | 'param', schema)` and read via `c.req.valid(...)`.",
    },
  ],

  // Keep ORM-specific value imports inside the database boundary. Type-only
  // imports are contracts and remain valid outside the boundary.
  "@typescript-eslint/no-restricted-imports": [
    "error",
    {
      paths: [
        {
          name: "drizzle-orm",
          message:
            "Raw Drizzle operators bypass the data-access boundary. Use the repository/query contract, or add a narrowly justified eslint-disable for specialized access.",
          allowTypeImports: true,
        },
      ],
      patterns: [
        {
          group: [
            "drizzle-orm/sql",
            "drizzle-orm/sql/**",
            "drizzle-orm/**/expressions",
            "drizzle-orm/**/expressions/**",
          ],
          message:
            "Raw Drizzle operator subpaths belong in the data-access boundary; schema imports from drizzle-orm/pg-core remain allowed.",
          allowTypeImports: true,
        },
      ],
    },
  ],
};

export default [
  {
    ignores: [
      "angular/**",
      "packages/angular/**",
      "apps/angular-docs/**",
      "dist/**",
      "node_modules/**",
      "lib/**",
      "bin/**",
      "scripts/**",
      "packages/*/lib/**",
      "packages/*/templates/**",
      "apps/docs/.astro/**",
      "apps/docs/dist/**",
      "**/coverage/**",
    ],
  },
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: architectureRules,
  },
  {
    files: [
      "packages/core/src/app/db/**",
      "packages/drizzle/src/**",
      "packages/core/src/app/services/DrizzleEntityService.ts",
      "packages/core/src/app/auth/jwt/DrizzleRefreshTokenStore.ts",
      "modules/**/schema.ts",
    ],
    rules: { "@typescript-eslint/no-restricted-imports": "off" },
  },
  {
    files: ["packages/core/src/hono/**", "packages/hono/src/**"],
    rules: {
      // This is the one transport boundary responsible for translating raw
      // Hono input into operation input before kernel validation.
      "no-restricted-syntax": "off",
    },
  },
  {
    files: ["**/*.test.ts", "**/*.test.js"],
    rules: {
      "no-restricted-syntax": "off",
      "@typescript-eslint/no-restricted-imports": "off",
    },
  },
];
