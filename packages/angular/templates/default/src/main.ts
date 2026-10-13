import { bootstrapApplication } from '@angular/platform-browser';
import { AppComponent } from './app/app.component';
import { appConfig } from './app/app.config';

async function start(): Promise<void> {
  // Opt-in MSW via VITE_MSW=true in .env.development. Skipped in production
  // builds entirely (the dynamic import is tree-shaken when the env flag is
  // statically false).
  if (import.meta.env['VITE_MSW'] === 'true') {
    const { worker } = await import('./mocks/browser');
    await worker.start({ onUnhandledRequest: 'bypass' });
  }
  await bootstrapApplication(AppComponent, appConfig);
}

start().catch(err => console.error(err));
