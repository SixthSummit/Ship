import type { OperationClient, OperationClientCall, OperationClientResult } from "./client.js";
import { createHttpOperationClient } from "./client.js";
import { type AppContract, clientContract } from "./scaling.fixture.typecheck.js";

// The synthetic manifest has 18 HTTP operations with distinct literal outputs,
// nested schemas, read/write inputs, and declared errors. Shared call types must
// retain inference without expanding every operation union at construction.
declare const client: OperationClient<AppContract>;
const sharedCall: OperationClientCall<AppContract> = client.call;
const sharedClient: Pick<OperationClient<AppContract>, "call"> = client;
void [sharedCall, sharedClient];

// Constructing a typed client must not require TypeScript to expand every
// operation's input/result union at once.
const created = createHttpOperationClient<AppContract>(clientContract, {
  baseUrl: "https://example.invalid",
});
void created;

async function verifyRouteTypes(): Promise<void> {
  const result = await created.call("records.read01", { params: { id: "record-1" } });
  if (result.ok) {
    const status: 200 = result.status;
    const variant: "01" = result.data.variant;
    const value: number = result.data.items[0]!.value;
    void [status, variant, value];
  } else if (result.status === 404) {
    const code: "NOT_FOUND" = result.error.code;
    void code;
  }

  const written = await client.call("records.write02", {
    params: { id: "record-1" },
    body: { label: "sample", revision: 2, tags: [] },
  });
  if (written.ok) {
    written.status satisfies 201;
    written.data.variant satisfies "02";
  }
  await client.call("records.write02", {
    params: { id: "record-1" },
    // @ts-expect-error the selected write operation has a distinct literal input
    body: { label: "sample", revision: 1, tags: [] },
  });

  const input = { params: { id: "record-1" } };
  await client.call("records.read01", input);

  // @ts-expect-error operation IDs remain exact
  await client.call("records.missing", {});
  // @ts-expect-error a body cannot be used in place of path parameters
  await client.call("records.read01", { body: { id: "record-1" } });
  // @ts-expect-error unknown locations are rejected on object literals
  await client.call("records.read01", { params: { id: "record-1" }, body: {} });
  const wrongLocationVariable = { params: { id: "record-1" }, body: {} };
  // @ts-expect-error unknown locations are rejected even when stored in a variable
  await client.call("records.read01", wrongLocationVariable);
  // @ts-expect-error required path parameter remains required
  await client.call("records.read01", { params: {} });
}
void verifyRouteTypes;

// Double the synthetic contract to 36 operations without duplicating its large
// generated JSON schema fixture. Each copied route retains its own input and
// result type, while the new IDs exercise the generic ID projection.
type ExpandedContract = {
  readonly operations: AppContract["operations"] & {
    readonly [TId in keyof AppContract["operations"] as `duplicate.${TId & string}`]: AppContract["operations"][TId];
  };
};
declare const expanded: OperationClient<ExpandedContract>;
const expandedCall: OperationClientCall<ExpandedContract> = expanded.call;
void expandedCall;

async function verifyExpandedTypes(): Promise<void> {
  const response = await expanded.call("duplicate.records.read01", {
    params: { id: "record-1" },
  });
  if (response.ok) response.status satisfies 200;
  // @ts-expect-error copied operations still reject wrong input locations
  await expanded.call("duplicate.records.read01", { body: { id: "record-1" } });
  // @ts-expect-error unregistered IDs remain invalid with 36 routes
  await expanded.call("duplicate.records.missing", {});
}
void verifyExpandedTypes;

// Unary result shape remains a Promise, and the framework failures are still
// represented in the result type without widening declared 404 errors.
type ReadResult = OperationClientResult<AppContract["operations"]["records.read01"]>;
declare const readResult: ReadResult;
if (!readResult.ok && readResult.status === 404) {
  readResult.error.code satisfies "NOT_FOUND";
}
