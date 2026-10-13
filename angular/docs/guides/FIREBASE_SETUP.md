# Firebase Setup

Configuring Firebase Authentication with `FirebaseAuthAdapter` from `@sixthsummit/ship-angular/firebase-auth`. Skip this guide entirely if you're using a different `AuthAdapter` (Auth0, Clerk, Supabase, your own) — see [Authentication](../architecture/AUTHENTICATION.md).

## Prerequisites

- A Google account
- A ShipAngular v4 project (run `ship-angular create my-app` if you haven't)

## 1. Create a Firebase project

1. Open <https://console.firebase.google.com>
2. Click **Add project** → enter a name → (optional) enable Google Analytics → **Create**

## 2. Add a web app

1. In Firebase Console, click the **Web** icon (`</>`)
2. Enter an app nickname (e.g., `my-app-web`)
3. (Optional) Check **Firebase Hosting** if you plan to use it
4. Click **Register app**
5. Copy the `firebaseConfig` object — you'll paste it into your env files

```javascript
// Example shape — paste the values into environment.development.ts
const firebaseConfig = {
  apiKey: 'AIza…',
  authDomain: 'my-app.firebaseapp.com',
  projectId: 'my-app',
  storageBucket: 'my-app.appspot.com',
  messagingSenderId: '123456789',
  appId: '1:123456789:web:abc123def456',
  measurementId: 'G-XXXXXXXXXX', // optional
};
```

## 3. Enable Authentication

1. Console → **Authentication** → **Get started**
2. **Sign-in method** tab → enable **Email/Password** → **Save**

### Optional providers

- **Google** — OAuth sign-in
- **Email link (passwordless)** — magic-link authentication. Already supported by `AuthService.sendSignInLinkToEmail()` and `confirmSignIn()`.
- **Phone** — SMS verification (not yet wrapped by `FirebaseAuthAdapter`; reach for a custom adapter or extend the existing one)

## 4. Configure ShipAngular

### Development

```typescript
// src/environments/environment.development.ts
export const environment = {
  production: false,
  apiBaseUrl: 'http://localhost:3000/v1',
  firebase: {
    apiKey: 'AIza…',
    authDomain: 'my-app.firebaseapp.com',
    projectId: 'my-app',
    storageBucket: 'my-app.appspot.com',
    messagingSenderId: '123456789',
    appId: '1:123456789:web:abc123',
    measurementId: 'G-XXXXXXXXXX',
  },
};
```

### Production

```typescript
// src/environments/environment.production.ts
export const environment = {
  production: true,
  apiBaseUrl: 'https://api.my-app.com/v1',
  firebase: {
    apiKey: 'AIza…', // production project keys
    authDomain: 'my-app-prod.firebaseapp.com',
    projectId: 'my-app-prod',
    // … etc
  },
};
```

> **Recommended:** create separate Firebase projects for dev and prod. Sharing a single project risks dev users / data polluting production analytics and quota.

### Auth-disabled mode

The project template contains placeholders, and the CLI resolves an unset Firebase key to
an empty value in a generated project:

```typescript
function hasFirebaseConfig(cfg: { apiKey?: string }): boolean {
  return !!cfg?.apiKey && !cfg.apiKey.startsWith('{{');
}
```

When the key is empty or still a template placeholder, the starter **skips Firebase wiring
entirely** — `AuthService.state()` stays `'unknown'`, the welcome page renders, and SSR /
prerender works. As soon as you fill in real config, the predicate flips and
`FirebaseAuthAdapter` wires during explicit app initialization.

## 5. Authorized domains (production)

For production deploys:

1. Console → **Authentication → Settings → Authorized domains**
2. **Add domain** → enter your production domain (e.g., `my-app.com`)

`localhost` is in the list by default, so dev works without changes.

## 6. Test sign-in

```bash
pnpm start
```

The starter does not install a framework-owned sign-in page. Add an app-owned page that
calls `AuthService.signIn`, then create a test account. Firebase Console → **Authentication
→ Users** should show the new user.

## How `FirebaseAuthAdapter` works

The adapter uses the **modular** `firebase/auth` API (`getAuth`, `onAuthStateChanged`, `onIdTokenChanged`, `signInWithEmailAndPassword`, …). The AngularFireAuth compat layer is forbidden in v4.

Key implementation notes:

- Construction only captures `Auth` and `DestroyRef`; provider listeners start in the
  explicit `initialize()` lifecycle hook.
- Instantiate and initialize it inside an injection context:
  `provideAppInitializer(async () => { auth.setAdapter(new FirebaseAuthAdapter()); await auth.initialize(); })`.
- Auth state is held in a `WritableSignal<AuthState>` updated by the `onAuthStateChanged` and `onIdTokenChanged` listeners.
- Listener cleanup happens on `DestroyRef.onDestroy(...)` — no manual unsubscribe needed.
- The adapter never reads `window` / `document` / `localStorage` directly; SSR-safe by construction.

The conformance suite (`@sixthsummit/ship-angular/testing`) verifies all of the above.

## Persistence

Firebase defaults to local persistence (the user stays signed in across browser restarts). To change, configure persistence on the underlying `Auth` instance — for example, before calling `setAdapter`:

```typescript
import { browserSessionPersistence, getAuth, setPersistence } from 'firebase/auth';

provideAppInitializer(async () => {
  if (!isPlatformBrowser(inject(PLATFORM_ID))) return;
  const auth = getAuth();
  await setPersistence(auth, browserSessionPersistence); // or browserLocalPersistence, inMemoryPersistence
  const authService = inject(AuthService);
  authService.setAdapter(new FirebaseAuthAdapter());
  await authService.initialize();
});
```

| Persistence                 | Description                                         |
| --------------------------- | --------------------------------------------------- |
| `browserLocalPersistence`   | Persists across tabs and browser restarts (default) |
| `browserSessionPersistence` | Persists only while the tab is open                 |
| `inMemoryPersistence`       | No persistence — only the current page load         |

## Custom redirect after sign-in

```typescript
@Component({/* … */})
export class SignInComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  async submit(form: { email: string; password: string }): Promise<void> {
    await this.auth.signIn(form.email, form.password);
    const returnUrl = this.route.snapshot.queryParams['returnUrl'] ?? '/dashboard';
    await this.router.navigateByUrl(returnUrl);
  }
}
```

`authGuard` automatically populates `?returnUrl=` when redirecting unauthenticated users to `/signin`, so you can preserve their intended destination.

## Additional auth methods

### Google sign-in

1. Enable Google in Firebase Auth
2. Use `signInWithPopup`:

```typescript
import { GoogleAuthProvider } from 'firebase/auth';

@Component({/* … */})
export class SigninComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  async signInWithGoogle(): Promise<void> {
    const provider = new GoogleAuthProvider();
    await this.auth.signInWithPopup(provider);
    await this.router.navigateByUrl('/dashboard');
  }
}
```

### Email-link (passwordless)

```typescript
// Send the link
async sendLink(email: string): Promise<void> {
  await this.auth.sendSignInLinkToEmail(email);
  // The framework stashes the email in localStorage automatically;
  // it'll be picked up by confirmSignIn().
}

// Complete sign-in on the redirected page (typically /finishSignIn)
async ngOnInit(): Promise<void> {
  const result = await this.auth.confirmSignIn(null, window.location.href);
  if (result) {
    await this.router.navigateByUrl('/dashboard');
  }
}
```

Create this finish-sign-in page inside the application's auth feature; ShipAngular does not
copy feature pages into consumers.

## Security rules

### Firestore (if using)

```text
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
    match /public/{document=**} {
      allow read: if true;
      allow write: if request.auth != null;
    }
  }
}
```

### Storage (if using)

```text
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{userId}/{allPaths=**} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

## Firebase emulator suite

Pointing the app at local emulators is recommended for offline development:

```bash
pnpm exec firebase init emulators        # one-time
pnpm exec firebase emulators:start --only auth,firestore
```

Then in your initializer:

```typescript
import { connectAuthEmulator, getAuth } from 'firebase/auth';

provideAppInitializer(async () => {
  if (!isPlatformBrowser(inject(PLATFORM_ID))) return;
  if (!environment.production) {
    connectAuthEmulator(getAuth(), 'http://localhost:9099');
  }
  const auth = inject(AuthService);
  auth.setAdapter(new FirebaseAuthAdapter());
  await auth.initialize();
});
```

## Troubleshooting

### `auth/unauthorized-domain`

Console → **Authentication → Settings → Authorized domains** → add the domain.

### `auth/invalid-api-key`

- Verify `firebase.apiKey` matches the value in Console → **Project Settings**
- Check Google Cloud Console for API key restrictions
- Confirm the right env file is being used (`environment.development.ts` for `pnpm start`, `environment.production.ts` for production builds)

### `auth/network-request-failed`

- Network connectivity
- `authDomain` matches the project
- No corporate proxy / firewall blocking `*.firebaseapp.com` or `*.googleapis.com`

### Token not being sent on API requests

The `authInterceptor` only attaches the token to:

- Relative URLs (always)
- Cross-origin URLs whose origin is in `API_ORIGINS`

If you're calling a cross-origin API:

```typescript
{ provide: API_ORIGINS, useValue: ['https://api.example.com'] as const }
```

Assert in a local test that `auth.idToken()` is non-null and the interceptor attaches it only
to an allowlisted origin. Never log the token.

### Hydration errors with Firebase

The starter skips Firebase wiring on the server. If you're seeing hydration mismatches, the
most likely culprit is a custom component reading `auth.user()` during SSR while expecting it
to be populated. On the server, `auth.state()` stays `'unknown'` — protected routes should
declare `RenderMode.Client` in `app.routes.server.ts` rather than rendering on the server.

## Best practices

- **Separate Firebase projects for dev and prod.** Easier to test sign-in flows without polluting production analytics.
- **Enable App Check** for additional client-side protection ([docs](https://firebase.google.com/docs/app-check)).
- **Enable email enumeration protection** in Authentication settings.
- **Set up alerts** for unusual sign-in activity in the Firebase Console.
- **Don't commit production keys** — see [Configuration](../getting-started/CONFIGURATION.md) for the env-var-based prod build pattern.

## Next steps

- [Authentication architecture](../architecture/AUTHENTICATION.md) — adapter contract + conformance
- [Configuration](../getting-started/CONFIGURATION.md) — env vars and `defineEnv()`
- [Library Exports](../api/LIBRARY_EXPORTS.md) — root `AuthService` and optional `/firebase-auth` adapter reference
