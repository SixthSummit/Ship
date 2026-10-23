---
"@sixthsummit/ship-auth-credentials": minor
---

Change two defaults in `@sixthsummit/ship-auth-credentials`. Passwords hash with argon2id from `node:crypto` (`argon2idPasswordHasher`, 64 MiB, t=3, p=1, standard PHC string); the hasher also verifies and flags `$scrypt$` hashes for rehash on sign-in, and `scryptPasswordHasher` remains available. `onExistingEmail` defaults to `"conceal"`: `register` answers 201 for an address that already has an account and mails the owner a verification link (unverified) or the new `existingAccount` notice (verified) linking to the new `links.signIn`, which is required in this mode. Set `onExistingEmail: "reject"` to keep the 409.
