---
"@sixthsummit/ship-core": minor
---

An actor resolver may attach response headers to its outcome: `ActorResolution` and `ActorResolutionResult` gain an optional `headers` record (`ActorResolutionHeaders`), normalised by `defineActorResolver` / `normalizeActorResolution` and ignored by direct executor runs. The use case is a transport credential the resolver found dead, such as a stale session cookie the browser should drop.
