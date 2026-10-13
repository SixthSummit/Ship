import { type ApplicationConfig, mergeApplicationConfig } from '@angular/core';
import { provideServerRendering, withRoutes } from '@angular/ssr';
import { appConfig } from './app.config';
import { serverRoutes } from './app.routes.server';

/**
 * Server-only application configuration.
 *
 * Merges the browser `appConfig` with `provideServerRendering` so the
 * runtime knows it's executing in Node. The `serverRoutes` table declares
 * `RenderMode` per route — landing/marketing prerender; auth-protected
 * routes render client-side only.
 */
const serverConfig: ApplicationConfig = {
  providers: [provideServerRendering(withRoutes(serverRoutes))],
};

export const config = mergeApplicationConfig(appConfig, serverConfig);
