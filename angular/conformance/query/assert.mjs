/** Browser-safe assertions: every failure names the contract that was violated. */
export function check(condition, message) {
  if (!condition) throw new Error(`Query conformance: ${message}`);
}
export async function rejects(action, predicate, message) {
  try {
    await action();
  } catch (error) {
    check(predicate(error), `${message}: wrong rejection ${error?.name}`);
    return error;
  }
  throw new Error(`Query conformance: ${message}: did not reject`);
}
