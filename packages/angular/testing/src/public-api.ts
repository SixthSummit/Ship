/**
 * @sixthsummit/ship-angular/testing
 *
 * Test utilities for ShipAngular framework — primarily the AuthAdapter
 * conformance suite that every adapter (built-in or third-party) must pass.
 *
 * @example
 * ```ts
 * import { runConformance } from '@sixthsummit/ship-angular/testing';
 * import { MyAuthAdapter } from './my-auth-adapter';
 *
 * runConformance(() => new MyAuthAdapter(/* test config *‍/));
 * ```
 */

export { MockAuthAdapter, type MockAuthAdapterOptions } from './mock-auth-adapter';
export { type ConformanceContext, runConformance } from './run-conformance';
export {
  assertOperationClientConformance,
  type OperationClientConformanceConfig,
  type OperationClientConformanceReport,
} from './run-operation-client-conformance';
