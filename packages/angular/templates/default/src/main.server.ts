import { type BootstrapContext, bootstrapApplication } from '@angular/platform-browser';
import { AppComponent } from './app/app.component';
import { config } from './app/app.config.server';

/**
 * Server bootstrap. The `context` argument carries the server platform
 * reference threaded through by Angular's route extractor / SSR runtime —
 * without it, `bootstrapApplication` can't find a `PlatformRef` and throws
 * NG0401 (`PLATFORM_NOT_FOUND`) when running in server mode.
 *
 * Don't drop the parameter or skip passing it through.
 */
const bootstrap = (context: BootstrapContext): Promise<unknown> =>
  bootstrapApplication(AppComponent, config, context);

export default bootstrap;
