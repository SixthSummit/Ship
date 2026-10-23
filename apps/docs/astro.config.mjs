import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

// https://astro.build/config
export default defineConfig({
  site: "https://docs.shipapi.dev",
  integrations: [
    starlight({
      title: "ShipAPI",
      description:
        "A TypeScript operation kernel with compiled contracts, explicit capabilities, and independently selectable adapters.",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/SixthSummit/Ship" }],
      // editLink targets the SOURCE markdown in /docs/ (or docs/v4/) on GitHub,
      // not the projected copy in apps/docs/src/content/docs/. Critical: edits
      // made via the GitHub link land on the source-of-truth file.
      editLink: {
        baseUrl: "https://github.com/SixthSummit/Ship/edit/dev/docs/",
      },
      lastUpdated: true,
      customCss: ["./src/styles/custom.css"],
      head: [
        {
          tag: "meta",
          attrs: { name: "theme-color", content: "#0ea5e9" },
        },
      ],
      // Sidebar IA. Each entry maps to a file the `scripts/copy-docs.mjs`
      // mirror projects from /docs/, /docs/v4/, AGENTS.md, or the v4
      // reference template README. Adding a new section here without a
      // matching ALLOW_LIST entry produces a 404 — keep them in sync.
      sidebar: [
        {
          label: "Getting Started",
          items: [
            { label: "Quick Start", slug: "getting-started/quick-start" },
            { label: "Operation template", slug: "getting-started/operation-template" },
            { label: "Project structure", slug: "getting-started/project-structure" },
            { label: "Agent onboarding", slug: "getting-started/agents" },
          ],
        },
        {
          label: "Operation Kernel",
          items: [
            { label: "Operations, HTTP & validation", slug: "concepts/routes-and-validation" },
            { label: "Typed client", slug: "cross-framework/typed-client" },
            { label: "Public API surface", slug: "public-api-surface" },
            { label: "Versioning", slug: "versioning" },
            { label: "Schema safety", slug: "features/schema-safety" },
          ],
        },
        {
          label: "Compatibility Concepts",
          items: [
            { label: "App lifecycle & bootstrap", slug: "concepts/lifecycle" },
            { label: "Services & DrizzleEntityService", slug: "concepts/services" },
            { label: "Authentication", slug: "concepts/authentication" },
            { label: "Permissions & RBAC", slug: "concepts/permissions" },
            { label: "Errors", slug: "concepts/errors" },
            { label: "Database & migrations", slug: "concepts/database" },
          ],
        },
        {
          label: "Cross-Framework",
          items: [
            { label: "ShipAngular consumption", slug: "cross-framework/shipangular" },
            { label: "React Native + Expo", slug: "cross-framework/react-native-expo" },
          ],
        },
        {
          label: "Compatibility Features",
          items: [
            { label: "Background jobs", slug: "features/jobs" },
            { label: "Observability", slug: "features/observability" },
            { label: "Caching", slug: "features/cache" },
            { label: "Storage adapters", slug: "features/storage" },
            { label: "Rate limiting", slug: "features/rate-limit" },
            { label: "Idempotency", slug: "features/idempotency" },
            { label: "Webhooks", slug: "features/webhooks" },
            { label: "Transactional mail", slug: "features/mail" },
            { label: "File uploads", slug: "features/uploads" },
            { label: "Health checks", slug: "features/health-checks" },
            { label: "JWT sessions", slug: "features/sessions" },
            { label: "Streaming", slug: "features/streaming" },
            { label: "WebSockets", slug: "features/websockets" },
            { label: "LLM helpers", slug: "features/llm-helpers" },
          ],
        },
        {
          label: "Tooling and Compatibility",
          items: [
            { label: "CLI reference", slug: "tooling/cli" },
            { label: "Code generators", slug: "tooling/generators" },
            { label: "Claude Code plugin", slug: "tooling/claude-plugin" },
            { label: "MCP server", slug: "tooling/mcp-server" },
            { label: "Sherpa QA briefs", slug: "tooling/sherpa-qa-briefs" },
          ],
        },
        {
          label: "Migration",
          items: [{ label: "v3 → v4 walkthrough", slug: "migration-v3-to-v4" }],
        },
        {
          label: "Reference",
          items: [
            { label: "Launch announcement", slug: "v4-launch" },
            { label: "Implementation status", slug: "v4-status" },
          ],
        },
      ],
    }),
  ],
});
