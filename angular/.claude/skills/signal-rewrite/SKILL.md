---
name: signal-rewrite
description: Use when the user asks to "convert this service to signals", "migrate from BehaviorSubject", "rewrite as signal-based", "replace user$ with signal", or any request that maps to converting an RxJS-based reactive surface to Angular 20 signals. Triggers heavily during Phase 1a of the ShipAngular 4.0 plan. The skill walks through the mechanical and conceptual moves and surfaces the gotchas (effects, takeUntilDestroyed, runInInjectionContext, SSR-safety).
---

# Signal rewrite — convert RxJS-based service to signal-based

This skill is the playbook for migrating a `BehaviorSubject` / `Observable`-based service to a signal-based one, following the conventions in `AGENTS.md` (`#2 Signal-first public API`).

## When to use this skill

- The user wants to convert a service exposing `someState$: Observable<T>` to one exposing `someState: Signal<T>`.
- The user is rewriting a service flagged by the `ship-angular/no-rxjs-in-public-api` ESLint rule.
- The user is doing a Phase 1a migration of `AuthService`, `ApiClient`, or any module-level service.

## When NOT to use this skill

- The user wants a _brand-new_ signal-based service. Just write it directly; this skill is for migration.
- The user wants to keep RxJS internally but expose a signal at the boundary. That's fine — see the `toSignal` section below.
- The service uses RxJS for one-shot operations (request/response, navigation) where signals don't add value. Don't migrate just to migrate.

## The mechanical conversion

### Pattern 1: `BehaviorSubject<T>` → `signal<T>`

**Before:**

```ts
private userSubject = new BehaviorSubject<User | null>(null);
public user$: Observable<User | null> = this.userSubject.asObservable();

setUser(user: User | null) {
  this.userSubject.next(user);
}

get user(): User | null {
  return this.userSubject.value;
}
```

**After:**

```ts
private userSignal: WritableSignal<User | null> = signal(null);
public user: Signal<User | null> = this.userSignal.asReadonly();

setUser(user: User | null) {
  this.userSignal.set(user);
}

// `user()` IS the getter; remove the redundant `get user()` accessor.
```

### Pattern 2: derived state via `combineLatest` / `map` → `computed`

**Before:**

```ts
public isAuthenticated$ = this.user$.pipe(map(u => u !== null));
```

**After:**

```ts
public isAuthenticated: Signal<boolean> = computed(() => this.user() !== null);
```

### Pattern 3: side effects via `subscribe` → `effect`

**Before:**

```ts
this.user$.subscribe(user => {
  if (user) this.apiClient.idToken = user.token;
  else this.apiClient.clearIdToken();
});
```

**After (inside an injection context, e.g., constructor or `inject()`-using factory):**

```ts
effect(() => {
  const user = this.user();
  if (user) this.apiClient.idToken = user.token;
  else this.apiClient.clearIdToken();
});
```

If the effect needs to run _outside_ an injection context, wrap in `runInInjectionContext(this.injector, () => effect(...))`.

### Pattern 4: external listeners (e.g., Firebase `onAuthStateChanged`) → writable signal

**Before:**

```ts
this.adapter.onAuthStateChanged(user => this.userSubject.next(user));
```

**After:**

```ts
const unsubscribe = this.adapter.onAuthStateChanged(user => this.userSignal.set(user));
inject(DestroyRef).onDestroy(() => unsubscribe());
// Don't go through `toSignal` here — the listener model doesn't need RxJS as an intermediate.
```

### Pattern 5: `firstValueFrom(obs$)` → `await Promise<T>`

If a method returns `Promise<T>` from an internal Observable, the migration is mechanical: replace the internal Observable with a Promise-returning function. Often this means dropping RxJS entirely from the implementation.

If you can't drop RxJS internally (e.g., the source is a third-party Observable), keep RxJS internal but expose a signal via `toSignal`:

```ts
import { toSignal } from '@angular/core/rxjs-interop';

private internalObs$ = thirdParty.someObservable$;
public state: Signal<T | undefined> = toSignal(this.internalObs$);
```

## Gotchas

1. **`takeUntilDestroyed()`** — any internal subscription must be cleaned up. Use `takeUntilDestroyed()` (in injection context) or hold the subscription and call `unsubscribe` in `ngOnDestroy` / `DestroyRef.onDestroy`.
2. **`effect` runs outside zone in zoneless mode (Phase 1b on).** Don't trigger side effects that depend on Zone.js patching (most don't, but be aware).
3. **`computed` is memoized.** If the computation is expensive, that's fine. If it has side effects, _don't use `computed`_ — use `effect`.
4. **SSR safety:** any signal-based code that reads `window` / `localStorage` / `document` must guard with `isPlatformBrowser(inject(PLATFORM_ID))`. Don't bypass.
5. **Don't `signal()` a derived value.** If `b` is derived from `a`, write `b = computed(() => transform(a()))`, not `b = signal(transform(a()))`.
6. **Don't expose `WritableSignal<T>` publicly.** Use `.asReadonly()` or expose the type as `Signal<T>`. Public mutability breaks the framework's contract.

## Validation

After conversion, verify:

- [ ] No `BehaviorSubject`, `Subject`, `ReplaySubject`, or `Observable` in the public exports of the service.
- [ ] `pnpm lint` passes (`ship-angular/no-rxjs-in-public-api` rule should be silent).
- [ ] All callers that used `service.someState$.subscribe(...)` now use `service.someState()` directly in templates or `effect(() => service.someState())` in code.
- [ ] All callers that used `service.someState$ | async` in templates now use `{{ service.someState() }}`.
- [ ] Vitest tests still pass; no test relies on `Observable` ordering semantics that don't hold for signals.
- [ ] If the service had an `onAuthStateChanged`-style listener, cleanup is wired (`unsubscribe` called in `DestroyRef.onDestroy` or via `takeUntilDestroyed`).

## When in doubt

Read the migrated `AuthService` (Phase 1a) at `../packages/angular/src/auth/services/AuthService.ts` for the canonical example. The shape there is the framework's reference for every other migration.
