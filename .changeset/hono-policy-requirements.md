---
"@sixthsummit/ship-hono": minor
---

A credential adapter can name the pre-validation policy it cannot be mounted without. `defineHonoCredentialAdapter({ requires: [{ key, policyId, message }] })` declares that `preValidationPolicies[key]` must carry `policyId`; `createHonoAdapter` refuses to construct otherwise with `SHIP_HONO_OPTIONS_INVALID` and the adapter's message. Policies are named with `definePreValidationPolicy(id, policy)` and inspected with `preValidationPolicyIds()`. A `preValidationPolicies` key may now hold a list of policies (`HonoPreValidationPolicies`) that run in order: the first refusal wins and the allow headers accumulate, `Set-Cookie` values all appended, so a required guard composes with a consumer's own policy under the same key.
