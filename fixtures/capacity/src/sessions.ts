import type { SessionDirectory } from "../consumer/auth.js";

/** The one publisher session and the one subscriber session the harness uses. */
export const PUBLISHER_TOKEN = "capacity-publisher";
export const SUBSCRIBER_TOKEN = "capacity-subscriber";
export const PUBLISHER_ACTOR = "publisher";
export const SUBSCRIBER_ACTOR = "subscriber";

/**
 * Harness-owned session directory bound to the golden consumer's session
 * credential adapter: the publisher may notify every enrolled tenant, the
 * subscriber only reads and subscribes to its own actor-scoped channel.
 */
export function capacitySessions(tenants: readonly string[]): SessionDirectory {
  return {
    find: (token) => {
      if (token === PUBLISHER_TOKEN) {
        return { actorId: PUBLISHER_ACTOR, role: "publisher", tenants: [...tenants] };
      }
      if (token === SUBSCRIBER_TOKEN) {
        return { actorId: SUBSCRIBER_ACTOR, role: "analyst", tenants: [] };
      }
      return undefined;
    },
  };
}
