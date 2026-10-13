/**
 * AuthAdapter conformance — runs the framework's adapter contract suite
 * against the in-memory MockAuthAdapter as a smoke test that the suite
 * itself works.
 *
 * Third-party adapters in their own repositories should:
 *
 * ```ts
 * import { runConformance } from '@sixthsummit/ship-angular/testing';
 * import { MyAdapter } from './my-adapter';
 *
 * runConformance(() => new MyAdapter(/* test config *‍/));
 * ```
 *
 * Provider-backed integration tests (against the Firebase emulator etc.)
 * live alongside the adapter implementation in this repo and are NOT this
 * file — this file proves the suite runs cleanly against a known-good
 * implementation.
 */
// In published consumers, import from the package's /testing entrypoint:
//   import { runConformance, MockAuthAdapter } from '@sixthsummit/ship-angular/testing';
// In-repo, the spec uses the relative path so the conformance suite is
// runnable inside the workspace before publishing.
import { MockAuthAdapter } from '../../../testing/src/mock-auth-adapter';
import { runConformance } from '../../../testing/src/run-conformance';

runConformance(() => new MockAuthAdapter());
