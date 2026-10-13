/** Type-level CI contract for module/provider composition. */
import { z } from "zod";
import { publicAccess } from "./access.js";
import { dependency } from "./dependency.js";
import { defineModule } from "./module.js";
import { defineOperation } from "./operation.js";
import { defineProvider } from "./provider.js";

interface Clock {
  now(): Date;
}

interface HealthService {
  read(): { status: "ok"; at: string };
}

const clockToken = dependency<Clock>("platform.clock");
const healthToken = dependency<HealthService>("health.service");

const provider = defineProvider({
  token: healthToken,
  dependencies: { clock: clockToken },
  lifetime: "operation",
  create: ({ services }) => ({
    read: () => ({ status: "ok" as const, at: services.clock.now().toISOString() }),
  }),
});

const operation = defineOperation({
  id: "health.read",
  input: {},
  output: { 200: z.object({ status: z.literal("ok"), at: z.string() }) },
  successStatus: 200,
  errors: [],
  access: publicAccess(),
  transaction: "none",
  dependencies: { health: healthToken },
  handler: ({ services }) => services.health.read(),
});

const module = defineModule({
  id: "health",
  operations: [operation],
  providers: [provider],
  imports: ["platform"],
  exports: [healthToken],
});

type Assert<TValue extends true> = TValue;
type Equal<TLeft, TRight> =
  (<T>() => T extends TLeft ? 1 : 2) extends <T>() => T extends TRight ? 1 : 2 ? true : false;

type _moduleIdIsLiteral = Assert<Equal<typeof module.id, "health">>;
type _operationIdSurvives = Assert<Equal<(typeof module.operations)[0]["id"], "health.read">>;
type _importIsLiteral = Assert<Equal<(typeof module.imports)[number], "platform">>;
type _exportKeepsValueType = Assert<Equal<(typeof module.exports)[0], typeof healthToken>>;
