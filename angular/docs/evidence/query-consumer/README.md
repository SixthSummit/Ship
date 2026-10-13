# Packed Query consumer measurements

This record is preparation evidence for SNG-58. Final acceptance still requires the SNG-57 CI and security gates. The verified feature source commit is `0e938107b0a94dea8549bb78860263568d094f99`. The receipt was captured before that commit; same-commit CI remains pending. No package was published and no application was deployed.

## Setup

The measurement uses one physical `@sixthsummit/ship-angular` archive. A fresh npm consumer installs that archive and exact dependency versions. Its TypeScript program imports the public `/operations` and `/query` entrypoints without source aliases or sibling links. Vitest runs real standalone OnPush Angular applications in jsdom. The separate SNG-57 gate runs the adapter and HTTP fixture in Chromium.

Both modes use the same unchanged typed fixture and list/detail/edit workflows. The fixture contains records 1 and 2. Normal requests use a controlled 5 ms delay. The rejected edit uses 150 ms so the optimistic state can be observed. These values control test ordering; they do not measure network latency.

`measurement.json` records actual installed versions, archive SHA-256, workflow and test source hashes, commands, request counters, and zero required skips. `coverage-summary.json` records per-file coverage. The archive is an uncommitted local integration build, not a release artifact.

## Measured requests

| Action                                   |                    Baseline resources |                                          Query |
| ---------------------------------------- | ------------------------------------: | ---------------------------------------------: |
| Initial detail read from two owners      |                                     2 |                                              1 |
| Return from detail 2 to fresh detail 1   |                     1 additional read |                             0 additional reads |
| Successful edit: detail refresh          |                                     1 |                                  1 shared read |
| Successful edit: list refresh            |                        1 owner's list | 2 reads: finite list and initial infinite page |
| Successful edit: unrelated active detail |              Remains owned separately |                             0 additional reads |
| Two concurrent next-page calls           | Not provided by the baseline workflow |                      1 additional page request |

The Query initial list count is 2: one shared finite list and one shared initial infinite page. The baseline initial list count is 2 because two resources own separate finite reads. Do not interpret this total as a like-for-like pagination saving.

Query prefetch performs one read for detail 2. Selecting that detail and returning to fresh detail 1 add no requests. The active unrelated detail observer retains its prior request ID after editing detail 1. The edited detail obtains a new request ID. This proves that the declared detail refresh runs while the unrelated observer remains untouched.

## Correctness checks

- A successful edit updates both active detail owners, the finite list, and the initial infinite page.
- A declared 409 rejection restores the previous detail envelope after the optimistic update.
- Concurrent pagination returns IDs `[1, 2]` exactly once with page parameters `[null, 2]`.
- Logout and tenant replacement hide detail, list, page, and mutation data before an Angular tick.
- A transport that ignores cancellation cannot repopulate the old generation after its delayed result completes.
- Disabled baseline input produces no detail value. A rejected baseline edit causes no refresh.
- Early rejected Query edits do not invent an envelope before the first read.

These checks establish behavior for the controlled fixture. They do not establish production latency gains, backend load reductions, or customer migration readiness.

## Repeat

From the integrated repository root, run:

```sh
node conformance/query-example/run-measurement.mjs /path/to/ship-angular.tgz docs/evidence/query-consumer
```

Use the same archive that passed package conformance. The runner creates a fresh physical consumer, compiles the fixture and tests against its public declarations, runs all measurements, enforces at least 80 percent coverage in every metric for each exercised runtime fixture file, and rewrites the evidence records. It does not skip absent prerequisites. npm can fetch exact dependencies on the first run; set `SHIP_QUERY_OFFLINE=1` for a cached offline repeat.

`measurement.packed-test.ts` belongs only to this packed runner. Its distinct suffix prevents the source example test lane from accidentally using missing packed evidence inputs. Shared package scripts and CI wiring remain with the integration owner.
