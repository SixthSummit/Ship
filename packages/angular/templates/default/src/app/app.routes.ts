import { type Routes } from '@angular/router';

/**
 * Application routes
 *
 * This is a minimal starting point. Add routes here or generate an app-owned
 * feature and its lazy route:
 *
 *   ng generate @sixthsummit/ship-angular:module account --guarded
 */
export const routes: Routes = [
  {
    path: '',
    data: { public: true },
    loadComponent: () => import('./pages/welcome/welcome.component').then(m => m.WelcomeComponent),
  },
  {
    path: '**',
    data: { public: true },
    redirectTo: '',
    pathMatch: 'full',
  },
];
