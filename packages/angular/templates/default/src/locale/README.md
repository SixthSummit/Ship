# i18n — internationalization

ShipAngular templates ship with [`@angular/localize`](https://angular.dev/guide/i18n) wired in. The polyfill is registered via `angular.json#polyfills`, the dependency is in `package.json`, and an `extract-i18n` script is available.

## Workflow

```bash
# 1. Mark template content with the `i18n` attribute or `$localize` tagged template literal.
# 2. Extract source messages to messages.xlf:
pnpm i18n:extract

# 3. Translate messages.xlf into messages.<locale>.xlf for each target locale.
# 4. Configure `i18n.locales` in angular.json with the target locale paths.
# 5. Build per-locale: ng build --localize
```

## Example marker

Inline in a template:

```html
<h1 i18n="@@home.headline">Ship faster</h1>
```

In code:

```ts
const greeting = $localize`:@@home.greeting:Hello, ${name}`;
```

## Scope

This file lives here as a placeholder so the locale directory ships with the template. Replace it with the generated `messages.xlf` after running `pnpm i18n:extract`.

## Alternative: runtime translation

If you'd rather translate at runtime than build-time, swap `@angular/localize` for [`transloco`](https://jsverse.github.io/transloco/). Transloco loads JSON message bundles per-locale at runtime — no rebuild required to switch languages. The framework doesn't take a position; pick what fits your app.
