import { IMAGE_CONFIG, isPlatformBrowser } from '@angular/common';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import {
  type ApplicationConfig,
  inject,
  PLATFORM_ID,
  provideAppInitializer,
  provideZonelessChangeDetection,
} from '@angular/core';
import { initializeApp, provideFirebaseApp } from '@angular/fire/app';
import { getAuth, provideAuth } from '@angular/fire/auth';
import {
  provideClientHydration,
  withEventReplay,
  withIncrementalHydration,
} from '@angular/platform-browser';
import {
  provideRouter,
  withComponentInputBinding,
  withInMemoryScrolling,
  withViewTransitions,
} from '@angular/router';

import { API_ORIGINS, AuthService, authInterceptor, Logger } from '@sixthsummit/ship-angular';
import { FirebaseAuthAdapter } from '@sixthsummit/ship-angular/firebase-auth';
import { environment } from '../environments/environment';
import { routes } from './app.routes';

/**
 * True when the env has a real Firebase apiKey (not a placeholder).
 *
 * Bare generated scaffolds resolve the template placeholder to an empty
 * key. We skip Firebase wiring entirely until the user fills in real config — keeps the bare
 * welcome page from breaking SSR / prerender, and the framework's
 * AuthService stays in the `unknown` state until an adapter is set.
 */
function hasFirebaseConfig(cfg: { apiKey?: string }): boolean {
  return !!cfg?.apiKey && !cfg.apiKey.startsWith('{{');
}

export const appConfig: ApplicationConfig = {
  providers: [
    // Zoneless change detection. zone.js is no longer in the bundle; every
    // component must be OnPush + signal-driven (enforced by the framework's
    // ESLint custom rules). See AGENTS.md for the conventions.
    provideZonelessChangeDetection(),

    // Routing — input binding + view transitions for modern UX.
    provideRouter(
      routes,
      withComponentInputBinding(),
      withViewTransitions(),
      withInMemoryScrolling({
        scrollPositionRestoration: 'enabled',
        anchorScrolling: 'enabled',
      })
    ),

    // HTTP — auth interceptor attaches the bearer token reactively.
    provideHttpClient(withFetch(), withInterceptors([authInterceptor])),

    // SSR hydration. withEventReplay buffers user clicks during hydration so
    // they aren't lost; withIncrementalHydration supports app-owned @defer
    // blocks without putting library components in charge of their triggers.
    provideClientHydration(withEventReplay(), withIncrementalHydration()),

    // Firebase. Skipped automatically when the env has empty/template
    // values (e.g. on a bare scaffold) — keeps SSR / prerender working
    // before the user fills in their Firebase config.
    ...(hasFirebaseConfig(environment.firebase)
      ? [
          provideFirebaseApp(() => initializeApp(environment.firebase)),
          provideAuth(() => getAuth()),
        ]
      : []),

    // Auth adapter wiring.
    //
    // - On the server: skip adapter wiring entirely. The auth state stays
    //   `'unknown'`; protected routes are marked RenderMode.Client in
    //   app.routes.server.ts so this never blocks SSR.
    // - In the browser dev mode with `VITE_MSW=true`: dynamic-import
    //   `MockAuthAdapter` so dev/e2e run without Firebase.
    // - In the browser otherwise: wire `FirebaseAuthAdapter`. It calls
    //   `inject(Auth)` and `inject(DestroyRef)` in its constructor, which
    //   work because `provideAppInitializer` runs in an injection context.
    provideAppInitializer(async () => {
      Logger.setProduction(environment.production);
      if (!isPlatformBrowser(inject(PLATFORM_ID))) return;
      const auth = inject(AuthService);
      if (import.meta.env['VITE_MSW'] === 'true') {
        const { MockAuthAdapter } = await import('@sixthsummit/ship-angular/testing');
        auth.setAdapter(new MockAuthAdapter({ initialStatus: 'unauthenticated' }));
        await auth.initialize();
      } else if (hasFirebaseConfig(environment.firebase)) {
        auth.setAdapter(new FirebaseAuthAdapter());
        await auth.initialize();
      }
      // No adapter when neither MSW nor real Firebase config is wired —
      // the auth state stays 'unknown'. Components that read auth.state()
      // should handle the loading branch gracefully.
    }),

    // Configure cross-origin API allowlist for the auth interceptor.
    // Relative-URL requests always receive the token; absolute URLs only
    // receive it when their origin is listed here.
    {
      provide: API_ORIGINS,
      useValue: [
        // Add cross-origin API hosts here, e.g.:
        // 'https://api.example.com',
      ] as const,
    },

    // Image configuration
    {
      provide: IMAGE_CONFIG,
      useValue: {
        disableImageSizeWarning: true,
        disableImageLazyLoadWarning: true,
      },
    },
  ],
};
