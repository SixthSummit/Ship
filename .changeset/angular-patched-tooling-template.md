---
'@sixthsummit/ship-angular': patch
---

Update generated applications to patched Angular 20 dependencies and compatible current test, build, formatting, and lint tools. The template keeps its Node 20 consumer engine while repository maintenance uses Node 24. Existing application providers and public APIs stay unchanged.

Build the package from a temporary ng-packagr input manifest so generated Angular export mappings have one owner. Preserve the published entrypoint layout and stable source maps.

Generated projects run `pnpm lint` through standalone ESLint with the same TypeScript and HTML patterns and framework rules. The unused Angular CLI lint builder target and its schematics dependencies are removed. This lets supported ESLint 10 and modular Angular lint plugins coexist with Angular 20 application builds. Vitest is pinned to patched 4.1.11. A scoped Angular build 20.3.39 peer metadata correction supports this scaffold’s application/SSR build and separate Analog test pipeline. The experimental Angular native unit-test builder is not configured or validated by this scaffold.
