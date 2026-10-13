# Tooling upgrade verification

This receipt records independent checks on 8 October 2026. It supplements the earlier Query package and example receipts. Those receipts retain the versions they actually tested. Final package acceptance still requires CI against the final commit and archive.

## Compatibility boundaries

The maintainer toolchain can use Node 24 without changing the published Angular 20 contract. The [Angular compatibility table](https://angular.dev/reference/versions) requires Node `^20.19.0 || ^22.12.0 || ^24.0.0` for Angular 20. TypeScript 5.8 is required for Angular 20.0/20.1; Angular 20.2/20.3 also accepts TypeScript 5.9. Therefore a root build with TypeScript 5.9 does not prove the oldest supported consumer can compile the emitted declarations. Keep a physical consumer check with TypeScript 5.8.3.

Package metadata checked with `npm view` gives these tool floors:

| Tool           | Version checked | Node requirement |
| -------------- | --------------- | ---------------- |
| Changesets CLI | 3.0.3           | `^22.11          |     | ^24        |     | >=26`     |
| jsdom          | 30.1.2          | `^22.22.2        |     | ^24.15.0   |     | >=26.0.0` |
| Vitest         | 5.0.3           | `^22.12.0        |     | ^24.0.0    |     | >=26.0.0` |
| Vite           | 8.3.4           | `^20.19.0        |     | >=22.12.0` |
| ESLint         | 10.12.0         | `^20.19.0        |     | ^22.13.0   |     | >=24`     |

These are tooling requirements, not new published library requirements. Consumer Node 20/22 checks must not install incompatible maintainer-only tools. Angular ESLint 20.7 accepts ESLint 8/9, so a template upgrade to ESLint 10 needs a separately verified Angular ESLint migration.

## Security regression

[GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp) and [upstream issue 56](https://github.com/kornelski/http-cache-semantics/issues/56) describe shared-cache reuse through `max-stale`. The installed, unpatched `http-cache-semantics` 4.3.0 still reproduced the behavior even though the audit did not report that version.

Three tests failed before the patch: a stored shared response with a cookie, `no-cache`, or `proxy-revalidate` became reusable through a request's `max-stale`. Each test proves the original response is storable. The separate `private` and `no-store` tests verify storage rejection; they do not claim that an application which correctly checks storage is vulnerable.

The disclosed pnpm patch guards the specific prohibitions before the stale reuse branch. It does not reject every response with a zero lifetime. All 11 tests pass on Node 24.21.0:

```sh
node --test scripts/http-cache-security.test.mjs
```

The tests resolve the package through Astro's installed dependency. Positive checks preserve bounded public stale reuse, ordinary `max-age=0`, explicit public and immutable cookie policy, private-cache cookie and proxy policy, `must-revalidate`, and ordinary `stale-if-error` behavior.

Astro's inspected remote asset code calls `storable()` and `timeToLive()`. It does not call the vulnerable reuse methods in that path. This evidence demonstrates dependency behavior and its correction, not an exploitable deployed Astro application.

The scoped Firestore gRPC override targets 1.13.6 or later, matching the fixes documented by [GHSA-m9gg-hp2v-232j](https://github.com/advisories/GHSA-m9gg-hp2v-232j) and [GHSA-f596-whhp-79r4](https://github.com/advisories/GHSA-f596-whhp-79r4). No advisory suppression is part of these checks.

## Release tooling

Changesets CLI 3.0.3 uses config 4.0.1, whose dependency uses Picomatch instead of the Micromatch-to-Braces chain. Braces 3.0.3 remains the latest published version and is affected by [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm). Upgrading the parent removes that path; it does not pretend to patch Braces.

A disposable workspace used the repository's snapshot settings, a package at 4.1.0, and one patch changeset. On Node 24.21.0, the actual CLI produced `4.1.1` for stable versioning and `4.1.1-alpha-20261008222201` for `version --snapshot alpha`. Changelog generation was disabled as in snapshot CI. The GitHub changelog hook and publishing were not exercised. No repository version, git commit, tag, or registry release was created by the probe.

## Remaining acceptance checks

Run the final clean install, archive tests, consumer compatibility checks, template checks, full security audit, and CI after all dependency changes settle. Review any new parent dependency ranges before retaining an override across a major version. Record the resulting archive hash and commit in the final CI receipt.

## Workflow review

The Changesets action 2.1.2 [published action metadata](https://github.com/changesets/action/blob/v2.1.2/action.yml) confirms Node 24 and the renamed release inputs. The workflow retains the `published` output condition. Registry authentication uses a temporary scoped npm configuration with a literal token placeholder; install steps remove it with a shell trap, and the stable release removes it in an `always()` step.

The App Engine cleanup replacement was compared against [the previous action's exact source](https://github.com/Reviewable/appengine-remove-action/blob/v2.1.2/src/main.ts). Both list and delete retain `--service default` and the selected project. Listing filters zero traffic and sorts oldest first; deletion retains the newest three eligible versions. The first draft omitted the service restriction and retained obsolete input lines; both defects were corrected before acceptance.

A fake `gcloud` executable ran the complete cleanup script extracted from the actual workflow YAML. Empty and three-version fixtures made no deletion; five versions deleted only the oldest two. Listing and deletion failures propagated. These checks made no cloud calls. The filtering assertion checks the exact `traffic_split=0` CLI argument; it does not simulate a concurrent external traffic reassignment.

## Package build review

The build uses a disposable ng-packagr input manifest so the tool can generate its own Angular Package Format export mappings. The published source manifest's `exports` and `files` fields remain unchanged. The build retains non-generated mappings and removes the staging directory in `finally`.

The first staged build emitted temporary paths in source maps. After normalization, an independent scan of all 30 generated maps found no staging paths or absolute source entries. Declaration maps now point to stable source-relative paths. Final archive tests remain required; the map scan is not a substitute for consumer compilation or runtime checks.

Root workflows passed actionlint. Template workflows passed in an isolated project root so local reusable workflow paths resolve as they do in a generated project. ShellCheck was not available for this invocation; the cleanup shell received the separate executable fake-gcloud checks described above.

A separate failure-path probe copied the actual build helper into a disposable fixture and supplied an ng-packagr stub that throws. The failure propagated, `finally` removed the staging directory, the source package manifest remained byte-for-byte unchanged, and the hand-owned `./eslint` export remained in the temporary manifest. This probe did not rebuild or modify the real package.

## Integrated validation status

The integration owner supplied passing framework coverage (1,056 tests), the separate generator lane (50 tests), and a clean Knip run. Independent review confirmed the Knip 6 configuration retains its error/warning levels and removes obsolete ignore entries instead of broadening exclusions. The audit receipt reports zero advisories at every severity; the required audit command also runs the 11 cache regressions before querying the advisory database.

The generated template remains on Angular 20 with TypeScript 5.8 and the compatible Angular ESLint 20/ESLint 9 combination. It does not add a TanStack dependency or provider to the default application. Only the private maintainer workspace raises its engine floor; the published core and generated template retain their consumer engine declarations.

The oldest-consumer fixture installs and compiles on a supported maintainer Node version because the separate private ShipContract type peer declares Node 22 or newer. Its explicit Node 20 runtime checks exercise the packed ShipAngular CLI and actual Angular SSR query/request boundary without importing that peer's runtime. A passing result must report compiler host and runtime separately; it must not claim every optional peer supports Node 20.

## Minimum consumer receipt

An independent rerun passed with installer/compiler Node 24.21.0 and runtime Node 20.20.2. The physical archive SHA-256 was `93b3bbed23c3fe36c8c30eb3c87361273ed340daf834a9cc44af6a4204320239`. All 15 public Angular entrypoints compiled against installed Angular 20.0.0 and TypeScript 5.8.3 with library checking enabled. The negative input assertion, separate request clients, actual held-operation SSR stability, unrelated request stability, and installed CLI passed. The fixture checked physical installation paths for ShipAngular, both contract packages, Angular, and TypeScript.

A disposable copy of the same fixture changed only `trackPendingTasks` to `false`. It failed the assertion that SSR stability must remain blocked while transport is held. The real fixture was unchanged. This confirms the stability test detects lost operation tracking rather than merely waiting for a timer.

## Final local review

The final Query package gate used the same archive hash as the minimum-consumer receipt above. Its recorded toolchain was Node 24.21.0, Angular 20.3.33, TanStack 5.104.1, and TypeScript 5.9.3. It passed 19 fixture tests, 10 native adapter scenarios, six real SSR stability cases, three candidate coverage tests, nine Chromium scenarios, four real HTTP checks, generated consumer types, and four workflow measurement tests. The required scenario lists contain no skips. The receipt identifies source commit `e92de8f2ef2d8f9cec416f855903b480544896fb` with uncommitted changes, so this is local evidence, not final-commit CI evidence.

The isolated public installer removes inherited npm configuration variables, writes empty fixture-owned user/global configuration files, and selects the public registry. An independent probe confirmed it preserves the executable path and offline fixture control. This changes configuration ownership rather than hiding warning output. Required generated-consumer peers were installed instead of marking them optional.

The final docs route fix uses Starlight's supported `disable404Route` option so the canonical `docs/404.md` catch-all page owns the route. The final build produced `404.html` with no warning lines. Earlier missing-content and conflicting-route warnings were both resolved. The generated mirror remains managed by the existing docs copy process.

Final source review found no remaining blocking issue. The root/template workflow checks, scoped security regression, package staging cleanup, stable source maps, minimum consumer, and final same-archive receipts are consistent. Commit and final CI remain the integration owner's responsibility.

## Hosted warning follow-up

A later hosted run exposed two additional setup issues after the local checks above: pnpm's action bootstrapped a different major before switching to the package-manager version, and the generated template's Angular build package expected Vitest 3 rather than 4. These findings reopen warning-clean acceptance until the follow-up CI run succeeds.

All 22 root and template pnpm setup steps now explicitly select 10.34.6. Independent actionlint checks pass. The template selects Vitest/coverage 3.2.7 to satisfy Angular build 20's `^3.1.1` peer. It replaces the deprecated ESLint 9 line with ESLint 10 and modular Angular ESLint 21.4 plugins/parser, whose published peer ranges support ESLint 10 without requiring an Angular runtime or CLI major change. The Angular CLI lint builder is removed; `pnpm lint` and `pnpm lint:fix` retain the exact prior TypeScript/HTML source patterns, framework rules, and import checks. The template's Angular runtime remains on version 20.

These follow-up source changes passed independent review. Fresh scaffold execution, negative framework-rule checks, and hosted warning output must still pass before the warning-clean goal is accepted.

The subsequent fresh scaffold passed types, lint, two tests, and production build. Negative fixtures still triggered the framework's OnPush, injection, and public RxJS lint rules. A deprecated transitive glob dependency required the narrow `@vitest/coverage-v8>test-exclude` 8 override. Versions 7.0.2 and 8.0.0 have identical filter implementation files; their updated glob dependencies retain Node 20 support.

Independent checks compared both versions across ten paths, include/exclude patterns, negated reinclusion, and synchronous/asynchronous glob results. Results matched. The actual scaffold coverage run mapped 13 TypeScript source files, excluded test/setup/environment files, and kept statement locations within the original sources. The exercised app component had every statement covered. A separate run with 100% thresholds failed all four metrics as expected (9.41% statements/lines and 30% branches/functions), proving that the override does not bypass thresholds. No permanent threshold or exclusion was relaxed. Final hosted warning-clean acceptance still depends on the next CI run.

The generated-app audit then rejected the Vitest 3 dependency tree. Its Tinypool dependency had two critical prototype-pollution advisories, including the separate `run()` options issue fixed only in 2.1.2 or later. A benign independent Node 20 probe confirmed that Tinypool 2.2.0 ignores inherited `execArgv`, `env`, and per-run `filename` options while the legitimate worker still returns its result. The same probes fail against 1.1.1. However, upgrading Tinypool alone does not make Vitest 3 acceptable: advisories in Vitest itself require returning to the patched Vitest 4 line. The preceding Vitest 3 compatibility experiments are historical evidence, not approval of that dependency tree.

The generated scaffold now has separate required CI steps for its own audit, lint, and test coverage. These run after its install and fail independently before the existing type/build/browser checks. Root workspace audit results must not be described as generated-app audit results. Warning-clean acceptance remains open during this remediation.

## Accepted scaffold follow-up

The accepted solution restores exact Vitest/coverage 4.1.11 and pins Angular build 20.3.39. The template's pnpm override is restricted to `@angular/build@20.3.39>vitest`. Unlike the discarded package extension, it updates the actual resolved peer metadata. Independent inspection confirmed that lockfile range and a strict-peer install succeeded. This is a disclosed compatibility correction for the tested Angular application/SSR builder plus separate Analog tests; it is not a claim that Angular's experimental native unit-test builder supports Vitest 4. An existing framework test now rejects configuring that builder in the template.

The test TypeScript program includes all source TypeScript, following [Analog's coverage guidance](https://analogjs.org/docs/features/testing/vitest). This expands compiler input rather than excluding untested sources. Vite dependency scanning remains enabled, with entries limited to the actual source test files so a prior SSR build's generated HTML is not scanned.

The owner verified a fresh strict-peer install, zero advisories at every severity, types, lint, two tests, coverage, and production build. An independent repeat coverage run with the SSR build still present passed both tests with no warning or dependency-scan errors. The executable coverage probe confirmed mapped TypeScript, executed statements, an uncovered branch, preserved exclusions, and a failing strict threshold. Vitest 4's untouched scaffold baseline is 4.7% statements, 0% branches/functions, and 4% lines; the earlier Vitest 3 coverage values are not comparable acceptance numbers. No threshold was reduced to obtain a pass.

Independent source/configuration review accepts this scaffold follow-up. The next hosted CI run must still confirm the final committed dependency tree and warning output.

A subsequent hosted run showed that the pnpm action still bootstrapped another major before switching versions; its alternative action release also emitted a bundled dependency deprecation. The final workflow setup installs only `pnpm@10.34.6` into `$RUNNER_TEMP/ship-pnpm` with npm, then appends that local binary directory to `GITHUB_PATH`. It does not modify HOME, a global installation, or PNPM_HOME. Independent execution of the installed launcher returned 10.34.6 under Node 20, 22, and 24 without warnings. Required root and generated-app audits remain enabled.

The generated workflow test permits only that exact package-manager bootstrap command and still rejects npm/npx application installs, scripts, and audits. The independent seeded review found and corrected a gap for direct `npx vitest`. The shared validator now rejects any npx binary invocation; its actual seeded tests reject npx, npm application commands, and a changed bootstrap version while accepting the exact approved bootstrap. All 41 colocated tests pass. The application build's ignored `prerender` setting was also removed: Angular's implementation overwrites it when `outputMode` is set. The actual SSR build still prerenders one route through the existing server route configuration, without the ignored-option warning. Final source review accepts both narrow changes; final hosted CI is still required.
