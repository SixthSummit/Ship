# `@sixthsummit/ship-auth-firebase`

Firebase Admin authentication for operation-based Ship applications. The
package supplies strict Hono bearer-credential extraction and a kernel
`ActorResolver`; applications own the verified-user lookup and permission
snapshot.

The adapter does not assume an ORM, account table, tenant model, or public error
message. Forwarded authorization is disabled unless the trusted deployment
boundary enables it explicitly.

Use `forwardedAuthorization: "prefer"` only behind a proxy that overwrites
`X-Forwarded-Authorization`; use `"fallback"` to keep direct Authorization
precedence. The default is `"disabled"`.
