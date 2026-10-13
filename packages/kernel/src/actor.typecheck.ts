import { authenticatedAccess } from "./access.js";
import {
  defineActorResolver,
  humanActor,
  type LegacyOperationActor,
  type OperationActor,
  operationActor,
  providerActor,
  systemActor,
} from "./actor.js";

const resolver = defineActorResolver<{ readonly token: string }>({
  id: "auth.fixture",
  resolve: ({ credential, operation }) => {
    credential?.token satisfies string | undefined;
    operation.access satisfies ReturnType<typeof authenticatedAccess> | { readonly kind: string };
    return { ok: true, actor: operationActor({ id: "actor-1" }) };
  },
});

resolver.resolve({
  credential: { token: "secret" },
  operation: { id: "fixtures.read", access: authenticatedAccess() },
  requestId: "request-1",
});

resolver.resolve({
  // @ts-expect-error credential type is preserved by the resolver
  credential: { apiKey: "secret" },
  operation: { id: "fixtures.read", access: authenticatedAccess() },
  requestId: "request-1",
});

// Actor kinds are discriminated and provider actors must name their provider.
const human = operationActor({ id: "user-1" });
human.kind satisfies "human";
const system = systemActor({ id: "job-1", onBehalfOf: { actorId: "user-1" } });
system.kind satisfies "system";
const provider = providerActor({ id: "evt-1", provider: "stripe" });
provider.provider satisfies string;
// @ts-expect-error provider actors require a provider id
providerActor({ id: "evt-1" });
// @ts-expect-error human actors carry no audit attribution
humanActor({ id: "user-1", onBehalfOf: { actorId: "user-2" } });
// @ts-expect-error a provider kind without a provider id is not a valid definition
operationActor({ id: "evt-1", kind: "provider" });

function describeActor(actor: OperationActor): string {
  switch (actor.kind) {
    case "human":
      return actor.id;
    case "system":
      return actor.onBehalfOf?.actorId ?? actor.id;
    case "provider":
      return `${actor.provider}:${actor.id}`;
  }
}
void describeActor;

// A resolver built against ship-core 1.0 returns actors without `kind`; that
// still satisfies the resolver contract within 1.x.
declare const legacyActor: { readonly id: string; readonly permissions?: ReadonlySet<string> };
legacyActor satisfies LegacyOperationActor;
defineActorResolver<string>({
  id: "auth.legacy",
  resolve: () => ({ ok: true, actor: legacyActor }),
});
// A legacy actor can never claim system or provider status.
// @ts-expect-error a legacy actor has no kind
({ id: "job-1", kind: "system" }) satisfies LegacyOperationActor;
// Normalised actors always carry their kind.
// @ts-expect-error OperationActor requires kind
({ id: "user-1" }) satisfies OperationActor;

// A definition may return a ship-core 1.0 actor without `kind`; callers of
// `resolve()` still get the 1.0 contract, an `OperationActor`, which can be
// passed directly into an operation context.
const legacyResolver = defineActorResolver<string>({
  id: "auth.legacy",
  resolve: () => ({ ok: true, actor: { id: "actor-1" } satisfies LegacyOperationActor }),
});
void (async () => {
  const resolution = await legacyResolver.resolve({
    credential: "token",
    operation: { id: "fixtures.read", access: authenticatedAccess() },
    requestId: "request-1",
  });
  if (resolution.ok && resolution.actor) {
    resolution.actor satisfies OperationActor;
    resolution.actor.kind satisfies OperationActor["kind"];
  }
})();
