// ShipAngular ESLint plugin — custom rules enforcing 4.0 framework conventions.
//
// Usage in eslint.config.js:
//   import shipAngular from './packages/core/eslint/index.js';
//   export default [
//     {
//       files: ['**/*.ts'],
//       plugins: { 'ship-angular': shipAngular },
//       rules: {
//         'ship-angular/use-inject': 'error',
//         'ship-angular/onpush-required': 'error',
//         'ship-angular/route-guard-or-public': 'warn',
//         'ship-angular/no-rxjs-in-public-api': 'error',
//       },
//     },
//   ];

import noRxjsInPublicApi from './rules/no-rxjs-in-public-api.js';
import onpushRequired from './rules/onpush-required.js';
import routeGuardOrPublic from './rules/route-guard-or-public.js';
import useInject from './rules/use-inject.js';

export default {
  meta: {
    name: '@sixthsummit/eslint-plugin-ship-angular',
  },
  rules: {
    'use-inject': useInject,
    'onpush-required': onpushRequired,
    'route-guard-or-public': routeGuardOrPublic,
    'no-rxjs-in-public-api': noRxjsInPublicApi,
  },
};
