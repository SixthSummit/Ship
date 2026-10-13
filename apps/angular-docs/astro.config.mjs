import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  site: 'https://docs.shipangular.dev',
  integrations: [
    starlight({
      title: 'ShipAngular',
      // Canonical docs/404.md owns this route through the docs catch-all.
      disable404Route: true,
      description:
        'The most idiomatic Angular 20 starter — and the only framework explicitly designed to be edited by AI coding agents.',
      logo: {
        src: './src/assets/logo.svg',
        replacesTitle: false,
      },
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/SixthSummit/Ship',
        },
      ],
      editLink: {
        baseUrl: 'https://github.com/SixthSummit/Ship/edit/dev/angular/docs/',
      },
      lastUpdated: true,
      customCss: ['./src/styles/custom.css'],
      head: [
        {
          tag: 'meta',
          attrs: { name: 'theme-color', content: '#0ea5e9' },
        },
      ],
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { label: 'Quick Start', slug: 'getting-started/quick-start' },
            { label: 'Installation', slug: 'getting-started/installation' },
            { label: 'Project Structure', slug: 'getting-started/project-structure' },
            { label: 'Configuration', slug: 'getting-started/configuration' },
          ],
        },
        {
          label: 'Architecture',
          items: [
            { label: 'Framework Overview', slug: 'architecture/framework-overview' },
            { label: 'Authentication', slug: 'architecture/authentication' },
            { label: 'Module System', slug: 'architecture/module-system' },
            { label: 'ShipAngular ↔ ShipAPI Contract', slug: 'architecture/contract' },
          ],
        },
        {
          label: 'Development',
          items: [
            { label: 'CLI Reference', slug: 'development/cli-reference' },
            { label: 'Creating Modules', slug: 'development/creating-modules' },
          ],
        },
        {
          label: 'API Reference',
          items: [{ label: 'Library Exports', slug: 'api/library-exports' }],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Firebase Setup', slug: 'guides/firebase-setup' },
            { label: 'TanStack Query', slug: 'guides/tanstack-query' },
            { label: 'Realtime Subscriptions', slug: 'guides/realtime-subscriptions' },
          ],
        },
        {
          label: 'Operations',
          items: [
            { label: 'CI/CD Setup', slug: 'ci-setup' },
            { label: 'Interim Backend', slug: 'interim-backend' },
            { label: 'Roadmap', slug: 'roadmap' },
          ],
        },
      ],
    }),
  ],
});
