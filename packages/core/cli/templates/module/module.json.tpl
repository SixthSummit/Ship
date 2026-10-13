{
  "name": "{{namePlural}}",
  "description": "{{NameSingular}} module on the v4 substrate — Drizzle pgTable, DrizzleEntityService, Hono routes.",
  "version": "0.1.0",
  "dependencies": [],
  "npmDependencies": {},
  "requiredEnvVars": [],
  "optionalEnvVars": [],
  "postInstall": [
    "Add the module's pgTable to your composed schema: `createApp({ schema: { ...accountsSchema, {{namePlural}}: {{namePlural}} } })`",
    "Wire the routes into your app composition: `define{{NamePlural}}Routes(app, { service, provider })`",
    "Generate the migration: `npm run db:generate`"
  ]
}
