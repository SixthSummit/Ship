import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * Welcome page component
 *
 * This is a simple starting page that guides users on next steps.
 * Replace this with your own landing page or generate an app-owned feature:
 *
 *   ng generate @sixthsummit/ship-angular:module landing
 */
@Component({
  selector: 'app-welcome',
  standalone: true,
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="min-h-screen flex items-center justify-center p-8">
      <div class="glass-strong max-w-2xl w-full p-12 text-center">
        <h1 class="text-4xl font-bold mb-4 text-gray-800">🚀 Welcome to ShipAngular</h1>
        <p class="text-lg text-gray-600 mb-8">
          Your project is ready! Here's what you can do next:
        </p>

        <div class="grid gap-4 text-left mb-8">
          <div class="p-4 bg-white/50 rounded-lg">
            <h3 class="font-semibold text-gray-800">1. Generate an app feature</h3>
            <code class="text-sm text-primary-600"
              >ng generate @sixthsummit/ship-angular:module account</code
            >
            <p class="text-sm text-gray-500 mt-1">
              Creates app-owned routes, pages, and ownership docs
            </p>
          </div>

          <div class="p-4 bg-white/50 rounded-lg">
            <h3 class="font-semibold text-gray-800">2. Connect typed operations</h3>
            <code class="text-sm text-primary-600"
              >import &#123; createOperationResource &#125; from
              '@sixthsummit/ship-angular/operations'</code
            >
          </div>

          <div class="p-4 bg-white/50 rounded-lg">
            <h3 class="font-semibold text-gray-800">3. Configure Firebase</h3>
            <p class="text-sm text-gray-500">
              Update your environment files with Firebase credentials
            </p>
          </div>
        </div>

        <p class="text-sm text-gray-500">
          Reusable behavior is compiled; application UI stays in this repository.
        </p>
      </div>
    </div>
  `,
  styles: [],
})
export class WelcomeComponent {}
