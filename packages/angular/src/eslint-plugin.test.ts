import { type ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import shipAngular from '../eslint/index.js';

const plugin = shipAngular as unknown as ESLint.Plugin;

function verify(source: string, rule: string, filename = 'src/example.ts'): Linter.LintMessage[] {
  const linter = new Linter();
  return linter.verify(
    source,
    {
      files: ['**/*.ts'],
      languageOptions: {
        parser: tseslint.parser,
        parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
      },
      plugins: { 'ship-angular': plugin },
      rules: { [`ship-angular/${rule}`]: 'error' },
    },
    { filename }
  );
}

describe('packaged ShipAngular ESLint rules', () => {
  it('checks the conventional lowercase application routes export', () => {
    const messages = verify(
      "export const routes: Routes = [{ path: 'account', loadComponent: loadAccount }];",
      'route-guard-or-public',
      'src/app/app.routes.ts'
    );

    expect(messages.map(message => message.ruleId)).toContain('ship-angular/route-guard-or-public');
  });

  it('accepts explicitly public and guarded routes', () => {
    const messages = verify(
      `export const routes: Routes = [
        { path: '', data: { public: true }, loadComponent: loadHome },
        { path: 'account', canActivate: [authGuard], loadComponent: loadAccount },
      ];`,
      'route-guard-or-public',
      'src/app/app.routes.ts'
    );

    expect(messages).toEqual([]);
  });

  it('ignores Angular SSR render-mode declarations', () => {
    const messages = verify(
      `import type { ServerRoute } from '@angular/ssr';
       const serverRoutes: ServerRoute[] = [
         { path: '', renderMode: 'prerender' },
         { path: '**', renderMode: 'server' },
       ];`,
      'route-guard-or-public',
      'src/app/app.routes.server.ts'
    );

    expect(messages).toEqual([]);
  });

  it('requires OnPush on components', () => {
    const messages = verify(
      "@Component({ selector: 'app-example', template: '' }) export class ExampleComponent {}",
      'onpush-required'
    );

    expect(messages.map(message => message.ruleId)).toContain('ship-angular/onpush-required');
  });

  it('rejects constructor dependency injection', () => {
    const messages = verify(
      'export class ExampleService { constructor(private auth: AuthService) {} }',
      'use-inject'
    );

    expect(messages.map(message => message.ruleId)).toContain('ship-angular/use-inject');
  });

  it('rejects observable returns from a public API file', () => {
    const messages = verify(
      'export function users(): Observable<User[]> { throw new Error(); }',
      'no-rxjs-in-public-api',
      'src/public-api.ts'
    );

    expect(messages.map(message => message.ruleId)).toContain('ship-angular/no-rxjs-in-public-api');
  });
});
