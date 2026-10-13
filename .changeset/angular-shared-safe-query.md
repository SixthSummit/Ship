---
'@sixthsummit/ship-angular': minor
---

Add the optional `/query` entrypoint for safe typed reads, finite and infinite queries, owned browser and SSR caches, scope isolation, explicit cache effects, and operation mutations. Pin the experimental TanStack Angular adapter to 5.104.1. Add an opt-in `operation-query` generator. Existing root and operation helpers remain available without TanStack.

The package build now uses its strict TypeScript configuration. The concrete `FirebaseAuthAdapter` and `MockAuthAdapter` bearer-token capability returns `Promise<string | null>` in published declarations, which matches the existing auth capability interface and signed-out runtime behavior. Consumers that use these concrete adapters must handle `null` before using a token. Adapter runtime behavior is unchanged.
